import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { isEd25519PublicJwk } from "@surfingdog/sdk";
import categories from "@surfingdog/spec/vocab/categories.json" with { type: "json" };

/**
 * Reading an inbox's manifest (protocol §4.1), and what the directory keeps from it (§4.6).
 *
 * In production a manifest is read only from `https://<domain>/.well-known/agent-inbox.json`, on a
 * public address checked as the connection is made, with no redirect, in five seconds and 256 KB.
 * In a test, `testManifests` maps a domain to the URL to read it from instead
 * (`NETWORK_TEST_MANIFESTS`), which is how the network checker's `--flow` plays an inbox on this
 * machine. Never set it on a network others use.
 */

export type FetchedManifest =
  | { readonly ok: true; readonly manifest: Record<string, unknown>; readonly keys: readonly Record<string, unknown>[] }
  | { readonly ok: false; readonly error: string };

export type ManifestFetcher = (domain: string) => Promise<FetchedManifest>;

const MAX_BYTES = 256 * 1024;

/** A domain a business may register: lowercase labels, at least two, never an address. */
export function validDomain(domain: unknown): domain is string {
  if (typeof domain !== "string" || domain.length > 253 || isIP(domain)) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (/^[0-9]+$/.test(labels.at(-1) ?? "")) return false;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/** The manifest's own checks: it names itself, and its keys are Ed25519 keys. */
export function checkManifest(domain: string, doc: unknown): FetchedManifest {
  const m = doc as Record<string, unknown> | null;
  if (typeof m !== "object" || m === null) return { ok: false, error: "the manifest is not a JSON object" };
  if (typeof m.spec !== "string" || !m.spec.startsWith("surfingdog-inbox/")) {
    return { ok: false, error: 'the manifest\'s spec does not start "surfingdog-inbox/"' };
  }
  if (m.instance !== `https://${domain}`)
    return { ok: false, error: `the manifest's instance is not https://${domain}` };
  const keys = ((m.receipt_keys as { keys?: unknown } | undefined)?.keys ?? []) as unknown[];
  if (!Array.isArray(keys)) return { ok: false, error: "receipt_keys.keys is not a list" };
  return { ok: true, manifest: m, keys: keys.filter(isEd25519PublicJwk) as unknown as Record<string, unknown>[] };
}

export function httpManifestFetcher(testManifests: Readonly<Record<string, string>> = {}): ManifestFetcher {
  return async (domain) => {
    const test = testManifests[domain];
    try {
      const got = test ? await readTest(test) : await readPinned(domain);
      if (got === "not_public") return { ok: false, error: "the domain does not resolve to a public address" };
      if (got.status !== 200) return { ok: false, error: "the manifest did not answer 200" };
      if (got.text === null) return { ok: false, error: "the manifest is over 256 KB" };
      let doc: unknown;
      try {
        doc = JSON.parse(got.text);
      } catch {
        return { ok: false, error: "the manifest is not JSON" };
      }
      return checkManifest(domain, doc);
    } catch {
      // Never the error itself: it can carry what an address answered, and it is shown to anyone.
      return { ok: false, error: "the manifest could not be read" };
    }
  };
}

type Read = { readonly status: number; readonly text: string | null } | "not_public";

/** A test's manifest, from the local URL `NETWORK_TEST_MANIFESTS` names for it. */
async function readTest(url: string): Promise<Read> {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
  if (res.status !== 200) {
    await res.body?.cancel();
    return { status: res.status, text: null };
  }
  const reader = res.body?.getReader();
  if (!reader) return { status: 200, text: "" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return { status: 200, text: null };
    }
    chunks.push(value);
  }
  return { status: 200, text: new TextDecoder().decode(Buffer.concat(chunks)) };
}

/**
 * A manifest read over https, on the address that was checked. The name is resolved once, inside
 * the connection, and the connection dials only an address that passed: checking first and letting
 * the request resolve again would let a name with a zero TTL answer a public address to the check
 * and 127.0.0.1 to the request. Any address in the answer that is not public refuses the whole
 * answer. No redirect is followed, and the five seconds cover the body too.
 */
function readPinned(domain: string): Promise<Read> {
  if (isIP(domain)) return Promise.resolve("not_public");
  return new Promise((resolve, reject) => {
    let notPublic = false;
    const checked: LookupFunction = (hostname, options, callback) => {
      dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
        if (err) return callback(err, "");
        const first = addrs[0];
        if (!first || !addrs.every((a) => publicAddress(a.address))) {
          notPublic = true;
          return callback(Object.assign(new Error("not a public address"), { code: "ENOTPUBLIC" }), "");
        }
        if (options.all) callback(null, addrs);
        else callback(null, first.address, first.family);
      });
    };
    const req = httpsRequest(
      {
        host: domain,
        servername: domain,
        path: "/.well-known/agent-inbox.json",
        method: "GET",
        headers: { Accept: "application/json" },
        agent: false,
        lookup: checked,
        signal: AbortSignal.timeout(5_000),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          return resolve({ status: res.statusCode ?? 0, text: null });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            return resolve({ status: 200, text: null });
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: 200, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
        // Cut off before the end, by the timeout or the other side: an error, never a short manifest.
        res.on("close", () => {
          if (!res.complete) reject(new Error("the manifest was cut short"));
        });
      },
    );
    req.on("error", (e) => (notPublic ? resolve("not_public") : reject(e)));
    req.end();
  });
}

/*
 * What a public address is: the rules the network's crawler keeps. IPv4 leaves out this network,
 * the private, shared, loopback and link-local ranges, the IETF, documentation and benchmarking
 * ranges, multicast and everything reserved above it. IPv6 must be global unicast (2000::/3), and
 * not documentation, Teredo or 6to4, which embed an IPv4 address that cannot be vetted. That one
 * rule also leaves out loopback, unique-local, link-local, site-local, NAT64, IPv4-mapped and
 * IPv4-compatible addresses, all of which sit outside 2000::/3.
 */
const NOT_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  NOT_PUBLIC.addSubnet(net, prefix, "ipv4");
}
NOT_PUBLIC.addSubnet("2001:db8::", 32, "ipv6");
NOT_PUBLIC.addSubnet("2001::", 32, "ipv6");
NOT_PUBLIC.addSubnet("2002::", 16, "ipv6");
const GLOBAL_UNICAST = new BlockList();
GLOBAL_UNICAST.addSubnet("2000::", 3, "ipv6");

/** Whether an address is one a manifest may be read from. */
export function publicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !NOT_PUBLIC.check(ip, "ipv4");
  if (family === 6) return GLOBAL_UNICAST.check(ip, "ipv6") && !NOT_PUBLIC.check(ip, "ipv6");
  return false;
}

/* --- what the directory shows (§4.6) ---------------------------------------------------------- */

type Vocab = { categories: { slug: string; labels: Record<string, string>; synonyms?: Record<string, string[]> }[] };

const SLUG_OF = new Map<string, string>();
for (const c of (categories as unknown as Vocab).categories) {
  for (const word of [c.slug, ...Object.values(c.labels), ...Object.values(c.synonyms ?? {}).flat()]) {
    SLUG_OF.set(fold(word), c.slug);
  }
}

/** Lowercase, without accents: how a category's label or synonym is matched. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/** Text as a reader sees it: no control, reordering or tag characters, white space collapsed, cut. */
function clean(s: unknown, max: number): string | undefined {
  if (typeof s !== "string") return undefined;
  const out = s
    .replace(/[\p{Cc}\p{Bidi_Control}\u{E0000}-\u{E007F}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return out || undefined;
}

export interface Shown {
  readonly name: string;
  readonly description?: string;
  readonly categories: string[];
  readonly tags: string[];
  readonly languages: string[];
  readonly url?: string;
  readonly services?: { name: string; type: string }[];
  readonly item_types: string[];
  readonly protocols: Record<string, string>;
}

/** What the directory keeps from a manifest: each field checked and dropped alone (§4.6). */
export function shownOf(domain: string, manifest: Record<string, unknown> | null): Shown {
  const p = (manifest?.profile ?? {}) as Record<string, unknown>;
  const cats: string[] = [];
  const tags: string[] = [];
  for (const c of Array.isArray(p.categories) ? p.categories : []) {
    const word = clean(c, 60);
    if (!word) continue;
    const slug = SLUG_OF.get(fold(word));
    if (slug) {
      if (!cats.includes(slug) && cats.length < 10) cats.push(slug);
    } else if (word.length <= 40 && !tags.includes(word) && tags.length < 10) {
      tags.push(word);
    }
  }
  const languages = (Array.isArray(p.languages) ? p.languages : [])
    .filter((l): l is string => typeof l === "string" && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(l))
    .slice(0, 10);
  const url = typeof p.url === "string" && /^https?:\/\/[^\s\p{Cc}]+$/u.test(p.url) ? p.url : undefined;
  const services = (Array.isArray(p.services) ? p.services : [])
    .flatMap((s) => {
      const name = clean((s as { name?: unknown }).name, 80);
      const type = (s as { type?: unknown }).type;
      return name && (type === "booking" || type === "order" || type === "quote_request") ? [{ name, type }] : [];
    })
    .slice(0, 30);
  const itemTypes = (Array.isArray(manifest?.item_types) ? manifest.item_types : []).filter(
    (t): t is string => typeof t === "string",
  );
  const protocols: Record<string, string> = {};
  for (const [k, v] of Object.entries((manifest?.protocols ?? {}) as Record<string, unknown>)) {
    if (typeof v !== "string" || /[\s\p{Cc}]/u.test(v)) continue;
    try {
      const u = new URL(v);
      if (
        (u.protocol === "https:" && !isIP(u.hostname.replace(/^\[|\]$/g, "")) && !u.username) ||
        u.protocol === "mailto:"
      ) {
        protocols[k] = v;
      }
    } catch {
      // A door that is not a URL is left out.
    }
  }
  const description = clean(p.description, 500);
  return {
    name: clean(p.name, 200) ?? domain,
    ...(description ? { description } : {}),
    categories: cats,
    tags,
    languages,
    ...(url ? { url } : {}),
    ...(services.length ? { services } : {}),
    item_types: itemTypes,
    protocols,
  };
}
