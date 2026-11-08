/** A run of a message's text: plain, or an http(s) link that opens in a new tab. */
export interface LinkPart {
  readonly at: number;
  readonly text: string;
  readonly href?: string;
}

/**
 * A message's text cut into plain runs and the http(s) links in it, so a link in a message can be
 * opened from the thread. A link keeps exactly what is written; a full stop or a bracket after it
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

/**
 * A piece of a link as it is written. Every piece's `text`, in order, is the link exactly as written,
 * so a copy of the message still holds the whole address. A piece is drawn as written, or `hidden`:
 * kept for copying and for screen readers, and drawn as `shows` instead ("…", "?…", or the real host).
 */
export interface LinkRun {
  readonly text: string;
  /** The host: drawn in its own weight, since it says where the link goes. */
  readonly host?: true;
  readonly hidden?: true;
  readonly shows?: string;
}

/** How many characters a link takes on screen, past which its path is shortened. Its host is never cut. */
export const LINK_ROOM = 48;
/** A path's last part longer than this is shortened (`longLast`). */
const LAST_ROOM = 24;
/** Characters that draw nothing or turn the text around: never drawn inside a link's path. */
const HIDDEN_CHARS = /[\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * A link cut into what is drawn and what is not: its host always, shown as the browser will reach
 * it, then its path, shortened in the middle when long (`my.dominios.pt/modules/addons/…/verify.php?…`).
 * The scheme is not drawn. A written host that is not the one reached (a name before an "@",
 * letters that look like others, a port the browser drops) is drawn as the host reached instead.
 */
export function linkRuns(href: string): LinkRun[] {
  const scheme = /^https?:\/\//i.exec(href)?.[0];
  let url: URL | null = null;
  try {
    url = new URL(href);
  } catch {
    url = null;
  }
  if (!scheme || !url?.host) return [{ text: href }];
  const rest = href.slice(scheme.length);
  const end = rest.search(/[/\\?#]/);
  const written = end < 0 ? rest : rest.slice(0, end);
  const tail = end < 0 ? "" : rest.slice(end);
  const host = url.host;
  const runs: LinkRun[] = [{ text: scheme, hidden: true }];
  runs.push(
    written.toLowerCase() === host && !HIDDEN_CHARS.test(written)
      ? { text: written, host: true }
      : { text: written, host: true, hidden: true, shows: host },
  );
  if (!tail) return runs;
  // A path with characters that draw nothing or turn the text around is never drawn.
  if (HIDDEN_CHARS.test(tail)) return [...runs, { text: tail, hidden: true, shows: "/…" }];
  const q = tail.search(/[?#]/);
  const path = q < 0 ? tail : tail.slice(0, q);
  const query = q < 0 ? "" : tail.slice(q);
  // A bare "/" says nothing.
  if (path === "/" && !query) return [...runs, { text: path, hidden: true }];
  if (host.length + tail.length <= LINK_ROOM) return [...runs, { text: tail }];
  const folded = query ? foldQuery(query) : null;
  return [...runs, ...shortPath(path, host.length + (folded?.shows?.length ?? 0)), ...(folded ? [folded] : [])];
}

/** What a link shows on screen: its host and its path, shortened when long. */
export function linkDisplay(href: string): string {
  return linkRuns(href)
    .map((r) => (r.hidden ? (r.shows ?? "") : r.text))
    .join("");
}

/** A query or a fragment, folded: "?…", or "#…" for a fragment alone. */
function foldQuery(query: string): LinkRun {
  return { text: query, hidden: true, shows: query.startsWith("?") ? "?…" : "#…" };
}

/**
 * A long path, kept to the room the host and a folded query leave (`taken`): its first parts while
 * they fit, "/…" for the rest, then its last part, which most often says what the link is
 * (`verify.php`, `invoice.pdf`).
 */
function shortPath(path: string, taken: number): LinkRun[] {
  if (path === "" || path === "/") return path ? [{ text: path }] : [];
  // A path that does not start with "/" (a "\" in its place) is one part.
  const parts = path.startsWith("/") ? path.slice(1).split("/") : [path];
  const slash = path.startsWith("/") ? "/" : "";
  const trailing = parts.length > 1 && parts.at(-1) === "" ? "/" : "";
  if (trailing) parts.pop();
  const last = parts.pop() ?? "";
  const lastRuns: LinkRun[] =
    last.length > LAST_ROOM ? longLast(last, slash, trailing) : [{ text: `${slash}${last}${trailing}` }];
  const lastShown = lastRuns.reduce((n, r) => n + (r.hidden ? (r.shows ?? "").length : r.text.length), 0);
  // Room for the first parts: past the host and the query, the last part, and the "/…" for the rest.
  let room = LINK_ROOM - taken - lastShown - (parts.length > 0 ? 2 : 0);
  const head: string[] = [];
  for (const part of parts) {
    if (part.length + 1 > room) break;
    head.push(part);
    room -= part.length + 1;
  }
  const middle = parts.slice(head.length);
  return [
    ...(head.length ? [{ text: `/${head.join("/")}` }] : []),
    ...(middle.length ? [{ text: `/${middle.join("/")}`, hidden: true as const, shows: "/…" }] : []),
    ...lastRuns,
  ];
}

/**
 * A long last part, shortened in the middle: its start, "…", and its end when it names a file, so a
 * token in a path says no more than it must and a file still says what it is (`invoice-2026…sion.pdf`).
 */
function longLast(last: string, slash: string, trailing: string): LinkRun[] {
  const ext = /\.[a-z0-9]{1,5}$/i.exec(last)?.[0] ?? "";
  const end = ext ? ext.length + 4 : 0;
  const tail = `${last.slice(last.length - end)}${trailing}`;
  return [
    { text: `${slash}${last.slice(0, 12)}` },
    { text: last.slice(12, last.length - end), hidden: true, shows: "…" },
    ...(tail ? [{ text: tail }] : []),
  ];
}

/**
 * What heads the links an email carries, kept under its words by the inbox (`LINKS_HEADING` in
 * packages/core/src/email/channel.ts; a test holds the two together).
 */
export const LINKS_HEADING = "Links in this email:";
/** The heading as the owner app draws it above the list. */
export const LINKS_TITLE = "Links in this email";

/** A message's words, and the links its email carried, kept apart. */
export interface LinksBlock {
  readonly body: string;
  readonly links: readonly string[];
}

/**
 * The links the inbox kept under an email's words, found as it writes them: the heading on its own
 * line, after a blank line or at the very start, then one http(s) link a line to the end. Null when
 * the text ends any other way, so a message that only names the heading stays as it is.
 */
export function splitLinksBlock(text: string): LinksBlock | null {
  const at = text.lastIndexOf(LINKS_HEADING);
  if (at < 0 || (at > 0 && !text.slice(0, at).endsWith("\n\n"))) return null;
  const [first, ...links] = text.slice(at + LINKS_HEADING.length).split("\n");
  if (first !== "" || links.length === 0 || !links.every((l) => /^https?:\/\/\S+$/i.test(l))) return null;
  return { body: text.slice(0, at).replace(/\n+$/, ""), links };
}
