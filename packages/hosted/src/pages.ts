/**
 * The router's own answers. None of them names the business or shows anything its owner typed: a
 * stranger who opens an inbox that is not open to agents learns only that it exists. Every page is
 * `noindex`, sends nothing to other sites, and asks a browser to show it as it is.
 */

import { REPORT_PATH } from "./rules";

export interface Answer {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, paragraphs: readonly string[], links: readonly { href: string; text: string }[]): string {
  const p = paragraphs.map((t) => `<p>${t}</p>`).join("\n");
  const a = links.map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.text)}</a>`).join(" · ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;color:#1d2433;background:#fff}
main{max-width:32rem;margin:18vh auto 0;padding:0 1.25rem}
h1{font-size:1.25rem;font-weight:600;margin:0 0 .75rem}
p{margin:0 0 1rem;color:#4a5263}
a{color:#2f5fb3}
nav{margin-top:2rem;font-size:.875rem}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${p}
${a ? `<nav>${a}</nav>` : ""}
</main>
</body>
</html>
`;
}

/** Whether the client asked for a page rather than JSON. */
export function wantsHtml(accept: string | null | undefined): boolean {
  return typeof accept === "string" && accept.includes("text/html");
}

function problem(status: number, code: string, title: string, detail: string): Answer {
  return {
    status,
    headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
    body: JSON.stringify({ type: `https://surfingdog.ai/problems/${code}`, title, status, code, detail }),
  };
}

const report = { href: REPORT_PATH, text: "Report this inbox" };

/** `GET /` on an inbox that is not open to agents, for anyone without the owner's session. */
export function neutralPage(): Answer {
  return {
    status: 200,
    headers: { ...PAGE_HEADERS },
    body: page(
      "This inbox is being set up.",
      ["Only its owner can use it for now."],
      [{ href: "/login", text: "Sign in" }, report],
    ),
  };
}

export function notFound(html: boolean, movedTo?: string | undefined): Answer {
  if (movedTo) {
    const text = `This inbox is at ${movedTo}.`;
    if (!html) return problem(404, "not_found", "Not found", text);
    return {
      status: 404,
      headers: { ...PAGE_HEADERS },
      body: page("This inbox has moved.", [escapeHtml(text)], [{ href: movedTo, text: movedTo }]),
    };
  }
  if (!html) return problem(404, "not_found", "Not found", "Nothing is here.");
  return { status: 404, headers: { ...PAGE_HEADERS }, body: page("Not found", ["Nothing is here."], []) };
}

export function gonePage(html: boolean): Answer {
  if (!html) return problem(410, "gone", "Gone", "This inbox has closed.");
  return { status: 410, headers: { ...PAGE_HEADERS }, body: page("This inbox has closed.", [], [report]) };
}

export function lockedPage(html: boolean, why: "suspended" | "read_only"): Answer {
  const text =
    why === "suspended"
      ? "This inbox is not taking requests right now."
      : "This inbox is closing. It can be read, and nothing new can be sent to it.";
  if (!html) return problem(423, why === "suspended" ? "suspended" : "read_only", "Locked", text);
  return { status: 423, headers: { ...PAGE_HEADERS }, body: page("Not taking requests", [text], [report]) };
}

export function connectingPage(html: boolean): Answer {
  const text = "This inbox is being connected to this address. Try again shortly.";
  const answer = html
    ? { status: 503, headers: { ...PAGE_HEADERS }, body: page("Being connected", [text], []) }
    : problem(503, "connecting", "Being connected", text);
  return { ...answer, headers: { ...answer.headers, "retry-after": "60" } };
}

export function unavailablePage(html: boolean, why: "maintenance" | "unreachable"): Answer {
  const text =
    why === "maintenance"
      ? "This inbox is under maintenance. Try again later."
      : "This inbox could not be reached just now. Try again shortly.";
  const answer = html
    ? { status: 503, headers: { ...PAGE_HEADERS }, body: page("Not available", [text], []) }
    : problem(503, why === "maintenance" ? "maintenance" : "unavailable", "Not available", text);
  return { ...answer, headers: { ...answer.headers, "retry-after": "120" } };
}

export function badHost(): Answer {
  return problem(400, "bad_host", "Bad request", "The Host header is not a name this server answers.");
}

/** `robots.txt` on a slug host: nothing there is for indexing. */
export function robotsTxt(): Answer {
  return {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
    body: "User-agent: *\nDisallow: /\n",
  };
}

/**
 * `/.well-known/security.txt` (RFC 9116) for every inbox here: where to report a security problem
 * with this service, not with the business, whose inbox it is.
 */
export function securityTxt(o: { readonly host: string; readonly contact: string; readonly now: number }): Answer {
  const expires = new Date(o.now + 365 * 86_400_000);
  expires.setUTCHours(0, 0, 0, 0);
  const contact = /^(https:|mailto:)/.test(o.contact) ? o.contact : `mailto:${o.contact}`;
  return {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" },
    body: [
      `Contact: ${contact}`,
      `Expires: ${expires.toISOString()}`,
      "Preferred-Languages: en",
      `Canonical: https://${o.host}/.well-known/security.txt`,
      "",
    ].join("\n"),
  };
}

/** "Report this inbox": where to write, with this inbox's address already in the subject. */
export function reportPage(o: { readonly host: string; readonly abuse: string }): Answer {
  const subject = encodeURIComponent(`Report: https://${o.host}`);
  const mailto = `mailto:${o.abuse}?subject=${subject}`;
  return {
    status: 200,
    headers: { ...PAGE_HEADERS },
    body: page(
      "Report this inbox",
      [
        `To report this inbox (https://${escapeHtml(o.host)}) for spam, impersonation, illegal content or anything else, write to <a href="${escapeHtml(mailto)}">${escapeHtml(o.abuse)}</a>.`,
        "Say what you saw, and when.",
      ],
      [],
    ),
  };
}
