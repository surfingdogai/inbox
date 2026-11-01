import { accentIn, isDefaultLook, type Look, logoBox, THEME_TONES, type ThemeTones } from "../look/palette";

/**
 * An email to a customer as HTML, in the business's look: its logo (or its name), then the email's
 * own words, with each link in its accent. Written from the final text, once its links and arrival
 * details are filled in: the text stays the email, and the only part the mail log keeps; this is
 * the same words, laid out.
 *
 * - Always light, whatever the theme: a dark email turns odd in a mail app that darkens it again.
 *   Dark sends Standard's day tones; Minimal and Warm their own.
 * - Inline styles only, a 600px table, the system's own fonts: no `<style>`, no web font, no script.
 * - A line that is a label and one of the inbox's own answer links (`Accept: <base>/c/<token>`, the
 *   French `Accepter : …` too) is a thin outlined button. Only those: a stranger's name or a pasted
 *   address can be made to look like such a line, so any other address stays a link, underlined,
 *   showing all of itself.
 * - Every word of the business's and its customer's is escaped.
 */
export interface CustomerMailHtml {
  /** Who it is from, heading the email and the logo's alt. */
  readonly business: string;
  readonly lang: string;
  readonly look: Look;
  /** The inbox's public address, the one its links use: only a link of its own is a button. */
  readonly base?: string | null | undefined;
  /** The logo's absolute address (`mailLogoUrl`), or null for the name in text. */
  readonly logoUrl: string | null;
  readonly subject?: string | undefined;
}

const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The logo's largest size in an email header, in CSS pixels. */
const LOGO_MAX_W = 200;
const LOGO_MAX_H = 40;

/** A label and a link on one line: `Label: https://…`, the French `Label : https://…` among them. */
const BUTTON_LINE = /^(.{1,60}?)[ \u00a0]?: (https?:\/\/\S+)$/;
/** A whole answer link's token, as `fillLinks` makes it for the email it was minted for; a cut one is not. */
const WHOLE_TOKEN = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/;
/** An address in running text. What ends a sentence after it is not part of it. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]'"»]+$/;

/**
 * The HTML part of an email to a customer, once the business chose a look: a default inbox's email
 * stays text alone, as it always was. `base` is the inbox's public address, the one its links use.
 */
export function customerHtmlPart(
  text: string,
  look: Look,
  o: {
    readonly business: string;
    readonly lang: string;
    readonly base: string | null | undefined;
    readonly subject: string;
  },
): { html?: string } {
  if (isDefaultLook(look)) return {};
  return {
    html: customerMailHtml(text, {
      business: o.business,
      lang: o.lang,
      look,
      base: o.base,
      logoUrl: mailLogoUrl(o.base, look),
      subject: o.subject,
    }),
  };
}

/** The logo at the inbox's public address (`/p/logo/<file>`), or null with no logo or no address. */
export function mailLogoUrl(base: string | null | undefined, look: Look): string | null {
  if (!look.logo || !base) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return `${base.replace(/\/+$/, "")}/p/logo/${look.logo.file}`;
}

/** The tones an email is drawn in: always a day's. */
function mailTones(look: Look): ThemeTones {
  return look.theme === "minimal" || look.theme === "warm" ? THEME_TONES[look.theme] : THEME_TONES.standard;
}

export function customerMailHtml(text: string, o: CustomerMailHtml): string {
  const tones = mailTones(o.look);
  const { accent } = accentIn(o.look.accent, tones);
  const business = o.business.trim();
  const logo = o.logoUrl && o.look.logo ? logoBox(o.look.logo.width, o.look.logo.height, LOGO_MAX_W, LOGO_MAX_H) : null;
  const header = logo
    ? `<img src="${esc(o.logoUrl ?? "")}" alt="${esc(business)}" width="${logo.width}" height="${logo.height}" style="display:block;border:0;outline:none;width:${logo.width}px;height:${logo.height}px;max-width:100%">`
    : business
      ? `<span style="font:500 15px/1.4 ${FONT};color:${tones.fg}">${esc(business)}</span>`
      : "";
  const rows = [
    header ? `<tr><td style="padding:0 0 14px;border-bottom:1px solid ${tones.rule}">${header}</td></tr>` : "",
    `<tr><td style="padding:${header ? "20px" : "0"} 0 0;font:15px/1.55 ${FONT};color:${tones.fg}">${body(text, accent, o.base)}</td></tr>`,
  ].join("");
  return `<!doctype html>
<html lang="${esc(o.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(o.subject ?? business)}</title>
</head>
<body style="margin:0;padding:0;background:${tones.bg};color:${tones.fg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${tones.bg}">
<tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;text-align:left">
${rows}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Whether an address is one of the inbox's own answer links: `<base>/c/<token>`, and nothing more. */
function isOwnLink(url: string, base: string | null | undefined): boolean {
  if (!base) return false;
  const own = `${base.replace(/\/+$/, "")}/c/`;
  return url.startsWith(own) && WHOLE_TOKEN.test(url.slice(own.length));
}

/** The text as paragraphs: a blank line starts one, a single newline is a line break. */
function body(text: string, accent: string, base: string | null | undefined): string {
  const out: string[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n(?:[ \t]*\n)+/)) {
    if (!block.trim()) continue;
    let lines: string[] = [];
    const flush = () => {
      if (lines.length) out.push(`<p style="margin:0 0 14px">${lines.join("<br>")}</p>`);
      lines = [];
    };
    for (const line of block.split("\n")) {
      const button = BUTTON_LINE.exec(line.trim());
      if (button && isOwnLink(button[2] ?? "", base)) {
        flush();
        const label = (button[1] ?? "").trimEnd();
        out.push(
          `<p style="margin:0 0 14px"><a href="${esc(button[2] ?? "")}" style="display:inline-block;padding:8px 14px;border:1px solid ${accent};border-radius:6px;color:${accent};font-weight:500;text-decoration:none">${esc(label)}</a></p>`,
        );
      } else {
        lines.push(linked(line, accent));
      }
    }
    flush();
  }
  return out.join("\n");
}

/** A line with each address in it a link, everything else escaped. */
function linked(line: string, accent: string): string {
  let out = "";
  let at = 0;
  for (const m of line.matchAll(URL_IN_TEXT)) {
    const start = m.index ?? 0;
    const url = m[0].replace(TRAILING, "");
    out += esc(line.slice(at, start));
    out += `<a href="${esc(url)}" style="color:${accent};text-decoration:underline">${esc(url)}</a>`;
    at = start + url.length;
  }
  return out + esc(line.slice(at));
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}
