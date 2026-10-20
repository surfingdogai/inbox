import {
  ANDROID_APP_URL,
  APP_ID,
  APP_SCHEME,
  type Capabilities,
  type PhoneCapabilities,
  pairingUri,
  signInLinkUri,
  WriteError,
} from "@surfingdog/core";
import { type Context, Hono } from "hono";
import { publicOrigin } from "./origin";
import { problemResponse, unauthorized } from "./problem";
import type { CallerEnv } from "./rest";
import { type OwnerMailDeps, sendOwnerMail } from "./session";
import { ownerInPerson } from "./step-up";

/**
 * The phone app's doors (ADR-026).
 *
 * `/v1/phone/*` is the phone's own: pairing with a QR code's secret, the emailed sign-in link and its
 * redemption, token refresh (each signed by the phone's device key), and, with a phone's access
 * token, what it hears about and how push reaches it. `/v1/owner/phones*` is the owner app's
 * Settings → Phone, for the owner signed in on a computer only: a QR code, the phones, a test, and
 * removing one. The phone uses the owner's door for the inbox itself, held to `PHONE_OPERATIONS`.
 */
export interface PhoneDoorDeps extends OwnerMailDeps {
  readonly caps: Capabilities;
  readonly baseUrl?: string | undefined;
  readonly now?: (() => number) | undefined;
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const parsed = (await c.req.json().catch(() => null)) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

const noStore = { "Cache-Control": "no-store" } as const;

/** Runs work after the answer is sent: the Worker's waitUntil, or on its own on Node. Never throws. */
function later(c: Context, work: () => Promise<unknown>): void {
  const settled = work().catch(() => undefined);
  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    // No execution context (Node): the promise runs on by itself.
  }
}

/** Roughly where a request came from, as the edge names its country; nothing when it does not. */
function roughly(c: Context): string | null {
  const code = (c.req.header("cf-ipcountry") ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === "XX" || code === "T1") return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? null;
  } catch {
    return null;
  }
}

/**
 * Tells the owner by email that a phone was connected, so one they did not connect is noticed and
 * removed at once. The phone's name is the phone's own say, so it is quoted, never taken as fact.
 */
async function tellOwnerOfPhone(
  deps: PhoneDoorDeps,
  userId: string,
  phone: { name: string; platform: string },
  origin: string,
  how: { confirmed: boolean; from: string | null; at: number },
): Promise<void> {
  try {
    const { rows } = await deps.db.client.query({
      sql: "SELECT email FROM users WHERE id = ?",
      params: [userId],
      method: "all",
    });
    const to = rows[0]?.[0];
    if (typeof to !== "string") return;
    const business = await deps.businessName();
    const when = new Date(how.at).toUTCString().replace(" GMT", " UTC");
    const device = phone.platform === "ios" ? "iPhone" : "Android phone";
    const lines = [
      `Not you? Remove it now in Settings → Phone:`,
      `${origin}/settings/phone`,
      "",
      `A phone was connected to ${business || "your inbox"}. It can now open your inbox and answer it.`,
      "",
      `Phone: "${phone.name.replace(/"/g, "'")}" (as the phone names itself), an ${device}`,
      `When: ${when}`,
      ...(how.from ? [`From: roughly ${how.from}`] : []),
      how.confirmed
        ? "How: you confirmed it on your computer, in Settings → Phone."
        : "How: a sign-in link sent to this address.",
    ];
    await sendOwnerMail(deps, {
      to,
      subject: `A phone was connected to ${business || "your inbox"}`,
      text: `${lines.join("\n")}\n`,
      what: "phone-connected email",
    });
  } catch {
    // The owner sees every phone in Settings → Phone whether or not this arrives.
  }
}

export function phoneRoutes(deps: PhoneDoorDeps): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  const phones: PhoneCapabilities = deps.caps.phones;
  const clock = () => (deps.now ? deps.now() : Date.now());
  const origin = (c: Context) => publicOrigin(c.req.raw, deps.baseUrl);
  app.onError((error, c) => problemResponse(c, error));

  // A QR code's secret, and the phone's proof, for its first tokens. The phone then waits for the
  // owner's Confirm on the computer, showing the same two digits; its tokens open nothing until then.
  app.post("/pair", async (c) => {
    const tokens = await phones.pair(await body(c), origin(c), clock());
    const me = await phones.me(tokens.device_id);
    return c.json({ ...tokens, inbox: { origin: origin(c), name: me.business.name } }, 201, noStore);
  });

  // "Email me a sign-in link instead". The same answer, at once, whether or not the address is an
  // owner's here: the email goes after the answer, so neither the words nor the time tell.
  app.post("/link", async (c) => {
    const input = await body(c);
    const link = await phones.startLink(
      { email: input.email, challenge: input.challenge, device_key: input.device_key },
      clock(),
    );
    if (link) {
      const at = origin(c);
      later(c, () =>
        sendOwnerMail(deps, {
          to: link.email,
          subject: "Sign in on your phone",
          text: `Open this on the phone that asked for it, within 15 minutes:\n${signInLinkUri(at, link.secret)}\n\nIf you didn't ask for it, ignore this email: it works only on the phone that asked.\n`,
          what: "phone sign-in email",
        }),
      );
    }
    return c.json(
      { ok: true, message: "If that address signs in here, a link is on its way. Open it on this phone." },
      202,
      noStore,
    );
  });

  // The emailed link, redeemed by the phone that asked: the mailbox was the proof, nothing to confirm.
  app.post("/link/redeem", async (c) => {
    const now = clock();
    const tokens = await phones.redeemLink(await body(c), origin(c), now);
    const me = await phones.me(tokens.device_id);
    const userId = await phones.ownerOf(tokens.device_id);
    const from = roughly(c);
    later(c, () => tellOwnerOfPhone(deps, userId, me.phone, origin(c), { confirmed: false, from, at: now }));
    return c.json(
      { ...tokens, state: "connected", inbox: { origin: origin(c), name: me.business.name } },
      201,
      noStore,
    );
  });

  // A new access token for the refresh token, signed for by the phone.
  app.post("/token", async (c) => {
    const input = await body(c);
    return c.json(
      await phones.refresh(
        { refresh_token: input.refresh_token, proof: input.proof, at: input.at },
        origin(c),
        clock(),
      ),
      200,
      noStore,
    );
  });

  // From here on, a phone signed in: its access token.
  const device = (c: Context<CallerEnv>): string | Response => {
    const p = c.get("caller")?.principal;
    if (p?.via !== "device") return unauthorized(c, "Send this phone's access token.");
    return p.id;
  };

  app.get("/me", async (c) => {
    const id = device(c);
    if (typeof id !== "string") return id;
    return c.json({ ...(await phones.me(id)), origin: origin(c) }, 200, noStore);
  });

  app.put("/notify", async (c) => {
    const id = device(c);
    if (typeof id !== "string") return id;
    return c.json({ notify: await phones.setNotify(id, await body(c)) }, 200, noStore);
  });

  app.put("/push", async (c) => {
    const id = device(c);
    if (typeof id !== "string") return id;
    const input = await body(c);
    return c.json(
      await phones.registerPush(id, { token: input.token, p256dh: input.p256dh, auth: input.auth }, origin(c), clock()),
      200,
      noStore,
    );
  });

  app.post("/test", async (c) => {
    const id = device(c);
    if (typeof id !== "string") return id;
    return c.json(await phones.sendTest(id, clock()), 200, noStore);
  });

  // The owner's phones, from one of them (Settings → Notifications → Phones): a lost one is removed
  // from another as from the computer.
  app.get("/phones", async (c) => {
    const id = device(c);
    if (typeof id !== "string") return id;
    // Only this phone's person's phones: the ones it may remove.
    return c.json({ phones: await phones.listPhones(await phones.ownerOf(id)), this: id }, 200, noStore);
  });

  app.delete("/phones/:id", async (c) => {
    const id = device(c);
    if (typeof id !== "string") return id;
    const other = String(c.req.param("id"));
    // Only a phone of the same person: the owner's phones, never a colleague's.
    if ((await phones.ownerOf(other)) !== (await phones.ownerOf(id)))
      return problemResponse(c, new WriteError("not_found", "No such phone here."));
    return c.json(await phones.removePhone(other, clock()), 200, noStore);
  });

  // "Remove this inbox" on the phone: it signs itself out here, and the relay forgets it.
  app.delete("/", async (c) => {
    const id = device(c);
    if (typeof id !== "string") return id;
    return c.json(await phones.removePhone(id, clock()), 200, noStore);
  });

  return app;
}

/** Settings → Phone in the owner app: the owner signed in, in person, in this browser. */
export function ownerPhoneRoutes(deps: PhoneDoorDeps): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  const phones = deps.caps.phones;
  const clock = () => (deps.now ? deps.now() : Date.now());
  app.onError((error, c) => problemResponse(c, error));
  const inPerson = (c: Context) => ownerInPerson(c, { db: deps.db, baseUrl: deps.baseUrl, now: deps.now });

  app.get("/phones", async (c) => {
    const owner = await inPerson(c);
    if (owner instanceof Response) return owner;
    const push = phones.pushAvailability();
    return c.json({ phones: await phones.listPhones(), push, get_app: ANDROID_APP_URL }, 200, noStore);
  });

  app.post("/phones/pairings", async (c) => {
    const owner = await inPerson(c);
    if (owner instanceof Response) return owner;
    const made = await phones.createPairing(owner.id, clock());
    return c.json(
      {
        id: made.id,
        qr: pairingUri(publicOrigin(c.req.raw, deps.baseUrl), made.secret),
        expires_at: new Date(made.expiresAt).toISOString(),
      },
      201,
      noStore,
    );
  });

  // What became of the code: waiting, a phone waiting for Confirm (with the two digits it shows), done.
  app.get("/phones/pairings/:id", async (c) => {
    const owner = await inPerson(c);
    if (owner instanceof Response) return owner;
    return c.json(await phones.pairingStatus(owner.id, String(c.req.param("id")), clock()), 200, noStore);
  });

  // "Confirm": the phone showing the same two digits may now open the inbox.
  app.post("/phones/pairings/:id/confirm", async (c) => {
    const owner = await inPerson(c);
    if (owner instanceof Response) return owner;
    const now = clock();
    const phone = await phones.confirmPairing(owner.id, String(c.req.param("id")), now);
    const at = publicOrigin(c.req.raw, deps.baseUrl);
    later(c, () => tellOwnerOfPhone(deps, owner.id, phone, at, { confirmed: true, from: null, at: now }));
    return c.json({ state: "paired", phone }, 200, noStore);
  });

  // "Not mine": the phone that used the code is removed before it could do anything.
  app.post("/phones/pairings/:id/refuse", async (c) => {
    const owner = await inPerson(c);
    if (owner instanceof Response) return owner;
    return c.json(await phones.refusePairing(owner.id, String(c.req.param("id")), clock()), 200, noStore);
  });

  app.post("/phones/:id/test", async (c) => {
    const owner = await inPerson(c);
    if (owner instanceof Response) return owner;
    return c.json(await phones.sendTest(String(c.req.param("id")), clock()), 200, noStore);
  });

  app.delete("/phones/:id", async (c) => {
    const owner = await inPerson(c);
    if (owner instanceof Response) return owner;
    return c.json(await phones.removePhone(String(c.req.param("id")), clock()), 200, noStore);
  });

  return app;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);

/**
 * `/phone`: what a QR code or a sign-in link opens in a browser. On an Android phone it offers "Open in
 * the app": an `intent://` link pinned to the app's package, so the secret goes to the Surfing Dog
 * Inbox app and to no other app, and the browser opens the page that says how to get the app when it
 * is not installed. Anywhere else it says to scan the code from the app. The secret is in the fragment,
 * read by this page alone, and never sent anywhere: not to this server, not in a Referer.
 */
export function phonePage(business: string): string {
  const title = business ? esc(business) : "Your inbox";
  const get = ANDROID_APP_URL ? JSON.stringify(ANDROID_APP_URL) : "null";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${title}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:400 15px/1.5 Manrope,ui-sans-serif,system-ui,sans-serif;background:#f6f5ff;color:#14163c}@media(prefers-color-scheme:dark){body{background:#0d0e26;color:#f2f1ff}}
main{width:min(380px,90vw);padding:24px 8px}h1{font:600 22px/1.3 "Plus Jakarta Sans",Manrope,system-ui,sans-serif;margin:0 0 10px}p{margin:0 0 14px;opacity:.75}small{display:block;margin-top:14px;opacity:.6;font-size:13px}
a.b{display:none;margin-top:8px;height:48px;border-radius:9999px;background:#14163c;color:#fff;font-weight:600;text-decoration:none;align-items:center;justify-content:center}a.q{display:none;color:inherit;font-weight:600}@media(prefers-color-scheme:dark){a.b{background:#f2f1ff;color:#0d0e26}}</style></head>
<body><main><h1 id="h">Open this in the app</h1><p id="t">On your phone, open the Surfing Dog Inbox app and scan the code from there.</p><a class="b" id="go" href="#">Open in the app</a><a class="q" id="get" href="#">Get it for Android</a><small id="s"></small></main>
<script>(function(){var f=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);var G=${get};var h=document.getElementById("h"),t=document.getElementById("t"),s=document.getElementById("s"),g=document.getElementById("get");
function getApp(){if(G){g.href=G;g.style.display="inline";}s.textContent="iPhone soon.";}
if(f.get("app")==="missing"){h.textContent="The app isn't on this phone yet";t.textContent=G?"Get Surfing Dog Inbox for Android, then scan the code again.":"Surfing Dog Inbox for Android isn't in the Play Store yet.";getApp();return;}
var k=f.get("pair")?"pair":f.get("link")?"link":null;var x=k&&f.get(k);if(f.get("v")!=="1"||!x||!/^sdi_pp_[A-Za-z0-9_-]{43}$/.test(x))return;
if(k==="link"){h.textContent="Sign in on your phone";t.textContent="Open this on the phone that asked for it.";}else{h.textContent="Connect this phone";t.textContent="Opens the Surfing Dog Inbox app. Nothing to type.";}
if(!/Android/i.test(navigator.userAgent)){t.textContent=k==="link"?"Open this link on the phone that asked for it.":"On your phone, open the Surfing Dog Inbox app and scan the code from there.";getApp();return;}
var back=G||(location.origin+location.pathname+"#v=1&app=missing");var a=document.getElementById("go");
a.href="intent://"+k+"?o="+encodeURIComponent(location.origin)+"&s="+x+"#Intent;scheme=${APP_SCHEME};package=${APP_ID};S.browser_fallback_url="+encodeURIComponent(back)+";end";a.style.display="flex";})();</script></body></html>`;
}
