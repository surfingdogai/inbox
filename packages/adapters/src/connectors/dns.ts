import type { ConnectorHttp } from "@surfingdog/core";

/**
 * DNS for finding a calendar server from an email address (RFC 6764): SRV and TXT records, and MX
 * records to tell a Google or Microsoft mailbox (which no app password opens), asked of a public
 * DNS-over-HTTPS resolver. A Worker has no resolver of its own and the shared packages use
 * web APIs only, so both runtimes ask the same way. What is sent is the name looked up
 * (`_caldavs._tcp.example.com`), nothing about the owner.
 */

const RESOLVER = "https://cloudflare-dns.com/dns-query";

export interface SrvRecord {
  readonly priority: number;
  readonly weight: number;
  readonly port: number;
  readonly target: string;
}

interface DnsJson {
  readonly Status?: number;
  readonly Answer?: readonly { readonly type?: number; readonly data?: string }[];
}

async function ask(http: ConnectorHttp, name: string, type: "SRV" | "TXT" | "MX"): Promise<string[]> {
  try {
    const res = await http.request({
      method: "GET",
      url: `${RESOLVER}?name=${encodeURIComponent(name)}&type=${type}`,
      headers: { accept: "application/dns-json" },
      maxBytes: 64 * 1024,
      timeoutMs: 5_000,
    });
    if (res.status !== 200) return [];
    const json = JSON.parse(res.text) as DnsJson;
    if (json.Status !== 0) return [];
    const code = type === "SRV" ? 33 : type === "MX" ? 15 : 16;
    return (json.Answer ?? []).filter((a) => a.type === code && typeof a.data === "string").map((a) => String(a.data));
  } catch {
    // No answer is an answer here: discovery tries the next way.
    return [];
  }
}

/** SRV records for a name, best first; a target of "." (the service is not offered) is left out. */
export async function lookupSrv(http: ConnectorHttp, name: string): Promise<SrvRecord[]> {
  const out: SrvRecord[] = [];
  for (const data of await ask(http, name, "SRV")) {
    const [priority, weight, port, target] = data.trim().split(/\s+/);
    const host = (target ?? "").replace(/\.$/, "");
    const p = Number(port);
    if (!host || host === "." || !Number.isInteger(p) || p <= 0 || p > 65_535) continue;
    out.push({ priority: Number(priority) || 0, weight: Number(weight) || 0, port: p, target: host.toLowerCase() });
  }
  return out.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
}

/** The `path=` a TXT record beside an SRV record names (RFC 6764 §4), if any. */
export async function lookupPath(http: ConnectorHttp, name: string): Promise<string | null> {
  for (const data of await ask(http, name, "TXT")) {
    const text = data.replace(/^"|"$/g, "").replace(/"\s*"/g, "");
    const m = /(?:^|\s)path=(\S+)/.exec(text);
    if (m?.[1]?.startsWith("/")) return m[1];
  }
  return null;
}

/** The mail servers a domain names (MX), lower case, without the trailing dot. */
export async function lookupMx(http: ConnectorHttp, domain: string): Promise<string[]> {
  const out: string[] = [];
  for (const data of await ask(http, domain, "MX")) {
    const host = (data.trim().split(/\s+/)[1] ?? "").replace(/\.$/, "").toLowerCase();
    if (host) out.push(host);
  }
  return out;
}

/**
 * Whether a mail domain takes mail at all (ADR-029 §5.2, `no_mail`): it names a mail server (MX), or
 * has an address (A) a server may deliver to. False only when the resolver answered and neither is
 * there (the name does not exist, or holds neither); null when it could not say. Only the domain is
 * asked about, never an address.
 */
export async function takesMail(http: ConnectorHttp, domain: string): Promise<boolean | null> {
  const asked = async (type: "MX" | "A"): Promise<{ status: number; answers: number } | null> => {
    try {
      const res = await http.request({
        method: "GET",
        url: `${RESOLVER}?name=${encodeURIComponent(domain)}&type=${type}`,
        headers: { accept: "application/dns-json" },
        maxBytes: 64 * 1024,
        timeoutMs: 3_000,
      });
      if (res.status !== 200) return null;
      const json = JSON.parse(res.text) as DnsJson;
      const code = type === "MX" ? 15 : 1;
      return { status: json.Status ?? -1, answers: (json.Answer ?? []).filter((a) => a.type === code).length };
    } catch {
      return null;
    }
  };
  const mx = await asked("MX");
  if (mx === null) return null;
  if (mx.answers > 0) return true;
  // NXDOMAIN: there is no such name, so nothing there takes mail.
  if (mx.status === 3) return false;
  if (mx.status !== 0) return null;
  const a = await asked("A");
  if (a === null || (a.status !== 0 && a.status !== 3)) return null;
  return a.answers > 0;
}
