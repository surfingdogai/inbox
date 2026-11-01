import {
  accentIn,
  type Capabilities,
  type CustomerLang,
  type CustomerPage,
  copyFor,
  customerLang,
  DEFAULT_LOOK,
  isDefaultLook,
  type Look,
  langFromHeader,
  logoBox,
  type PageField,
  STANDARD_NIGHT,
  THEME_TONES,
} from "@surfingdog/core";
import { type Context, Hono } from "hono";

/**
 * The page a link in the business's email opens (ADR-018 §5), served by the inbox itself in the
 * business's name and the customer's language. `GET /c/{token}` only shows — mail scanners fetch
 * every link in an email, so a GET must never act — and `POST /c/{token}` acts, then sends the
 * browser back to the page (303), which shows what was done.
 *
 * Core builds the page as data (`caps.customer.linkView` / `linkAct`); this only writes it out as
 * HTML, every value escaped, in the business's look (`lookCss`). No script, no web font, and no image
 * but the business's own logo, from its own address; nothing fetched from anywhere else, and the
 * token never leaves in a Referer.
 */
export interface CustomerPageDeps {
  readonly caps: Capabilities;
  readonly now?: (() => number) | undefined;
}

/** The headers every page and redirect of `/c/*` carries; the app's own middleware leaves them. */
export const CUSTOMER_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
};

/** At most this much form to read: the longest answer is five thousand characters. */
const MAX_FORM_BYTES = 64 * 1024;

export function customerPage(deps: CustomerPageDeps): Hono {
  const app = new Hono();
  const now = () => (deps.now ? deps.now() : Date.now());

  app.onError(async (_error, c) => {
    const lang = await pageLang(deps.caps, c.req.header("accept-language") ?? null);
    const business = (await deps.caps.getBusinessProfile()).name;
    return renderCustomerPage(c, {
      status: 500,
      lang,
      business,
      heading: copyFor(lang).page.error,
      footer: business,
      help: "",
    });
  });

  // The page the code email links to: the booking network, explained. Nothing personal on it, so a
  // browser may keep it a few minutes.
  app.get("/privacy", async (c) => {
    const page = await deps.caps.customer.privacy({
      lang: c.req.query("l") ?? null,
      acceptLanguage: c.req.header("accept-language") ?? null,
    });
    return sendPage(c, deps.caps, page, { "Cache-Control": "public, max-age=300" });
  });

  app.get("/:token", async (c) => {
    const page = await deps.caps.customer.linkView(c.req.param("token"), {
      now: now(),
      from: c.req.query("from"),
      acceptLanguage: c.req.header("accept-language") ?? null,
    });
    return sendPage(c, deps.caps, page);
  });

  app.post("/:token", async (c) => {
    const token = c.req.param("token");
    const form = await readForm(c.req.raw);
    const result = await deps.caps.customer.linkAct(token, form, {
      now: now(),
      acceptLanguage: c.req.header("accept-language") ?? null,
    });
    if ("redirect" in result) {
      return new Response(null, { status: 303, headers: { Location: result.redirect, ...CUSTOMER_PAGE_HEADERS } });
    }
    return sendPage(c, deps.caps, result.page);
  });

  return app;
}

/**
 * The page's own form, as a browser posts it (`application/x-www-form-urlencoded`), read to at most
 * `MAX_FORM_BYTES` whatever the request says its length is: a body sent in chunks, with no length,
 * is cut off at the same place. Anything else is no form of ours, and reads as none.
 */
export async function readForm(request: Request): Promise<Record<string, string>> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/x-www-form-urlencoded") || !request.body) return {};
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FORM_BYTES) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FORM_BYTES) {
      await reader.cancel().catch(() => undefined);
      return {};
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  const form: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(new TextDecoder().decode(bytes))) form[k] = v;
  return form;
}

/** The language of a page that has no link to take it from: the browser's, else the business's first. */
export async function pageLang(caps: Capabilities, acceptLanguage: string | null): Promise<CustomerLang> {
  return langFromHeader(acceptLanguage) ?? customerLang(null, (await caps.getBusinessProfile()).languages);
}

/**
 * A customer's page in the business's look (`caps.look`). A page said on an error or a refusal keeps
 * the default look (`renderCustomerPage`), so nothing is read for it.
 */
export async function sendPage(
  c: Context,
  caps: Capabilities,
  page: CustomerPage,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return renderCustomerPage(c, page, headers, await caps.look.view());
}

export function renderCustomerPage(
  c: Context,
  page: CustomerPage,
  headers: Readonly<Record<string, string>> = {},
  look: Look = DEFAULT_LOOK,
): Response {
  // The business's name, else the address the customer typed: never the software's.
  const name = page.business || new URL(c.req.url).host;
  const title = page.title || name;
  // Inside the business's own website (`?embed=1`): the form alone, the site around it is theirs.
  const embed = page.embed === true;
  const body = [
    embed ? "" : `<header><p class="biz">${logoImg(look)}${esc(name)}</p></header>`,
    `<h1>${esc(page.heading)}</h1>`,
    page.error ? `<p class="error" role="alert">${esc(page.error)}</p>` : "",
    ...(page.paragraphs ?? []).map((p) => `<p>${esc(p)}</p>`),
    ...(page.sections ?? []).map(
      (sec) =>
        `<section><h2>${esc(sec.heading)}</h2>${sec.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}${
          sec.links?.length
            ? `<ul>${sec.links.map((l) => `<li><a href="${esc(l.href)}" rel="noopener noreferrer">${esc(l.label)}</a></li>`).join("")}</ul>`
            : ""
        }</section>`,
    ),
    page.rows?.length
      ? `<dl>${page.rows.map((r) => `<div><dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd></div>`).join("")}</dl>`
      : "",
    page.quote ? `<blockquote>${esc(page.quote)}</blockquote>` : "",
    page.form ? formHtml(page.form) : "",
    page.links?.items.length
      ? `<p class="alt">${page.links.lead ? `${esc(page.links.lead)} ` : ""}${page.links.items
          .map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`)
          .join(" · ")}</p>`
      : "",
    page.nav?.length
      ? `<nav>${page.nav.map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join(" · ")}</nav>`
      : "",
    embed ? "" : `<footer><p>${esc(page.footer || name)}</p>${page.help ? `<p>${esc(page.help)}</p>` : ""}</footer>`,
  ]
    .filter(Boolean)
    .join("\n");
  const html = `<!doctype html>
<html lang="${page.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${STYLE}${lookCss(look)}</style>${page.jsonLd ? `\n<script type="application/ld+json">${dataJson(page.jsonLd)}</script>` : ""}
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
  return new Response(html, {
    status: page.status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...CUSTOMER_PAGE_HEADERS, ...headers },
  });
}

/**
 * JSON for a data block in the page: every `<`, `>` and `&`, and the two line separators, written as
 * escapes, so no value can close the block or open markup. A data block is never run.
 */
function dataJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function formHtml(form: NonNullable<CustomerPage["form"]>): string {
  const hidden = Object.entries(form.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  const fields = form.fields.map(fieldHtml).join("\n");
  const action = form.action ? ` action="${esc(form.action)}"` : "";
  // Hidden from people, from screen readers and from password managers; a bot filling every field
  // fills this one too. Its name is drawn for each form (ADR-041 §4.1), so no bot learns it once.
  const trapName = typeof form.trap === "string" ? form.trap : "website";
  const trap = form.trap
    ? `<div class="hp" aria-hidden="true"><label for="${esc(trapName)}">Website</label><input id="${esc(trapName)}" name="${esc(trapName)}" tabindex="-1" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"></div>`
    : "";
  return `<form method="post"${action}>${hidden}\n${fields}\n${trap}<button type="submit">${esc(form.button)}</button></form>`;
}

function fieldHtml(field: PageField, index: number): string {
  if (field.kind === "textarea") {
    const id = `f${index}`;
    return `<label for="${id}">${esc(field.label)}</label><textarea id="${id}" name="${esc(field.name)}" rows="4" maxlength="${field.maxLength}"${field.required ? " required" : ""}>${esc(field.value ?? "")}</textarea>`;
  }
  if (field.kind !== "times") {
    const id = `f${index}`;
    const value = field.value ? ` value="${esc(field.value)}"` : "";
    const auto = field.autocomplete ? ` autocomplete="${esc(field.autocomplete)}"` : "";
    return `<label for="${id}">${esc(field.label)}</label><input id="${id}" type="${field.kind}" name="${esc(field.name)}" maxlength="${field.maxLength}"${value}${auto}${field.required ? " required" : ""}>`;
  }
  if (field.days.length === 0) return `<p class="empty">${esc(field.empty)}</p>`;
  let n = 0;
  return field.days
    .map(
      (d) =>
        `<fieldset><legend>${esc(d.day)}</legend>${d.times
          .map((t) => {
            const id = `t${index}_${n++}`;
            return `<span class="slot"><input type="radio" id="${id}" name="${esc(field.name)}" value="${esc(t.value)}" required><label for="${id}">${esc(t.label)}</label></span>`;
          })
          .join("")}</fieldset>`,
    )
    .join("\n");
}

/** The logo's largest size at the head of a page, in CSS pixels. */
const LOGO_MAX_W = 200;
const LOGO_MAX_H = 40;

/**
 * The logo above the business's name: decoration, so its alt is empty and the name stays the text.
 * From the inbox's own address (`/p/logo/<file>`), the only image a page loads.
 */
function logoImg(look: Look): string {
  if (!look.logo) return "";
  const box = logoBox(look.logo.width, look.logo.height, LOGO_MAX_W, LOGO_MAX_H);
  return `<img src="/p/logo/${esc(look.logo.file)}" alt="" width="${box.width}" height="${box.height}">`;
}

/**
 * The business's look over STYLE, in the same `<style>`: a later `:root` wins over STYLE's own, so
 * STYLE stays as it was, and the default look adds nothing at all.
 *
 * - A theme other than Standard sets its own tones, and its scheme alone: it does not follow the device.
 * - The accent colours buttons, links and the focus ring: its day tone on a light page, its night tone
 *   on a dark one (for Standard, as the device is). Ink is the theme's own ink, the button as it was.
 * - Minimal's button is a thin outline, its weights lighter, its lines 1px.
 */
export function lookCss(look: Look): string {
  if (isDefaultLook(look)) return "";
  const out: string[] = [];
  if (look.theme !== "standard") {
    const t = THEME_TONES[look.theme];
    const a = accentIn(look.accent, t);
    out.push(
      `:root{color-scheme:${t.scheme};--fg:${t.fg};--bg:${t.bg};--muted:${t.muted};--rule:${t.rule};--err:${t.err};--btn:${a.accent};--btn-fg:${a.label};--accent:${a.accent}}`,
    );
  } else if (look.accent !== "ink") {
    const day = accentIn(look.accent, THEME_TONES.standard);
    const night = accentIn(look.accent, STANDARD_NIGHT);
    out.push(
      `:root{--btn:${day.accent};--btn-fg:${day.label};--accent:${day.accent}}`,
      `@media (prefers-color-scheme:dark){:root{--btn:${night.accent};--btn-fg:${night.label};--accent:${night.accent}}}`,
    );
  }
  if (look.accent !== "ink") out.push("a{color:var(--accent)}:focus-visible{outline-color:var(--accent)}");
  if (look.theme === "minimal") {
    out.push(
      "button{background:transparent;color:var(--accent);border:1px solid var(--accent);font-weight:500}",
      ".biz,legend{font-weight:500}blockquote{border-left-width:1px}",
    );
  }
  if (look.logo) out.push(".biz img{display:block;max-width:100%;height:auto;margin:0 0 .5rem}");
  return `\n${out.join("\n")}\n`;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

const STYLE = `
:root{color-scheme:light dark;--fg:#111;--bg:#fff;--muted:#555;--rule:#ddd;--btn:#111;--btn-fg:#fff;--err:#8a1c1c}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#111;--muted:#aaa;--rule:#333;--btn:#eee;--btn-fg:#111;--err:#f19999}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:32rem;margin:0 auto;padding:1.5rem 1rem 3rem}
.biz{font-weight:600;margin:0 0 1.5rem;padding-bottom:.75rem;border-bottom:1px solid var(--rule)}
h1{font-size:1.4rem;line-height:1.3;margin:0 0 1rem}
h2{font-size:1.05rem;margin:1.5rem 0 .5rem}
ul{margin:.5rem 0;padding-left:1.25rem}
dl{margin:1rem 0;border-top:1px solid var(--rule)}
dl div{display:flex;justify-content:space-between;gap:1rem;padding:.5rem 0;border-bottom:1px solid var(--rule)}
dt{color:var(--muted)}dd{margin:0;text-align:right}
blockquote{margin:1rem 0;padding:.25rem 0 .25rem 1rem;border-left:3px solid var(--rule);white-space:pre-wrap}
form{margin:1.5rem 0}
label{display:block;margin:1rem 0 .25rem}
textarea,input[type=text],input[type=email]{width:100%;font:inherit;padding:.5rem;border:1px solid var(--muted);border-radius:4px;background:var(--bg);color:var(--fg)}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
fieldset{border:0;border-top:1px solid var(--rule);margin:0;padding:.75rem 0}
legend{font-weight:600;padding:0}
.slot{display:inline-block;margin:.25rem .5rem .25rem 0}
.slot label{display:inline;margin:0 0 0 .25rem}
button{margin-top:1.25rem;font:inherit;font-weight:600;padding:.75rem 1.25rem;border:0;border-radius:6px;background:var(--btn);color:var(--btn-fg);cursor:pointer}
a{color:inherit}
:focus-visible{outline:3px solid #2b6cb0;outline-offset:2px}
.error{color:var(--err);font-weight:600}
.alt,nav,.empty{margin:1rem 0}
footer{margin-top:2.5rem;padding-top:.75rem;border-top:1px solid var(--rule);color:var(--muted);font-size:.9rem}
footer p{margin:.25rem 0}
`;
