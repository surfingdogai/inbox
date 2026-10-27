/**
 * What the email gateway decides, apart from the Worker that runs it, so it can be tested on both
 * runtimes: where an address goes, what the receiving server found about the sender, and how a
 * delivery to the hosted router is signed (the same scheme the router checks, `packages/hosted/src/sign.ts`).
 */

/** A hosted inbox's slug: two words and four characters (`misty-stork-z4if`), as the runtime names them. */
export const SLUG = /^[a-z]+-[a-z]+-[a-z2-7]{4}$/;

export type Route =
  | { readonly kind: "own" }
  | { readonly kind: "hosted"; readonly slug: string }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * Where mail for `to` goes: to a hosted inbox when the address is on the hosted inbound domain
 * (`<slug>@surfingdog.email`, or a conversation's `<slug>+<token>@…`), refused when it is on that
 * domain but names no inbox; to our own inbox otherwise (the addresses routed to this Worker for it).
 */
export function routeFor(to: string, hostedDomain: string | undefined): Route {
  const address = to.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0) return { kind: "refuse", reason: "no such address" };
  const domain = address.slice(at + 1);
  if (!hostedDomain || domain !== hostedDomain.trim().toLowerCase()) return { kind: "own" };
  const slug = address.slice(0, at).split("+")[0] ?? "";
  // Every mail domain takes mail for its postmaster (RFC 5321 §4.5.1), and abuse reports: ours.
  if (slug === "postmaster" || slug === "abuse") return { kind: "own" };
  return SLUG.test(slug) ? { kind: "hosted", slug } : { kind: "refuse", reason: "no such address" };
}

/**
 * The header fields of a raw message, in the order they come (topmost first), each unfolded onto one
 * line. Only the header block is read (up to the first empty line, at most 256 KiB of it).
 */
export function headerFields(raw: Uint8Array): [string, string][] {
  const limit = Math.min(raw.byteLength, 256 * 1024);
  let end = limit;
  for (let i = 0; i + 3 < limit; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
      end = i;
      break;
    }
    if (raw[i] === 10 && raw[i + 1] === 10) {
      end = i;
      break;
    }
  }
  const text = new TextDecoder("latin1").decode(raw.subarray(0, end));
  const out: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) {
      const last = out[out.length - 1] as [string, string];
      last[1] = `${last[1]} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    out.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return out;
}

/**
 * What the receiving server found, from its own Authentication-Results (RFC 8601), as
 * `spf=…; dkim=pass:d1,d2; dmarc=…` for the inbox (`X-Inbox-Email-Auth`). Read from the message's
 * header fields in the order they came (`headerFields`), never from a Headers object (which sorts
 * fields and joins two of a name into one): only the topmost Authentication-Results, which the
 * receiving server adds last, and only when its authserv-id is `trusted`. None when the topmost is
 * someone else's, when another field below claims a trusted id (one of them is the sender's own), and
 * ARC's results are never read. Undefined when nothing can be said.
 */
export function authSummary(fields: Iterable<[string, string]>, trusted: readonly string[]): string | undefined {
  const ids = trusted.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (ids.length === 0) return undefined;
  const results: string[] = [];
  for (const [name, raw] of fields) if (name.toLowerCase() === "authentication-results") results.push(raw);
  const authserv = (raw: string) =>
    raw
      .replace(/\([^)]*\)/g, " ")
      .split(";")[0]
      ?.trim()
      .split(/\s+/)[0]
      ?.toLowerCase() ?? "";
  const [top, ...below] = results;
  if (top === undefined || !ids.includes(authserv(top))) return undefined;
  if (below.some((f) => ids.includes(authserv(f)))) return undefined;
  const parts = top
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  parts.shift();
  let spf: string | undefined;
  let dmarc: string | undefined;
  const dkim: string[] = [];
  let dkimSeen = false;
  for (const p of parts) {
    const [method, rest] = [p.split("=")[0]?.trim().toLowerCase(), p.slice(p.indexOf("=") + 1)];
    const verdict = rest.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (method === "spf") spf ??= verdict;
    if (method === "dmarc") dmarc ??= verdict;
    if (method === "dkim") {
      dkimSeen = true;
      const d = /header\.d=([a-z0-9.-]+)/i.exec(rest)?.[1]?.toLowerCase();
      if (verdict === "pass" && d && !dkim.includes(d)) dkim.push(d);
    }
  }
  const out = [
    ...(spf && /^[a-z]+$/.test(spf) ? [`spf=${spf}`] : []),
    ...(dkimSeen ? [dkim.length ? `dkim=pass:${dkim.slice(0, 8).join(",")}` : "dkim=fail"] : []),
    ...(dmarc && /^[a-z]+$/.test(dmarc) ? [`dmarc=${dmarc}`] : []),
  ];
  return out.length ? out.join("; ") : undefined;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) =>
  [...(b instanceof Uint8Array ? b : new Uint8Array(b))].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * The three headers that sign one delivery (`X-SD-Time`, `X-SD-Nonce`, `X-SD-Sig`): HMAC-SHA256 under
 * the key's UTF-8 bytes of `METHOD\nTARGET\nTIME\nNONCE\n` and the body's hex SHA-256.
 */
export async function signDelivery(
  key: string,
  method: string,
  target: string,
  body: Uint8Array,
  now: number = Date.now(),
  nonce: string = hex(crypto.getRandomValues(new Uint8Array(16))),
): Promise<Record<string, string>> {
  const time = String(Math.floor(now / 1000));
  const digest = hex(await crypto.subtle.digest("SHA-256", body as unknown as ArrayBuffer));
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(
    await crypto.subtle.sign("HMAC", k, enc.encode(`${method.toUpperCase()}\n${target}\n${time}\n${nonce}\n${digest}`)),
  );
  return { "x-sd-time": time, "x-sd-nonce": nonce, "x-sd-sig": `v1=${sig}` };
}

/** The path and signed query of a delivery to the hosted router: the envelope and the receiving server's verdict. */
export function deliveryTarget(o: { slug: string; to: string; from: string; auth?: string | undefined }): string {
  const q = new URLSearchParams({ to: o.to, from: o.from, ...(o.auth ? { auth: o.auth } : {}) });
  return `/v1/inbound/${o.slug}?${q.toString()}`;
}

/**
 * How the gateway answers the sending server for a status: taken, later (it retries for days), or
 * refused. A signature the router does not accept (401) is ours to fix, never the sender's fault:
 * later, so no email is lost while the keys are put right.
 */
export function verdictOf(status: number): "taken" | "later" | "refused" {
  if (status >= 200 && status < 300) return "taken";
  if (status >= 500 || status === 429 || status === 408 || status === 401 || status === 403) return "later";
  return "refused";
}
