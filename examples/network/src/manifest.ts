import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isEd25519PublicJwk } from "@surfingdog/sdk";
import categories from "@surfingdog/spec/vocab/categories.json" with { type: "json" };

/**
 * Reading an inbox's manifest (protocol §4.1), and what the directory keeps from it (§4.6).
 *
 * In production a manifest is read only from `https://<domain>/.well-known/agent-inbox.json`, on a
 * public address, with no redirect, in five seconds and 256 KB. In a test, `testManifests` maps a
 * domain to the URL to read it from instead (`NETWORK_TEST_MANIFESTS`), which is how the network
 * checker's `--flow` plays an inbox on this machine. Never set it on a network others use.
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
    const url = test ?? `https://${domain}/.well-known/agent-inbox.json`;
    try {
      if (!test && !(await isPublic(domain)))
        return { ok: false, error: "the domain does not resolve to a public address" };
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
      if (res.status !== 200) return { ok: false, error: `the manifest answered ${res.status}` };
      const text = await readCapped(res, MAX_BYTES);
      if (text === null) return { ok: false, error: "the manifest is over 256 KB" };
      return checkManifest(domain, JSON.parse(text));
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "the manifest could not be read" };
    }
  };
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Whether every address a name resolves to is public: no loopback, private, link-local or unique-local. */
async function isPublic(host: string): Promise<boolean> {
  const addrs = await lookup(host, { all: true, verbatim: true });
  return addrs.length > 0 && addrs.every((a) => !privateAddress(a.address));
}

function privateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(v);
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
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
