import type { Door, FormFacts, Signal } from "../types";

/**
 * What the business's own form tells (ADR-029 §5): a hidden field only bots fill, a form that was
 * never drawn, one drawn under a key this inbox did not sign, one filled faster than anyone types,
 * the same key with other words, links where a name goes. The visitor sees the same page whatever
 * this finds.
 */

const LINK_OR_ADDRESS =
  /(?:https?:\/\/|www\.)\S|[^\s@]+@[^\s@]+\.[^\s@]{2,}|\b[a-z0-9-]{2,}\.(?:com|net|org|io|ru|cn|xyz|top|info|biz)\b/i;
const MARKUP = /<a\s+href|\[url\s*=|\[link\s*=|\[url\]/i;

export function formSignals(
  door: Door,
  f: FormFacts,
  fields: { readonly name?: string | undefined; readonly texts: readonly string[] },
  now: number,
): Signal[] {
  const out: Signal[] = [];
  if (f.trap) out.push({ c: "trap", w: 6, f: "basic", x: 1 });
  // A form the page never drew: only the inbox's own form carries a key (a WordPress form has none).
  if (door === "form" && f.key === "none") out.push({ c: "no_key", w: 6, f: "basic", x: 1 });
  // A wrong signature is a forged key, or one drawn before the secret changed: it counts, never decides.
  if (f.key === "invalid") out.push({ c: "key_invalid", w: 4, f: "basic" });
  const elapsed = f.elapsedMs ?? (f.drawnAt !== undefined ? now - f.drawnAt : undefined);
  if (elapsed !== undefined && elapsed >= 0) {
    const seconds = Math.round(elapsed / 100) / 10;
    if (elapsed < 2_000) out.push({ c: "too_fast", w: 4, v: seconds, f: "basic" });
    else if (elapsed < 4_000) out.push({ c: "too_fast", w: 1.5, v: seconds, f: "basic" });
  }
  if (f.replayed) out.push({ c: "key_replayed", w: 3, f: "basic" });
  if (f.drawnAt !== undefined && now - f.drawnAt > 86_400_000) out.push({ c: "key_stale", w: 1, f: "basic" });
  if (fields.name && LINK_OR_ADDRESS.test(fields.name)) out.push({ c: "name_link", w: 3, f: "basic" });
  if (fields.texts.some((t) => MARKUP.test(t))) out.push({ c: "markup", w: 3, f: "basic" });
  return out;
}
