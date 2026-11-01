/** A run of a message's text: plain, or an http(s) link that opens in a new tab. */
export interface LinkPart {
  readonly at: number;
  readonly text: string;
  readonly href?: string;
}

/**
 * A message's text cut into plain runs and the http(s) links in it, so a link in a message can be
 * opened from the thread. A link shows exactly as it is written; a full stop or a bracket after it
 * stays text.
 */
export function linkParts(text: string): LinkPart[] {
  const out: LinkPart[] = [];
  let at = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    const url = m[0].replace(/[.,;:!?)\]}'"]+$/, "");
    const start = m.index ?? 0;
    if (url.length <= "https://".length) continue;
    if (start > at) out.push({ at, text: text.slice(at, start) });
    out.push({ at: start, text: url, href: url });
    at = start + url.length;
  }
  if (at < text.length) out.push({ at, text: text.slice(at) });
  return out;
}
