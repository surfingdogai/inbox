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
 * (`<slug>@in.surfingdog.ai`, or a conversation's `<slug>+<token>@…`), refused when it is on that
 * domain but names no inbox; to our own inbox otherwise (the addresses routed to this Worker for it).
 */
export function routeFor(to: string, hostedDomain: string | undefined): Route {
  const address = to.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0) return { kind: "refuse", reason: "no such address" };
  const domain = address.slice(at + 1);
  if (!hostedDomain || domain !== hostedDomain.trim().toLowerCase()) return { kind: "own" };
  const slug = address.slice(0, at).split("+")[0] ?? "";
  return SLUG.test(slug) ? { kind: "hosted", slug } : { kind: "refuse", reason: "no such address" };
}

/**
 * What the receiving server found, from its own Authentication-Results (RFC 8601) — the topmost one
 * whose authserv-id is trusted, which it added last — as `spf=…; dkim=pass:d1,d2; dmarc=…` for the
 * inbox (`X-Inbox-Email-Auth`). Undefined when there is none. A sender can write such a header into
 * its own message, so it is only ever a second signal: a forged "pass" proves nothing the inbox does
 * not check otherwise, and a forged "fail" only hurts the forger's own email.
 */
export function authSummary(headers: Iterable<[string, string]>, trusted: readonly string[]): string | undefined {
  const ids = trusted.map((t) => t.trim().toLowerCase()).filter(Boolean);
  for (const [name, raw] of headers) {
    const key = name.toLowerCase();
    if (key !== "authentication-results" && key !== "arc-authentication-results") continue;
    const value = raw.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ");
    const parts = value
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean);
    // ARC's own starts with its instance (`i=1`).
    if (/^i=\d+$/i.test(parts[0] ?? "")) parts.shift();
    const authserv = (parts.shift() ?? "").split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!ids.includes(authserv)) continue;
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
  return undefined;
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
