import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * The pages a link in an owner's email opens: a sign-in link, a host's handoff, an address change
 * and its undo. Each shows what pressing its button would do and changes nothing itself, since mail
 * scanners open every link in an email; only the POST its form sends acts. No script, nothing
 * fetched from anywhere else, and no Referer: the address the page was opened at carries the token.
 */
export interface AuthPage {
  readonly title: string;
  readonly heading: string;
  /** Sentences under the heading, as plain text. */
  readonly lines?: readonly string[];
  /** The one thing to do here: a POST to `action` with `fields`, by a button. */
  readonly form?: {
    readonly action: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly button: string;
  };
  /** A link onwards instead, or after the form: back to the owner app. */
  readonly link?: { readonly href: string; readonly label: string };
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);

export function authPageHtml(page: AuthPage): string {
  const lines = (page.lines ?? []).map((l) => `<p>${esc(l)}</p>`).join("");
  const form = page.form
    ? `<form method="post" action="${esc(page.form.action)}">${Object.entries(page.form.fields)
        .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
        .join("")}<button class="primary" type="submit">${esc(page.form.button)}</button></form>`
    : "";
  const link = page.link ? `<p class="note"><a href="${esc(page.link.href)}">${esc(page.link.label)}</a></p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${esc(page.title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Manrope,ui-sans-serif,system-ui,sans-serif;background:#f6f5ff;color:#14163c}@media(prefers-color-scheme:dark){body{background:#0d0e26;color:#f2f1ff}}
.card{width:min(460px,92vw);padding:28px 24px;border-radius:20px;background:rgba(255,255,255,.44);border:1px solid rgba(255,255,255,.6);backdrop-filter:blur(26px) saturate(150%);box-shadow:0 8px 24px -16px rgba(20,90,140,.22)}@media(prefers-color-scheme:dark){.card{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.14)}}
h1{font-size:20px;margin:0 0 10px;overflow-wrap:anywhere}p{margin:0 0 14px;opacity:.8;overflow-wrap:anywhere}.note{font-size:14px}a{color:inherit}
button{width:100%;height:44px;border-radius:9999px;border:1px solid transparent;font:600 15px Manrope,system-ui,sans-serif;cursor:pointer}.primary{background:#14163c;color:#fff}@media(prefers-color-scheme:dark){.primary{background:#f2f1ff;color:#0d0e26}}form{margin:0 0 14px}</style></head>
<body><main class="card"><h1>${esc(page.heading)}</h1>${lines}${form}${link}</main></body></html>`;
}

/** The page as a response that no cache keeps: it may carry a token in its form. */
export function authPage(c: Context, status: ContentfulStatusCode, page: AuthPage): Response {
  return c.html(authPageHtml(page), status, { "Cache-Control": "no-store" });
}
