import {
  type Capabilities,
  type CustomerLang,
  copyFor,
  type FrontForm,
  frontAskAct,
  frontAskView,
  frontBookAct,
  frontBookView,
  frontHome,
  frontSent,
  type LinkActResult,
} from "@surfingdog/core";
import { type Context, Hono } from "hono";
import { pageLang, renderCustomerPage } from "./customer-page";
import { SESSION_COOKIE } from "./session";

/**
 * The business's own page (the web form door, ADR-010), served by the inbox in the business's name:
 * `GET /` for a visitor (the owner, signed in, still gets their app there), and `/p/book`,
 * `/p/quote`, `/p/message`, `/p/sent`. Core builds each page as data; this writes it out with the
 * same renderer, headers and rules as the pages behind the links in its emails — no script, no web
 * font, nothing fetched from anywhere else. A GET never writes; a POST writes once, then sends the
 * browser on (303). The app spends every POST from the same `create` limit as the API's creates
 * (index.ts), and a form whose hidden trap came back filled is thanked and dropped.
 */
export interface FrontPageDeps {
  readonly caps: Capabilities;
  readonly now?: (() => number) | undefined;
}

/** At most this much form to read: the longest field is five thousand characters. */
const MAX_FORM_BYTES = 64 * 1024;

/** Whether a request carries an owner's session cookie: then `/` is their app, not the front page. */
export function hasOwnerSession(request: Request): boolean {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie.split(/;\s*/).some((c) => c.startsWith(`${SESSION_COOKIE}=`) && c.length > SESSION_COOKIE.length + 1);
}

/** `GET /` for a visitor: the front page. */
export async function frontHomePage(deps: FrontPageDeps, c: Context): Promise<Response> {
  const lang = await pageLang(deps.caps, c.req.header("accept-language") ?? null);
  return renderCustomerPage(c, await frontHome(deps.caps, lang), FRONT_HEADERS);
}

/** The front page may be kept a minute by a browser: nothing personal is on it. */
const FRONT_HEADERS: Readonly<Record<string, string>> = { "Cache-Control": "private, max-age=60" };

export function frontPage(deps: FrontPageDeps): Hono {
  const app = new Hono();
  const now = () => (deps.now ? deps.now() : Date.now());
  const langOf = (c: Context) => pageLang(deps.caps, c.req.header("accept-language") ?? null);

  // Whatever went wrong is said in the business's name and the visitor's language, never a stack.
  app.onError(async (_error, c) => {
    const lang = await langOf(c);
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

  app.get("/book", async (c) =>
    renderCustomerPage(
      c,
      await frontBookView(
        deps.caps,
        await langOf(c),
        { service: c.req.query("service"), from: c.req.query("from") },
        { now: now() },
      ),
    ),
  );
  app.get("/quote", async (c) => renderCustomerPage(c, await frontAskView(deps.caps, await langOf(c), "quote")));
  app.get("/message", async (c) => renderCustomerPage(c, await frontAskView(deps.caps, await langOf(c), "message")));
  app.get("/sent", async (c) =>
    renderCustomerPage(c, await frontSent(deps.caps, await langOf(c), c.req.query("k") ?? "")),
  );

  const act =
    (run: (lang: CustomerLang, form: FrontForm) => Promise<LinkActResult>, kind: string) => async (c: Context) => {
      const lang = await langOf(c);
      const form = await readForm(c);
      if (form === null) return c.body(null, 413);
      // A filled trap: thanked like anyone else, and nothing is written.
      if (form.website) return c.redirect(`/p/sent?k=${kind}`, 303);
      const result = await run(lang, form);
      return "redirect" in result ? c.redirect(result.redirect, 303) : renderCustomerPage(c, result.page);
    };

  app.post(
    "/book",
    act((lang, form) => frontBookAct(deps.caps, lang, form, { now: now() }), "booking"),
  );
  app.post(
    "/quote",
    act((lang, form) => frontAskAct(deps.caps, lang, "quote", form, { now: now() }), "quote"),
  );
  app.post(
    "/message",
    act((lang, form) => frontAskAct(deps.caps, lang, "message", form, { now: now() }), "message"),
  );
  return app;
}

/** The form's fields as trimmed strings, or null when it is larger than any form this page sends. */
async function readForm(c: Context): Promise<FrontForm | null> {
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > MAX_FORM_BYTES) return null;
  const text = await c.req.text();
  if (text.length > MAX_FORM_BYTES) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(text)) {
    if (!(k in out)) out[k] = v.trim();
  }
  return out;
}
