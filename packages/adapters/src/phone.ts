import {
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

/** Tells the owner by email that a phone was connected, so one they did not connect is noticed. */
async function tellOwnerOfPhone(deps: PhoneDoorDeps, userId: string, name: string, origin: string): Promise<void> {
  try {
    const { rows } = await deps.db.client.query({
      sql: "SELECT email FROM users WHERE id = ?",
      params: [userId],
      method: "all",
    });
    const to = rows[0]?.[0];
    if (typeof to !== "string") return;
    const business = await deps.businessName();
    await sendOwnerMail(deps, {
      to,
      subject: `A phone was connected to ${business || "your inbox"}`,
      text: `${name} can now open your inbox and answer it.\n\nIf this wasn't you, remove it now in Settings → Phone:\n${origin}/settings/phone\n`,
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

  const paired = async (c: Context, tokens: Awaited<ReturnType<PhoneCapabilities["pair"]>>) => {
    const me = await phones.me(tokens.device_id);
    await tellOwnerOfPhone(deps, await phones.ownerOf(tokens.device_id), me.phone.name, origin(c));
    return c.json({ ...tokens, inbox: { origin: origin(c), name: me.business.name } }, 201, noStore);
  };

  // A QR code's secret, and the phone's proof, for its first tokens.
  app.post("/pair", async (c) => paired(c, await phones.pair(await body(c), origin(c), clock())));

  // "Email me a sign-in link instead". The same answer whether or not the address is an owner's here.
  app.post("/link", async (c) => {
    const input = await body(c);
    const link = await phones.startLink(
      { email: input.email, challenge: input.challenge, device_key: input.device_key },
      clock(),
    );
    if (link) {
      const at = origin(c);
      await sendOwnerMail(deps, {
        to: link.email,
        subject: "Sign in on your phone",
        text: `Open this on the phone that asked for it, within 15 minutes:\n${signInLinkUri(at, link.secret)}\n\nIf you didn't ask for it, ignore this email: it works only on the phone that asked.\n`,
        what: "phone sign-in email",
      }).catch(() => undefined);
    }
    return c.json(
      { ok: true, message: "If that address signs in here, a link is on its way. Open it on this phone." },
      202,
      noStore,
    );
  });

  app.post("/link/redeem", async (c) => paired(c, await phones.redeemLink(await body(c), origin(c), clock())));

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
    return c.json({ phones: await phones.listPhones(), this: id }, 200, noStore);
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
    return c.json({ phones: await phones.listPhones(), push }, 200, noStore);
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

  app.get("/phones/pairings/:id", async (c) => {
    const owner = await inPerson(c);
    if (owner instanceof Response) return owner;
    return c.json(await phones.pairingStatus(owner.id, String(c.req.param("id")), clock()), 200, noStore);
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
 * `/phone`: what a QR code or a sign-in link opens in a browser. A QR code scanned with the phone's
 * own camera lands here and is told to scan it from the app. A sign-in link opened on the phone gets
 * a button that hands it to the app. The secret is in the fragment, read by this page alone, and
 * never sent anywhere: not to this server, not in a Referer.
 */
export function phonePage(business: string): string {
  const title = business ? esc(business) : "Your inbox";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${title}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:400 15px/1.5 Manrope,ui-sans-serif,system-ui,sans-serif;background:#f6f5ff;color:#14163c}@media(prefers-color-scheme:dark){body{background:#0d0e26;color:#f2f1ff}}
main{width:min(380px,90vw);padding:24px 8px}h1{font:600 22px/1.3 "Plus Jakarta Sans",Manrope,system-ui,sans-serif;margin:0 0 10px}p{margin:0 0 14px;opacity:.75}
a.b{display:none;margin-top:8px;height:48px;border-radius:9999px;background:#14163c;color:#fff;font-weight:600;text-decoration:none;align-items:center;justify-content:center}@media(prefers-color-scheme:dark){a.b{background:#f2f1ff;color:#0d0e26}}</style></head>
<body><main><h1 id="h">Open this in the app</h1><p id="t">On your phone, open the Surfing Dog Inbox app and scan the code from there.</p><a class="b" id="go" href="#">Open in the app</a></main>
<script>(function(){var f=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);var s=f.get("link");if(f.get("v")!=="1"||!s||!/^sdi_pp_[A-Za-z0-9_-]{43}$/.test(s))return;document.getElementById("h").textContent="Sign in on your phone";document.getElementById("t").textContent="Open this on the phone that asked for it.";var a=document.getElementById("go");a.href="${APP_SCHEME}://link?o="+encodeURIComponent(location.origin)+"&s="+s;a.style.display="flex";})();</script></body></html>`;
}
