/** A run of a message's text: plain, or an http(s) link that opens in a new tab. */
export interface LinkPart {
  readonly at: number;
  readonly text: string;
  readonly href?: string;
}

/**
 * A message's text cut into plain runs and the http(s) links in it, so a link in a message can be
 * opened from the thread. A link keeps exactly what is written; a full stop or a bracket after it
 * stays text, and so does an address no browser can open (`linkUrl`).
 */
export function linkParts(text: string): LinkPart[] {
  const out: LinkPart[] = [];
  let at = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    const url = m[0].replace(/[.,;:!?)\]}'"]+$/, "");
    const start = m.index ?? 0;
    if (url.length <= "https://".length || !linkUrl(url)) continue;
    if (start > at) out.push({ at, text: text.slice(at, start) });
    out.push({ at: start, text: url, href: url });
    at = start + url.length;
  }
  if (at < text.length) out.push({ at, text: text.slice(at) });
  return out;
}

/** The address a browser opens for an http(s) link, or null when it opens none (`https://paypal.com\u202e…`). */
export function linkUrl(href: string): URL | null {
  if (!/^https?:\/\//i.test(href)) return null;
  try {
    const url = new URL(href);
    return url.host ? url : null;
  } catch {
    return null;
  }
}

/**
 * A link's title and its name to a screen reader: its address as the browser reaches it. The host as
 * reached (a name before an "@" is not part of it, letters that look like others are in their ASCII
 * form), then the path, query and fragment as the browser sends them, so nothing written to pass for
 * another host is read out or shown on hover. The href itself stays exactly as written.
 */
export function linkName(href: string): string {
  const url = linkUrl(href);
  return url ? `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}` : href;
}

/**
 * A piece of a link as it is written. Every piece's `text`, in order, is the link exactly as written,
 * so a copy of the message still holds the whole address. A piece is drawn as written, or `hidden`:
 * kept for copying and for screen readers, and drawn as `shows` instead ("…", "?…", or the real host).
 */
export interface LinkRun {
  readonly text: string;
  /**
   * A piece of the host, which says where the link goes: `domain`, the name its owner registered,
   * drawn bold (`example.pt` of `my.example.pt`, `example.co.uk`); `sub`, the names before it, drawn
   * plain, so a long one (`my.example.pt.account-verify.evil-example.net`) never reads as the
   * domain; `port`.
   */
  readonly host?: "sub" | "domain" | "port";
  readonly hidden?: true;
  readonly shows?: string;
}

/** How many characters a link takes on screen, past which its path is shortened. Its host is never cut. */
export const LINK_ROOM = 48;
/** A path's last part longer than this is shortened (`longLast`). */
const LAST_ROOM = 24;
/**
 * A host's name (`example.`), or its domain, this long or shorter is never broken across two lines;
 * a longer one may be, so it never widens a phone's screen.
 */
export const HOST_KEEP = 30;
/** Characters that draw nothing or turn the text around: never drawn inside a link's path. */
const HIDDEN_CHARS = /[\p{Cf}\p{Zl}\p{Zp}]/u;
/**
 * What in a link's path or query could be read as its host: a "\" (the browser reads it as "/"), or an
 * "@" before a dotted name (`/@paypal.com`, `?@paypal.com`), as an address is written. Never drawn.
 */
const POSES_AS_HOST = /\\|[@\uFF20\uFE6B][^/?#@\uFF20\uFE6B]*\.[^/?#@\uFF20\uFE6B.]/;
/**
 * The second-level names many countries' domains are registered under (`shop.com.pt`, `shop.co.uk`,
 * `city.gov.br`): under a two-letter country's ending, the domain is three names. Anywhere else it is
 * the last two. A name missing here draws fewer names bold, never more: never one its owner did not register.
 */
const UNDER = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "go",
  "gob",
  "gouv",
  "gov",
  "govt",
  "ltd",
  "mil",
  "ne",
  "net",
  "nhs",
  "nom",
  "or",
  "org",
  "plc",
  "sch",
]);

/**
 * Where, in a host's name as the browser reaches it, the domain its owner registered starts: 0 for a
 * name that is all domain (`example.pt`, `localhost`, an IP address).
 */
export function domainAt(hostname: string): number {
  if (hostname.startsWith("[") || /^[\d.]+$/.test(hostname)) return 0;
  const names = (hostname.endsWith(".") ? hostname.slice(0, -1) : hostname).split(".");
  const ending = names.at(-1) ?? "";
  const second = names.at(-2) ?? "";
  const take = ending.length === 2 && UNDER.has(second) ? 3 : 2;
  if (names.length <= take) return 0;
  return names.slice(0, names.length - take).join(".").length + 1;
}

/**
 * A link cut into what is drawn and what is not: its host always, shown as the browser will reach
 * it, then its path, shortened in the middle when long (`my.example.pt/modules/addons/…/verify.php?…`).
 * The scheme is not drawn. A written host that is not the one reached (a name before an "@",
 * letters that look like others, a port the browser drops) is drawn as the host reached instead.
 */
export function linkRuns(href: string): LinkRun[] {
  const scheme = /^https?:\/\//i.exec(href)?.[0];
  const url = linkUrl(href);
  if (!scheme || !url) return [{ text: href }];
  const rest = href.slice(scheme.length);
  const end = rest.search(/[/\\?#]/);
  const written = end < 0 ? rest : rest.slice(0, end);
  const tail = end < 0 ? "" : rest.slice(end);
  const host = url.host;
  const runs: LinkRun[] = [{ text: scheme, hidden: true }, ...hostRuns(written, url)];
  if (!tail) return runs;
  // No host written before the path ("https:///evil.example/"): the browser skips the slashes, so the
  // host drawn above is written in this tail, and its path is not what is written here.
  if (written === "") {
    const nothing = url.pathname === "/" && !url.search && !url.hash;
    return [...runs, { text: tail, hidden: true, shows: nothing ? "" : "/…" }];
  }
  const q = tail.search(/[?#]/);
  const path = q < 0 ? tail : tail.slice(0, q);
  const query = q < 0 ? "" : tail.slice(q);
  // A path with characters that draw nothing or turn the text around, or that could be read as the
  // host, is never drawn.
  if (HIDDEN_CHARS.test(tail) || POSES_AS_HOST.test(path)) {
    return [...runs, { text: tail, hidden: true, shows: path ? "/…" : queryShows(query) }];
  }
  // A bare "/" says nothing.
  if (path === "/" && !query) return [...runs, { text: path, hidden: true }];
  const posing = POSES_AS_HOST.test(query);
  if (!posing && host.length + tail.length <= LINK_ROOM) return [...runs, { text: tail }];
  const folded = query ? foldQuery(query) : null;
  return [...runs, ...shortPath(path, host.length + (folded?.shows?.length ?? 0)), ...(folded ? [folded] : [])];
}

/**
 * The host's pieces: as written when it is the host the browser reaches, cut where its domain starts;
 * otherwise what is written is kept for a copy, and the host reached is drawn in its place.
 */
function hostRuns(written: string, url: URL): LinkRun[] {
  const name = url.hostname;
  const at = domainAt(name);
  const sub = name.slice(0, at);
  const domain = name.slice(at);
  const port = url.host.slice(name.length);
  if (written.toLowerCase() === url.host && written.length === url.host.length && !HIDDEN_CHARS.test(written)) {
    const pieces: [NonNullable<LinkRun["host"]>, string][] = [
      ["sub", sub],
      ["domain", domain],
      ["port", port],
    ];
    let from = 0;
    return pieces
      .filter(([, piece]) => piece !== "")
      .map(([kind, piece]) => {
        const text = written.slice(from, from + piece.length);
        from += piece.length;
        return { text, host: kind };
      });
  }
  return [
    { text: written, host: "sub", hidden: true, shows: sub },
    { text: "", host: "domain", hidden: true, shows: domain },
    ...(port ? [{ text: "", host: "port" as const, hidden: true as const, shows: port }] : []),
  ];
}

/** What a link shows on screen: its host and its path, shortened when long. */
export function linkDisplay(href: string): string {
  return linkRuns(href)
    .map((r) => (r.hidden ? (r.shows ?? "") : r.text))
    .join("");
}

/** A query or a fragment, folded: "?…", or "#…" for a fragment alone. */
function foldQuery(query: string): LinkRun {
  return { text: query, hidden: true, shows: queryShows(query) };
}

/** What a folded query or fragment draws. */
function queryShows(query: string): string {
  return query.startsWith("?") ? "?…" : "#…";
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
 * line, after a blank line or at the very start, then one http(s) link a line to the end, each one a
 * browser opens. Null when the text ends any other way, so a message that only names the heading
 * stays as it is.
 */
export function splitLinksBlock(text: string): LinksBlock | null {
  const at = text.lastIndexOf(LINKS_HEADING);
  if (at < 0 || (at > 0 && !text.slice(0, at).endsWith("\n\n"))) return null;
  const [first, ...links] = text.slice(at + LINKS_HEADING.length).split("\n");
  if (first !== "" || links.length === 0) return null;
  if (!links.every((l) => /^https?:\/\/\S+$/i.test(l) && linkUrl(l) !== null)) return null;
  return { body: text.slice(0, at).replace(/\n+$/, ""), links };
}

/**
 * The links to list under an email's words: those its words do not already show as links (the email
 * door keeps every link an email carries, those in its text too), so none is drawn twice.
 */
export function linksToList(block: LinksBlock): string[] {
  const shown = new Set(linkParts(block.body).flatMap((p) => (p.href ? [p.href] : [])));
  return block.links.filter((l) => !shown.has(l));
}
