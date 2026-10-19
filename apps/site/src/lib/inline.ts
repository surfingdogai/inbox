/**
 * The little markup the translated pages' sentences may carry, and nothing more: `code` in
 * backticks, and [words](/a-path-or-https-address) as a link (never a //host one). Everything else
 * is text, escaped, so a translation can never put HTML on a page. The same sentence, with the marks
 * taken out, is what the page's structured data and its e-mail links carry (plain).
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const TOKEN = /`([^`]+)`|\[([^\]]+)\]\(((?:\/(?!\/)|https:\/\/)[^)\s]*)\)/g;

/**
 * The sentence as HTML: code and links marked up, everything else escaped. A link to one of `en`'s
 * addresses goes to a page in English only, and says so (hreflang and "(EN)"), as the pages' other
 * English-only links do.
 */
export function inline(text: string, en: ReadonlySet<string> = new Set()): string {
  let out = "";
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    out += esc(text.slice(at, m.index));
    if (m[1] !== undefined) out += `<code>${esc(m[1])}</code>`;
    else {
      const href = m[3] ?? "";
      const external = href.startsWith("https://") && !href.startsWith("https://surfingdog.ai/");
      const english = en.has(href);
      out += `<a class="link" href="${esc(href)}"${external ? ' rel="noopener"' : ""}${english ? ' hreflang="en"' : ""}>${esc(m[2] ?? "")}</a>`;
      if (english) out += '<span lang="en"> (EN)</span>';
    }
    at = (m.index ?? 0) + m[0].length;
  }
  return out + esc(text.slice(at));
}

/** The sentence as plain text: the words of each link, the code as written, no marks. */
export function plain(text: string): string {
  return text.replace(TOKEN, (_all, code: string | undefined, words: string | undefined) => code ?? words ?? "");
}

/** The links a sentence makes, for the tests. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(TOKEN)].filter((m) => m[3]).map((m) => m[3] ?? "");
}
