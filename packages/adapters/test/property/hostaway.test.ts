import {
  type ConnectContext,
  ConnectorError,
  describeForm,
  type InboundRequest,
  isPropertySystem,
  type OutboundStay,
  type RunContext,
} from "@surfingdog/core";
import { afterEach, describe, expect, it } from "vitest";
import { builtInConnectors } from "../../src/connectors/index";
import {
  HOSTAWAY_HOSTS,
  hostawayBackoffMs,
  hostawayConnector,
  hostawayForm,
  hostawayMinor,
  hostawayRetryAfterMs,
  newHookCredentials,
} from "../../src/connectors/property/hostaway";
import { type HostawayFake, hostawayFake } from "../fakes/property/hostaway";
import {
  CLIENT_SECRET,
  HOBART_ACCOUNT,
  JAPAN_ACCOUNT,
  OTHER_SECRET,
  PARATY_ACCOUNT,
  REYKJAVIK_ACCOUNT,
} from "../fixtures/property/hostaway/auth";
import {
  type FakeListing,
  HARBOURLIGHT,
  JAPAN,
  MIXED,
  PARATY,
  REYKJAVIK,
} from "../fixtures/property/hostaway/listings";
import { unifiedLogObject } from "../fixtures/property/hostaway/webhooks";
import { propertyContract, runContext } from "./contract";

/**
 * Hostaway's adapter (ADR-033 §8) against its fake, built from Hostaway's own documentation (the
 * fixtures' headers keep each excerpt): the property system contract for three places, then what is
 * Hostaway's own: a token fetched again on a 403 at most once a run and used 1.5 s after it is issued,
 * a 403 on a fresh token read as a refusal, the wait read as a Unix time and doubled for a 429 close
 * after another, listings as one-unit rooms grouped by currency, zone and town under an id made of
 * their first listing's id, currency and zone, money in each currency's own minor unit (ISK and JPY
 * have none) and a stay's price less its discounts, stays checked live before they are written and
 * read back after (a reservation of ours holding no nights is never sound; blocked units are not
 * capacity), a stay of several rooms written as one reservation each, whole or not at all, the
 * webhook's login and password checked in constant time, webhooks out of order and twice and read by
 * what they are about, and nothing sent anywhere but Hostaway's API, never a card, a commission or
 * `forceOverbooking`.
 */

const HOOK_URL = "https://inbox.harbourlight.example/v1/hooks/hostaway/Q2hvb3NlLWEtdG9rZW4tZm9yLXRoZS1jb25uZWN0aW9u";

/** Each property's id: its first listing's id, currency and zone. */
const HOBART = "310021@AUD@Australia/Hobart";
const PARATY_ID = "420101@BRL@America/Sao_Paulo";
const REYKJAVIK_ID = "530301@ISK@Atlantic/Reykjavik";
const OSAKA = "640501@JPY@Asia/Tokyo";

const fakes: HostawayFake[] = [];

afterEach(() => {
  // Whatever a test did, Hostaway was never sent forceOverbooking, a card, a commission or a delete.
  for (const f of fakes.splice(0)) expect(f.violations).toEqual([]);
});

interface Connection {
  readonly fake: HostawayFake;
  readonly def: ReturnType<typeof hostawayConnector>;
  readonly secret: Record<string, string>;
  readonly saved: Record<string, string>[];
  ctx(o?: Partial<RunContext>): RunContext;
}

function connection(listings: readonly FakeListing[], accountId = HOBART_ACCOUNT): Connection {
  const fake = hostawayFake({ accountId, clientSecret: CLIENT_SECRET, listings });
  fakes.push(fake);
  const def = hostawayConnector({ wait: (ms) => fake.wait(ms), random: () => 0 });
  const hook = newHookCredentials();
  const secret: Record<string, string> = {
    account_id: accountId,
    client_secret: CLIENT_SECRET,
    access_token: fake.issue(),
    hook_login: hook.login,
    hook_password: hook.password,
  };
  const saved: Record<string, string>[] = [];
  return {
    fake,
    def,
    secret,
    saved,
    ctx(o = {}) {
      return {
        ...runContext(fake.platform.http, secret, fake.clock.now),
        async saveSecret(next) {
          saved.push({ ...next });
        },
        ...o,
      };
    },
  };
}

function stayOf(
  listing: string,
  checkIn: string,
  checkOut: string,
  o: {
    key?: string;
    value?: number;
    currency?: string;
    propertyId?: string;
    guest?: OutboundStay["guest"];
    adults?: number;
    childrenAges?: number[];
    notes?: string;
  } = {},
): OutboundStay {
  return {
    itemId: "01JHOSTAWAYSTAY0000000000",
    reference: "HB7Q2K",
    key: o.key ?? "sd-01JHOSTAWAYSTAY0000000000",
    propertyId: o.propertyId ?? HOBART,
    checkIn,
    checkOut,
    rooms: [
      {
        roomId: listing,
        rateId: "nightly",
        adults: o.adults ?? 2,
        childrenAges: o.childrenAges ?? [],
        price: { value: o.value ?? 55_100, currency: o.currency ?? "AUD" },
      },
    ],
    ...(o.guest ? { guest: o.guest } : {}),
    ...(o.notes ? { notes: o.notes } : {}),
  };
}

function writer(c: Connection) {
  const w = c.def.stayWriter;
  if (!w) throw new Error("no writer");
  return w;
}

function rowsOf(read: Awaited<ReturnType<NonNullable<ReturnType<typeof hostawayConnector>["stays"]>["ari"]>>) {
  return Array.isArray(read) ? read : read.rows;
}

function stays(c: Connection) {
  const s = c.def.stays;
  if (!s) throw new Error("no stays");
  return s;
}

function bodies(c: Connection, method: string, path: string): Record<string, unknown>[] {
  return c.fake.platform
    .requests(method, `https://api.hostaway.com/v1${path}`)
    .map((r) => JSON.parse(r.body || "{}") as Record<string, unknown>);
}

/* --- the contract, for three places ---------------------------------------------- */

const contract = (listings: readonly FakeListing[], accountId: string, propertyId: string, room: string) => () => {
  const c = connection(listings, accountId);
  return {
    definition: c.def as never,
    http: c.fake.platform.http,
    secret: c.secret,
    propertyId,
    oneUnitRoom: room,
    rate: "nightly",
    oversells: false,
  };
};

propertyContract(
  "Hostaway, Harbourlight Apartments (Hobart, AUD)",
  contract(HARBOURLIGHT, HOBART_ACCOUNT, HOBART, "310021"),
);
propertyContract("Hostaway, a pousada in Paraty (BRL)", contract(PARATY, PARATY_ACCOUNT, PARATY_ID, "420101"));
propertyContract(
  "Hostaway, a guesthouse in Reykjavík (ISK)",
  contract(REYKJAVIK, REYKJAVIK_ACCOUNT, REYKJAVIK_ID, "530301"),
);

/* --- connecting ----------------------------------------------------------------------- */

describe("Hostaway: connecting with the owner's account ID and API key", () => {
  const connectCtx = (fake: HostawayFake, o: Partial<ConnectContext> = {}): ConnectContext => ({
    http: fake.platform.http,
    now: fake.clock.now,
    inbox: runContext(fake.platform.http, {}).inbox,
    hookUrl: HOOK_URL,
    hooksLive: true,
    ...o,
  });

  it("is registered as a property system, ready, in the lodging group", () => {
    const def = builtInConnectors({}).find((d) => d.kind === "hostaway");
    expect(def).toBeDefined();
    expect(isPropertySystem(def)).toBe(true);
    expect(def?.group).toBe("lodging");
    expect(def?.ready?.() ?? true).toBe(true);
    expect(def?.capabilities).toEqual(["stay_inventory", "write_stays", "stay_events"]);
  });

  it("exchanges them for a token, used only a second after it is issued, and makes its own webhook", async () => {
    const fake = hostawayFake({ accountId: HOBART_ACCOUNT, clientSecret: CLIENT_SECRET, listings: HARBOURLIGHT });
    fakes.push(fake);
    const def = hostawayConnector({ wait: (ms) => fake.wait(ms) });
    const got = await def.connect?.(connectCtx(fake), {
      account_id: ` ${HOBART_ACCOUNT} `,
      client_secret: CLIENT_SECRET,
    });
    if (!got) throw new Error("no connection");
    expect(got.externalId).toBe(HOBART_ACCOUNT);
    expect(got.account).toBe(`Hostaway account ${HOBART_ACCOUNT}`);
    expect(Object.keys(got.secret).sort()).toEqual([
      "access_token",
      "account_id",
      "client_secret",
      "hook_login",
      "hook_password",
      "token_at",
    ]);
    // "Valid 1 second after being returned": used after 1.5.
    expect(fake.waits).toContain(1_500);
    // The form, as documented: client credentials, the account ID as the client, scope general.
    const [token] = fake.platform.requests("POST", "https://api.hostaway.com/v1/accessTokens");
    const form = new URLSearchParams(token?.body ?? "");
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "client_credentials",
      client_id: HOBART_ACCOUNT,
      client_secret: CLIENT_SECRET,
      scope: "general",
    });
    expect(token?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    // One unified webhook at the connection's own address, with the login and password just sealed.
    const hooks = [...fake.webhooks.values()];
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      url: HOOK_URL,
      isEnabled: 1,
      login: got.secret.hook_login,
      password: got.secret.hook_password,
    });
    expect(got.extra).toMatchObject({ webhookId: String(hooks[0]?.id), hookUrl: HOOK_URL });
    expect(got.secret.hook_password?.length).toBeGreaterThanOrEqual(40);
  });

  it("makes no webhook when the inbox is not reachable yet, and makes it on a later refresh", async () => {
    const fake = hostawayFake({ accountId: HOBART_ACCOUNT, clientSecret: CLIENT_SECRET, listings: HARBOURLIGHT });
    fakes.push(fake);
    const def = hostawayConnector({ wait: (ms) => fake.wait(ms) });
    const got = await def.connect?.(connectCtx(fake, { hooksLive: false }), {
      account_id: HOBART_ACCOUNT,
      client_secret: CLIENT_SECRET,
    });
    if (!got) throw new Error("no connection");
    expect(fake.webhooks.size).toBe(0);
    const ctx: RunContext = {
      ...runContext(fake.platform.http, got.secret, fake.clock.now + 7 * 3_600_000),
      hookUrl: HOOK_URL,
      extra: got.extra ?? {},
    };
    expect(def.stale?.(ctx)).toBe(true);
    const fresh = await def.refresh?.(ctx);
    expect(fake.webhooks.size).toBe(1);
    expect(fresh?.extra).toMatchObject({ hookUrl: HOOK_URL });
    const after: RunContext = { ...ctx, extra: fresh?.extra ?? {} };
    expect(def.stale?.(after)).toBe(false);
    // Disabled by Hostaway ("webhooks that fail for 5 consecutive days"): the next refresh turns it on again.
    const [hook] = fake.webhooks.values();
    if (hook) hook.isEnabled = 0;
    await def.refresh?.(after);
    expect([...fake.webhooks.values()].map((w) => w.isEnabled)).toEqual([1]);
    // The inbox moved to its own domain: one webhook at the new address, none left at the old one.
    const moved = "https://stay.harbourlight.example/v1/hooks/hostaway/Q2hvb3NlLWEtdG9rZW4tZm9yLXRoZS1jb25uZWN0aW9u";
    const there: RunContext = { ...after, hookUrl: moved };
    expect(def.stale?.(there)).toBe(true);
    await def.refresh?.(there);
    expect([...fake.webhooks.values()].map((w) => w.url)).toEqual([moved]);
  });

  it("gives an existing webhook a login made again, and keeps the old one until a new address takes one", async () => {
    const c = connection(HARBOURLIGHT);
    const def = c.def;
    const first = await def.refresh?.({ ...c.ctx(), hookUrl: HOOK_URL });
    const extra = first?.extra ?? {};
    const [hook] = [...c.fake.webhooks.values()];
    // The sealed login lost (a secret saved before webhooks): a new one is made and given to Hostaway.
    const bare = { ...c.secret, hook_login: "", hook_password: "" };
    await def.refresh?.({ ...c.ctx(), secret: bare, hookUrl: HOOK_URL, extra });
    const sealed = c.saved.at(-1);
    expect(sealed?.hook_login).toBeTruthy();
    expect(c.fake.webhooks.size).toBe(1);
    expect(hook).toMatchObject({ login: sealed?.hook_login, password: sealed?.hook_password });
    // A new address that will not take a webhook yet: the old one stays, and is tried again later.
    const moved = "https://stay.harbourlight.example/v1/hooks/hostaway/Q2hvb3NlLWEtdG9rZW4tZm9yLXRoZS1jb25uZWN0aW9u";
    c.fake.platform.fail("POST", "https://api.hostaway.com/v1/webhooks/unifiedWebhooks", 404);
    const there: RunContext = { ...c.ctx(), hookUrl: moved, extra };
    const failed = await def.refresh?.(there);
    expect(failed?.extra).toMatchObject({ webhookId: String(hook?.id), hookUrl: HOOK_URL, webhookFailed: true });
    expect([...c.fake.webhooks.values()].map((w) => w.url)).toEqual([HOOK_URL]);
    const after: RunContext = { ...there, extra: failed?.extra ?? {} };
    expect(def.stale?.(after)).toBe(false);
    const later: RunContext = { ...after, now: after.now + 7 * 3_600_000 };
    expect(def.stale?.(later)).toBe(true);
    await def.refresh?.(later);
    expect([...c.fake.webhooks.values()].map((w) => w.url)).toEqual([moved]);
  });

  it("refuses a wrong key on the key's own field, and a typed account ID that is not one", async () => {
    const fake = hostawayFake({ accountId: HOBART_ACCOUNT, clientSecret: CLIENT_SECRET, listings: HARBOURLIGHT });
    fakes.push(fake);
    const def = hostawayConnector({ wait: (ms) => fake.wait(ms) });
    await expect(
      def.connect?.(connectCtx(fake), { account_id: HOBART_ACCOUNT, client_secret: OTHER_SECRET }),
    ).rejects.toMatchObject({ code: "auth", field: "client_secret" });
    // An account ID as Hostaway gives it: digits, never a leading zero (a webhook's accountId would never match).
    for (const typed of ["acct-70412", "070412", ""]) {
      await expect(
        def.connect?.(connectCtx(fake), { account_id: typed, client_secret: CLIENT_SECRET }),
      ).rejects.toMatchObject({
        code: "config",
        field: "account_id",
      });
    }
    expect(fake.webhooks.size).toBe(0);
  });

  it("names the key as Hostaway will list it, and says where to delete it", () => {
    const def = hostawayConnector();
    const [account] = describeForm(hostawayForm);
    const steps = account?.steps;
    expect(account).toMatchObject({ key: "account_id", link: { text: "Open Hostaway" } });
    expect(account?.placeholder).toBeUndefined();
    expect(steps?.[0]).toBe("Open Hostaway → Settings → Hostaway API → Create.");
    expect(steps?.[1]).toBe("Name it Surfing Dog Inbox and pick Hostaway Public API as the partner.");
    expect(def.disconnectNote).toBe(
      "To end it in Hostaway too, delete the Surfing Dog Inbox key in Settings → Hostaway API.",
    );
  });

  it("takes back the webhook of a connection that was refused, and the old one of a connection made again", async () => {
    const fake = hostawayFake({ accountId: HOBART_ACCOUNT, clientSecret: CLIENT_SECRET, listings: HARBOURLIGHT });
    fakes.push(fake);
    const def = hostawayConnector({ wait: (ms) => fake.wait(ms) });
    const first = await def.connect?.(connectCtx(fake), { account_id: HOBART_ACCOUNT, client_secret: CLIENT_SECRET });
    await first?.settle?.(true);
    const again = await def.connect?.(
      connectCtx(fake, { previous: { externalId: HOBART_ACCOUNT, extra: first?.extra ?? {} } }),
      { account_id: HOBART_ACCOUNT, client_secret: CLIENT_SECRET },
    );
    expect(fake.webhooks.size).toBe(2);
    await again?.settle?.(true);
    expect([...fake.webhooks.keys()].map(String)).toEqual([again?.extra?.webhookId]);
    const refused = await def.connect?.(connectCtx(fake), { account_id: HOBART_ACCOUNT, client_secret: CLIENT_SECRET });
    await refused?.settle?.(false);
    expect([...fake.webhooks.keys()].map(String)).toEqual([again?.extra?.webhookId]);
  });

  it("gives the access back when disconnected: its webhook removed, its token revoked", async () => {
    const c = connection(HARBOURLIGHT);
    const made = await c.def.refresh?.({ ...c.ctx(), hookUrl: HOOK_URL });
    await c.def.disconnect?.({ ...c.ctx(), extra: made?.extra ?? {} });
    expect(c.fake.webhooks.size).toBe(0);
    const revoke = c.fake.platform.requests("DELETE", "https://api.hostaway.com/v1/accessTokens");
    expect(revoke).toHaveLength(1);
    expect(revoke[0]?.url.searchParams.get("token")).toBe(c.secret.access_token);
  });
});

/* --- the token ------------------------------------------------------------------------ */

describe("Hostaway: the token, fetched again on a 403", () => {
  it("fetches a new token once, keeps it sealed, waits 1.5 seconds, and makes the call again", async () => {
    const c = connection(HARBOURLIGHT);
    c.fake.expireTokens();
    const ctx = c.ctx();
    const props = await stays(c).properties(ctx);
    expect(props.map((p) => p.id)).toEqual([HOBART]);
    expect(c.saved).toHaveLength(1);
    expect(c.saved[0]?.access_token).not.toBe(c.secret.access_token);
    expect(c.saved[0]).toMatchObject({ account_id: HOBART_ACCOUNT, client_secret: CLIENT_SECRET });
    expect(c.fake.waits).toEqual([1_500]);
    // The rest of the run uses the new token: no second exchange.
    await stays(c).rooms(ctx, HOBART);
    await stays(c).ari(ctx, HOBART, { from: "2026-12-01", to: "2026-12-03" });
    expect(c.fake.platform.requests("POST", "https://api.hostaway.com/v1/accessTokens")).toHaveLength(1);
    const auths = c.fake.platform.seen.slice(-3).map((r) => r.headers.get("authorization"));
    expect(new Set(auths)).toEqual(new Set([`Bearer ${c.saved[0]?.access_token}`]));
  });

  it("says the key no longer works when the new token is refused too", async () => {
    const c = connection(HARBOURLIGHT);
    c.fake.expireTokens();
    c.secret.client_secret = OTHER_SECRET;
    await expect(stays(c).properties(c.ctx())).rejects.toMatchObject({ code: "auth", field: "client_secret" });
    expect(c.saved).toEqual([]);
  });

  it("reads a 403 on a token just fetched as Hostaway refusing that request, never as a dead key", async () => {
    const c = connection(HARBOURLIGHT);
    // A write Hostaway will not take (a read-only field it cannot convert answers 403): refused, and
    // the token fetched again only once in the run.
    c.fake.platform.fail("POST", "https://api.hostaway.com/v1/reservations", 403, 2);
    await expect(
      writer(c).put(c.ctx(), stayOf("310021", "2026-12-10", "2026-12-12"), null, "confirmed"),
    ).rejects.toMatchObject({ code: "refused", message: expect.stringContaining("Hostaway said") });
    expect(c.fake.platform.requests("POST", "https://api.hostaway.com/v1/accessTokens")).toHaveLength(1);
    expect(c.saved).toHaveLength(1);
    expect(c.fake.reservations.size).toBe(0);
    // In a later run, a token issued in the last hour is not fetched again: a read refused is unusable.
    const fresh = { ...c.ctx(), secret: { ...c.saved[0] } as Record<string, string> };
    c.fake.platform.fail("GET", "https://api.hostaway.com/v1/listings", 403);
    await expect(stays(c).properties(fresh)).rejects.toMatchObject({ code: "bad_response" });
    expect(c.fake.platform.requests("POST", "https://api.hostaway.com/v1/accessTokens")).toHaveLength(1);
    // The token itself still works: the key was never taken as dead.
    await expect(stays(c).properties(fresh)).resolves.toHaveLength(1);
  });

  it("writes a stay with the new token when the old one stopped working, once", async () => {
    const c = connection(HARBOURLIGHT);
    c.fake.expireTokens();
    const link = await writer(c).put(c.ctx(), stayOf("310021", "2026-12-10", "2026-12-12"), null, "confirmed");
    expect(link.externalId).toBeTruthy();
    expect(c.fake.reservations.size).toBe(1);
    expect(c.fake.platform.requests("POST", "https://api.hostaway.com/v1/accessTokens")).toHaveLength(1);
  });
});

/* --- rooms, nights and money ------------------------------------------------------------ */

describe("Hostaway: listings as rooms, nights as the calendar has them, money in its own unit", () => {
  it("makes one property per currency, zone and town, one unit per listing, and leaves out archived and unfinished ones", async () => {
    const c = connection(MIXED);
    const props = await stays(c).properties(c.ctx());
    expect(props).toEqual([
      { id: HOBART, name: "Hobart · 2 listings", currency: "AUD", timezone: "Australia/Hobart" },
      { id: "310030@AUD@Australia/Sydney", name: "Byron Bay Shack", currency: "AUD", timezone: "Australia/Sydney" },
    ]);
    // Two towns in one currency and one zone are two properties, each named by its town.
    const japan = connection(JAPAN, JAPAN_ACCOUNT);
    const there = await stays(japan).properties(japan.ctx());
    expect(there.map((p) => [p.id, p.name])).toEqual([
      [OSAKA, "Osaka · 2 listings"],
      ["640601@JPY@Asia/Tokyo", "Garden Tatami Room"],
    ]);
    for (const p of [...props, ...there]) expect(p.name).not.toContain("@");
    const hobart = connection(HARBOURLIGHT);
    const rooms = await stays(hobart).rooms(hobart.ctx(), HOBART);
    expect(rooms).toEqual([
      { id: "310021", name: "Harbour View Studio (HL-1)", units: 1, capacity: { adults: 2, children: 0, total: 2 } },
      { id: "310022", name: "Wharf Loft (HL-2)", units: 1, capacity: { adults: 3, children: 1, total: 3 } },
      { id: "310023", name: "Salamanca Two-Bedroom (HL-3)", units: 1, capacity: { adults: 5, children: 3, total: 5 } },
    ]);
    expect(await stays(hobart).ratePlans(hobart.ctx(), HOBART)).toEqual([
      { id: "nightly", name: "Hostaway's nightly price" },
    ]);
    // Read without the extras, and only active listings asked for.
    const [list] = hobart.fake.platform.requests("GET", "https://api.hostaway.com/v1/listings");
    expect(list?.url.searchParams.get("includeResources")).toBe("0");
    expect(list?.url.searchParams.getAll("specialStatus[]")).toEqual(["active"]);
  });

  it("keeps a property under its first listing, its money and its zone, and says so when any of them changes", async () => {
    const c = connection(JAPAN, JAPAN_ACCOUNT);
    const ids = async () => (await stays(c).rooms(c.ctx(), OSAKA)).map((r) => r.id);
    expect(await ids()).toEqual(["640501", "640502"]);
    const again = expect.objectContaining({
      code: "not_found",
      message: expect.stringContaining("choose the property again"),
    });
    // The town renamed in Hostaway, on every Osaka listing: the property is still there.
    for (const [i, l] of c.fake.listings.entries()) {
      if (l.city === "Osaka") c.fake.listings[i] = { ...l, city: "Ōsaka" };
    }
    expect(await ids()).toEqual(["640501", "640502"]);
    // Its first listing priced in another money now: never read as yen, so chosen again.
    const first = c.fake.listings[0] as FakeListing;
    c.fake.listings[0] = { ...first, currencyCode: "USD" };
    await expect(stays(c).ari(c.ctx(), OSAKA, { from: "2027-03-01", to: "2027-03-02" })).rejects.toEqual(again);
    await expect(
      stays(c).price?.(c.ctx(), {
        propertyId: OSAKA,
        roomId: "640501",
        checkIn: "2027-03-01",
        checkOut: "2027-03-02",
        adults: 1,
        childrenAges: [],
      }),
    ).rejects.toEqual(again);
    // In another zone: its nights are other dates, so chosen again too.
    c.fake.listings[0] = { ...first, timeZoneName: "Japan" };
    await expect(stays(c).rooms(c.ctx(), OSAKA)).rejects.toEqual(again);
    // Archived: chosen again, never left with nothing.
    c.fake.listings[0] = { ...first, specialStatus: "archived" };
    await expect(stays(c).ari(c.ctx(), OSAKA, { from: "2027-03-01", to: "2027-03-02" })).rejects.toEqual(again);
    // An id this inbox never made is no property.
    await expect(stays(c).rooms(c.ctx(), "640501")).rejects.toEqual(again);
  });

  it("reads each night: free, taken by another channel, closed, its minimum stay, its price in minor units", async () => {
    const c = connection(HARBOURLIGHT);
    c.fake.otaBooking(310021, "2026-12-02", "2026-12-04");
    c.fake.blocked.add("310022|2026-12-03");
    const rows = rowsOf(await stays(c).ari(c.ctx(), HOBART, { from: "2026-12-01", to: "2026-12-05" }));
    const at = (room: string, night: string) => rows.find((r) => r.roomId === room && r.night === night);
    expect(rows.filter((r) => r.roomId === "310021").map((r) => [r.night, r.units])).toEqual([
      ["2026-12-01", 1],
      ["2026-12-02", 0],
      ["2026-12-03", 0],
      ["2026-12-04", 1],
    ]);
    expect(at("310021", "2026-12-02")?.closed).toBeUndefined();
    expect(at("310022", "2026-12-03")).toMatchObject({ units: 0, closed: true });
    expect(at("310022", "2026-12-01")).toMatchObject({ minStay: 2, prices: { nightly: 28_900 } });
    expect(at("310021", "2026-12-01")?.prices).toEqual({ nightly: 24_550 });
    expect(at("310023", "2026-12-01")?.prices).toEqual({ nightly: 41_275 });
    // The night after the last asked for: whether endDate is included is not documented, and either way
    // every night wanted comes back; only those are kept.
    const cal = c.fake.platform.requests("GET", "https://api.hostaway.com/v1/listings/310021/calendar");
    expect(cal[0]?.url.searchParams.get("startDate")).toBe("2026-12-01");
    expect(cal[0]?.url.searchParams.get("endDate")).toBe("2026-12-05");
    expect(rows.filter((r) => r.roomId === "310021").map((r) => r.night)).not.toContain("2026-12-05");
    expect(cal[0]?.url.searchParams.get("includeResources")).toBe("0");
  });

  it("counts ISK in whole krónur and BRL in centavos, and leaves out a price with a part below the unit", async () => {
    const r = connection(REYKJAVIK, REYKJAVIK_ACCOUNT);
    r.fake.nightPrice.set("530301|2027-01-16", 25_900.5);
    const rows = rowsOf(await stays(r).ari(r.ctx(), REYKJAVIK_ID, { from: "2027-01-15", to: "2027-01-17" }));
    expect(rows.find((x) => x.roomId === "530301" && x.night === "2027-01-15")?.prices).toEqual({ nightly: 24_900 });
    expect(rows.find((x) => x.roomId === "530301" && x.night === "2027-01-16")?.prices).toBeUndefined();
    const p = connection(PARATY, PARATY_ACCOUNT);
    const brl = rowsOf(await stays(p).ari(p.ctx(), PARATY_ID, { from: "2027-02-01", to: "2027-02-02" }));
    expect(brl.find((x) => x.roomId === "420102")?.prices).toEqual({ nightly: 62_050 });
    expect(hostawayMinor(4.5, "KWD")).toBe(4_500);
    expect(hostawayMinor(-1, "AUD")).toBeNull();
    expect(hostawayMinor("245.50", "AUD")).toBeNull();
  });

  it("reads a long window in pieces, and says how far it got when Hostaway asks it to wait", async () => {
    const c = connection(HARBOURLIGHT.slice(0, 1));
    const rows = rowsOf(await stays(c).ari(c.ctx(), HOBART, { from: "2027-01-01", to: "2027-07-20" }));
    expect(rows).toHaveLength(200);
    expect(c.fake.platform.requests("GET", "https://api.hostaway.com/v1/listings/310021/calendar")).toHaveLength(3);
    // Two requests left in the window: the listings and the first piece, then a 429.
    const slow = connection(HARBOURLIGHT.slice(0, 1));
    slow.fake.mode.limit = 2;
    const read = await stays(slow).ari(slow.ctx(), HOBART, { from: "2027-01-01", to: "2027-07-20" });
    expect(Array.isArray(read)).toBe(false);
    if (Array.isArray(read)) return;
    expect(read.rows).toHaveLength(92);
    expect(read.until).toBe("2027-04-03");
  });

  it("asks Hostaway the nights' own price for a stay, less its discounts, never its fees, in minor units of the listing's currency", async () => {
    const c = connection(HARBOURLIGHT);
    const q = {
      propertyId: HOBART,
      roomId: "310021",
      checkIn: "2026-12-10",
      checkOut: "2026-12-12",
      adults: 2,
      childrenAges: [],
    };
    // A$245.50 for two nights: the A$60 cleaning fee in Hostaway's total is not the nights' price.
    expect(await stays(c).price?.(c.ctx(), q)).toEqual({ subtotal: { value: 49_100, currency: "AUD" } });
    const [asked] = bodies(c, "POST", "/listings/310021/calendar/priceDetails");
    expect(asked).toEqual({ startingDate: "2026-12-10", endingDate: "2026-12-12", numberOfGuests: 2, version: 2 });
    const r = connection(REYKJAVIK, REYKJAVIK_ACCOUNT);
    expect(await stays(r).price?.(r.ctx(), { ...q, propertyId: REYKJAVIK_ID, roomId: "530301" })).toEqual({
      subtotal: { value: 49_800, currency: "ISK" },
    });
    // A week in Paraty at R$480 a night, 10% off for the week: R$3,024. The R$80 cleaning fee is not the
    // nights' price, and a discount deleted since is not taken off.
    const p = connection(PARATY, PARATY_ACCOUNT);
    const week = { ...q, propertyId: PARATY_ID, roomId: "420101", checkIn: "2027-02-01", checkOut: "2027-02-08" };
    expect(await stays(p).price?.(p.ctx(), week)).toEqual({ subtotal: { value: 302_400, currency: "BRL" } });
    // Six nights have no weekly discount.
    expect(await stays(p).price?.(p.ctx(), { ...week, checkOut: "2027-02-07" })).toEqual({
      subtotal: { value: 288_000, currency: "BRL" },
    });
  });
});

/* --- writing stays ------------------------------------------------------------------------ */

describe("Hostaway: stays written on the direct channel, checked first and read back after", () => {
  it("writes the documented fields, our key in the host note, the guest only once confirmed", async () => {
    const c = connection(REYKJAVIK, REYKJAVIK_ACCOUNT);
    const w = writer(c);
    const held = stayOf("530301", "2027-01-15", "2027-01-17", {
      propertyId: REYKJAVIK_ID,
      value: 54_300,
      currency: "ISK",
      childrenAges: [6],
      adults: 1,
    });
    const link = await w.put(c.ctx(), held, null, "provisional");
    const [create] = c.fake.platform.requests("POST", "https://api.hostaway.com/v1/reservations");
    expect(create?.url.searchParams.get("provider")).toBe("Surfing Dog Inbox");
    expect(create?.url.searchParams.has("forceOverbooking")).toBe(false);
    expect(JSON.parse(create?.body ?? "{}")).toEqual({
      channelId: 2000,
      listingMapId: 530301,
      arrivalDate: "2027-01-15",
      departureDate: "2027-01-17",
      numberOfGuests: 2,
      adults: 1,
      children: 1,
      totalPrice: 54_300,
      currency: "ISK",
      hostNote: "Booked direct via Surfing Dog Inbox, deposit due · ref HB7Q2K [sd-01JHOSTAWAYSTAY0000000000]",
    });
    const r = c.fake.reservations.get(Number(link.externalId));
    expect(r).toMatchObject({ source: "Surfing Dog Inbox", status: "new", guestName: null, guestEmail: null });
    // Paid: written again as confirmed, with its guest, and our note says so; the key stays.
    await w.put(
      c.ctx(),
      { ...held, guest: { name: "Guðrún Jónsdóttir", email: "gudrun@example.is" }, notes: "Late arrival, about 23:00" },
      link,
      "confirmed",
    );
    expect(r).toMatchObject({
      guestName: "Guðrún Jónsdóttir",
      guestEmail: "gudrun@example.is",
      guestNote: "Late arrival, about 23:00",
      hostNote: "Booked direct via Surfing Dog Inbox · ref HB7Q2K [sd-01JHOSTAWAYSTAY0000000000]",
      status: "new",
    });
    const [update] = bodies(c, "PUT", `/reservations/${link.externalId}`);
    expect(update).not.toHaveProperty("status");
    // "Not possible to update the listingMapId": never sent on an update.
    expect(update).not.toHaveProperty("listingMapId");
  });

  it("sends the amount in the currency's own decimals: 551 AUD, 620.5 BRL, 54300 ISK", async () => {
    const hobart = connection(HARBOURLIGHT);
    await writer(hobart).put(hobart.ctx(), stayOf("310021", "2026-12-10", "2026-12-12"), null, "confirmed");
    expect(bodies(hobart, "POST", "/reservations")[0]).toMatchObject({ totalPrice: 551, currency: "AUD" });
    const paraty = connection(PARATY, PARATY_ACCOUNT);
    await writer(paraty).put(
      paraty.ctx(),
      stayOf("420102", "2027-02-01", "2027-02-02", {
        value: 62_050,
        currency: "BRL",
        propertyId: PARATY_ID,
      }),
      null,
      "confirmed",
    );
    expect(bodies(paraty, "POST", "/reservations")[0]).toMatchObject({ totalPrice: 620.5, currency: "BRL" });
  });

  it("checks the nights live first, and never writes onto one another channel took", async () => {
    const c = connection(HARBOURLIGHT);
    c.fake.otaBooking(310021, "2026-12-11", "2026-12-13");
    c.fake.mode.protection = "off";
    await expect(
      writer(c).put(c.ctx(), stayOf("310021", "2026-12-10", "2026-12-12"), null, "confirmed"),
    ).rejects.toMatchObject({ code: "refused" });
    expect(c.fake.platform.requests("POST", "https://api.hostaway.com/v1/reservations")).toHaveLength(0);
  });

  it("reads back a booking that landed between its check and its write, and says oversold, definitely", async () => {
    const c = connection(HARBOURLIGHT);
    const w = writer(c);
    c.fake.mode.protection = "off";
    c.fake.mode.beforeCreate = () => {
      c.fake.otaBooking(310021, "2026-12-11", "2026-12-12");
      c.fake.mode.beforeCreate = null;
    };
    const mine = stayOf("310021", "2026-12-10", "2026-12-12");
    const link = await w.put(c.ctx(), mine, null, "confirmed");
    expect(await w.oversold?.(c.ctx(), mine, link)).toBe(true);
    // The inbox takes its own write back: cancelled by status, never deleted.
    await w.cancel(c.ctx(), link);
    expect(c.fake.reservations.get(Number(link.externalId))).toMatchObject({
      status: "cancelled",
      cancelledBy: "host",
    });
    // Cancelled, it holds none of its nights: read back again, it is never taken as written.
    expect(await w.oversold?.(c.ctx(), mine, link)).toBe(true);
    // With Hostaway's own protection on, the same race is refused at the write.
    const d = connection(HARBOURLIGHT);
    d.fake.mode.beforeCreate = () => {
      d.fake.otaBooking(310021, "2026-12-11", "2026-12-12");
      d.fake.mode.beforeCreate = null;
    };
    await expect(writer(d).put(d.ctx(), mine, null, "confirmed")).rejects.toMatchObject({ code: "refused" });
  });

  it("reads back a write that did not oversell as fine, and cannot tell before the calendar shows it", async () => {
    const c = connection(HARBOURLIGHT);
    const w = writer(c);
    const mine = stayOf("310021", "2026-12-10", "2026-12-12");
    const link = await w.put(c.ctx(), mine, null, "confirmed");
    expect(await w.oversold?.(c.ctx(), mine, link)).toBe(false);
    const cal = c.fake.platform.requests("GET", "https://api.hostaway.com/v1/listings/310021/calendar").at(-1);
    expect(cal?.url.searchParams.get("includeResources")).toBe("1");
    const r = c.fake.reservations.get(Number(link.externalId));
    if (r) r.status = "unknown";
    await expect(w.oversold?.(c.ctx(), mine, link)).rejects.toBeInstanceOf(ConnectorError);
  });

  it("never takes a reservation of ours that holds no nights as written, whatever Hostaway answered", async () => {
    const c = connection(HARBOURLIGHT);
    const w = writer(c);
    // Protection answering 2xx with the reservation stored as declined: one shape the documents leave open.
    c.fake.mode.protection = "declines";
    c.fake.mode.beforeCreate = () => {
      c.fake.otaBooking(310021, "2026-12-11", "2026-12-12");
      c.fake.mode.beforeCreate = null;
    };
    const mine = stayOf("310021", "2026-12-10", "2026-12-12");
    const link = await w.put(c.ctx(), mine, null, "confirmed");
    const r = c.fake.reservations.get(Number(link.externalId));
    expect(r?.status).toBe("declined");
    expect(await w.oversold?.(c.ctx(), mine, link)).toBe(true);
    if (r) r.status = "inquiry";
    expect(await w.oversold?.(c.ctx(), mine, link)).toBe(true);
    // Found again by its key after an answer that never came, it is still not written: never written
    // again over it, never moved, and taking it back is done.
    expect((await w.find(c.ctx(), mine))?.externalId).toBe(link.externalId);
    await expect(w.put(c.ctx(), mine, null, "confirmed")).rejects.toMatchObject({ code: "refused" });
    await expect(w.put(c.ctx(), { ...mine, checkOut: "2026-12-13" }, link, "confirmed")).rejects.toMatchObject({
      code: "refused",
    });
    await w.cancel(c.ctx(), link);
    expect(c.fake.reservations.size).toBe(2);
  });

  it("counts a multi-unit listing's units less those blocked by hand, and never sells past them", async () => {
    const c = connection(JAPAN, JAPAN_ACCOUNT);
    const w = writer(c);
    // Three pods, two taken on other channels: ours is the third, and fits.
    c.fake.otaBooking(640501, "2027-03-10", "2027-03-12");
    c.fake.otaBooking(640501, "2027-03-10", "2027-03-12");
    const mine = stayOf("640501", "2027-03-10", "2027-03-12", {
      key: "sd-pods-1",
      propertyId: OSAKA,
      value: 13_600,
      currency: "JPY",
      adults: 1,
    });
    const link = await w.put(c.ctx(), mine, null, "confirmed");
    expect(bodies(c, "POST", "/reservations")[0]).toMatchObject({ totalPrice: 13_600, currency: "JPY" });
    expect(await w.oversold?.(c.ctx(), mine, link)).toBe(false);
    // One more sold elsewhere in the same moment: four on three pods is oversold.
    const late = c.fake.otaBooking(640501, "2027-03-11", "2027-03-12");
    expect(await w.oversold?.(c.ctx(), mine, link)).toBe(true);
    late.status = "cancelled";
    expect(await w.oversold?.(c.ctx(), mine, link)).toBe(false);
    // A pod the owner blocked by hand is not for sale: three on two is oversold.
    c.fake.blockedUnits.set("640501|2027-03-11", 1);
    expect(await w.oversold?.(c.ctx(), mine, link)).toBe(true);
  });

  it("finds a write whose answer never came by its key, and never writes it twice", async () => {
    const c = connection(HARBOURLIGHT);
    const w = writer(c);
    const mine = stayOf("310021", "2026-12-10", "2026-12-12");
    c.fake.mode.write = "lands_then_times_out";
    await expect(w.put(c.ctx(), mine, null, "confirmed")).rejects.toMatchObject({ code: "unreachable" });
    c.fake.mode.write = "ok";
    const found = await w.find(c.ctx(), mine);
    expect(found?.externalId).toBe(String([...c.fake.reservations.keys()][0]));
    const again = await w.put(c.ctx(), mine, null, "confirmed");
    expect(again.externalId).toBe(found?.externalId);
    expect(c.fake.reservations.size).toBe(1);
    // A Hostaway that is down takes nothing.
    const d = connection(HARBOURLIGHT);
    d.fake.mode.write = "down";
    await expect(writer(d).put(d.ctx(), mine, null, "confirmed")).rejects.toMatchObject({ code: "unreachable" });
    expect(d.fake.reservations.size).toBe(0);
  });

  it("moves a stay's dates, never its listing, and never a stay cancelled in Hostaway", async () => {
    const c = connection(HARBOURLIGHT);
    const w = writer(c);
    const mine = stayOf("310021", "2026-12-10", "2026-12-12");
    const link = await w.put(c.ctx(), mine, null, "confirmed");
    await w.put(c.ctx(), { ...mine, checkIn: "2026-12-11", checkOut: "2026-12-14" }, link, "confirmed");
    expect(c.fake.reservations.get(Number(link.externalId))).toMatchObject({
      arrivalDate: "2026-12-11",
      departureDate: "2026-12-14",
      previousArrivalDate: "2026-12-10",
      status: "modified",
    });
    await expect(
      w.put(
        c.ctx(),
        { ...mine, rooms: [{ ...(mine.rooms[0] as OutboundStay["rooms"][0]), roomId: "310022" }] },
        link,
        "confirmed",
      ),
    ).rejects.toMatchObject({ code: "refused", message: expect.stringContaining("another listing") });
    await w.cancel(c.ctx(), link);
    await expect(w.put(c.ctx(), mine, link, "confirmed")).rejects.toMatchObject({
      code: "refused",
      message: "It was cancelled in Hostaway.",
    });
    // Sent again under its key, it is found cancelled and never written again over the owner's word.
    await expect(w.put(c.ctx(), mine, null, "confirmed")).rejects.toMatchObject({ code: "refused" });
    expect(c.fake.reservations.size).toBe(1);
  });

  /** Two rooms of one stay in Hobart: the studio for two, and the loft for two adults and a child of 7. */
  const twoRooms = (o: { key?: string } = {}): OutboundStay => {
    const one = stayOf("310021", "2026-12-10", "2026-12-12", o);
    return {
      ...one,
      rooms: [
        ...one.rooms,
        {
          roomId: "310022",
          rateId: "nightly",
          adults: 2,
          childrenAges: [7],
          price: { value: 40_000, currency: "AUD" },
        },
      ],
    };
  };

  it("writes a stay of several rooms as one reservation each, found by its own key, and never twice", async () => {
    const c = connection(HARBOURLIGHT);
    const w = writer(c);
    const two = twoRooms();
    const link = await w.put(c.ctx(), two, null, "confirmed");
    const [first, second] = (link.externalId ?? "").split(",").map((id) => c.fake.reservations.get(Number(id)));
    expect(link.externalId).toMatch(/^\d+,\d+$/);
    expect(first).toMatchObject({ listingMapId: 310021, totalPrice: 551, adults: 2, children: 0, status: "new" });
    expect(second).toMatchObject({ listingMapId: 310022, totalPrice: 400, adults: 2, children: 1, numberOfGuests: 3 });
    expect(first?.hostNote).toBe(
      "Booked direct via Surfing Dog Inbox · ref HB7Q2K · room 1 of 2 [sd-01JHOSTAWAYSTAY0000000000-room1]",
    );
    expect(second?.hostNote).toContain("room 2 of 2 [sd-01JHOSTAWAYSTAY0000000000-room2]");
    // Both rooms' nights were read before either was written.
    const order = c.fake.platform.seen.map((r) => `${r.method} ${r.url.pathname}`);
    const lastCheck = Math.max(
      order.lastIndexOf("GET /v1/listings/310021/calendar"),
      order.lastIndexOf("GET /v1/listings/310022/calendar"),
    );
    expect(lastCheck).toBeLessThan(order.indexOf("POST /v1/reservations"));
    expect(await w.oversold?.(c.ctx(), two, link)).toBe(false);
    expect((await w.find(c.ctx(), two))?.externalId).toBe(link.externalId);
    // Sent again under its key: found whole, nothing written twice.
    expect((await w.put(c.ctx(), two, null, "confirmed")).externalId).toBe(link.externalId);
    expect(c.fake.reservations.size).toBe(2);
    await w.cancel(c.ctx(), link);
    expect([first?.status, second?.status]).toEqual(["cancelled", "cancelled"]);
    // One listing is one place: never twice in a stay.
    const twice = { ...two, rooms: [two.rooms[0], two.rooms[0]] as OutboundStay["rooms"] };
    await expect(w.put(c.ctx(), twice, null, "confirmed")).rejects.toMatchObject({ code: "refused" });
  });

  it("writes a stay of several rooms whole or not at all: a room refused takes back the ones written", async () => {
    const c = connection(HARBOURLIGHT);
    const w = writer(c);
    // One room taken on another channel before anything is written: nothing is written.
    const ota = c.fake.otaBooking(310022, "2026-12-11", "2026-12-12");
    await expect(w.put(c.ctx(), twoRooms(), null, "confirmed")).rejects.toMatchObject({ code: "refused" });
    expect(c.fake.platform.requests("POST", "https://api.hostaway.com/v1/reservations")).toHaveLength(0);
    ota.status = "cancelled";
    // Taken between the check and its own write: the first room, written, is taken back.
    let creates = 0;
    c.fake.mode.beforeCreate = () => {
      if (++creates === 2) c.fake.otaBooking(310022, "2026-12-11", "2026-12-12");
    };
    await expect(w.put(c.ctx(), twoRooms({ key: "sd-two-b" }), null, "confirmed")).rejects.toMatchObject({
      code: "refused",
    });
    const ours = [...c.fake.reservations.values()].filter((r) => r.channelId === 2000);
    expect(ours.map((r) => [r.listingMapId, r.status])).toEqual([[310021, "cancelled"]]);
    expect(c.fake.free(310021, "2026-12-10")).toBe(1);
  });

  it("reads back a stay of several rooms as sound only when every room is there and holds its nights", async () => {
    const c = connection(HARBOURLIGHT);
    const w = writer(c);
    // The second room lands, then its answer never comes: found whole by its keys, and sound.
    let creates = 0;
    c.fake.mode.beforeCreate = () => {
      if (++creates === 2) c.fake.mode.write = "lands_then_times_out";
    };
    const two = twoRooms();
    await expect(w.put(c.ctx(), two, null, "confirmed")).rejects.toMatchObject({ code: "unreachable" });
    c.fake.mode.write = "ok";
    c.fake.mode.beforeCreate = null;
    const found = await w.find(c.ctx(), two);
    expect(found?.externalId?.split(",")).toHaveLength(2);
    if (!found) throw new Error("not found");
    expect(await w.oversold?.(c.ctx(), two, found)).toBe(false);
    // One of its rooms declined by Hostaway: the stay is not booked there.
    const [, second] = (found.externalId ?? "").split(",");
    const r2 = c.fake.reservations.get(Number(second));
    if (r2) r2.status = "declined";
    expect(await w.oversold?.(c.ctx(), two, found)).toBe(true);
    // Asked to wait after the first room: what was written is looked for, never left behind.
    const d = connection(HARBOURLIGHT);
    d.fake.mode.beforeCreate = () => {
      d.fake.platform.fail("POST", "https://api.hostaway.com/v1/reservations", 429);
      d.fake.mode.beforeCreate = null;
    };
    await expect(writer(d).put(d.ctx(), two, null, "confirmed")).rejects.toMatchObject({ code: "unreachable" });
    const part = await writer(d).find(d.ctx(), two);
    expect(part?.externalId?.split(",")).toHaveLength(1);
    if (!part) throw new Error("not found");
    // Only some rooms there: it cannot be sound, and the inbox takes it back.
    await expect(writer(d).oversold?.(d.ctx(), two, part)).rejects.toMatchObject({
      code: "bad_response",
      message: "Hostaway shows 1 of the 2 rooms of this stay.",
    });
    await writer(d).cancel(d.ctx(), part);
    expect([...d.fake.reservations.values()].map((r) => r.status)).toEqual(["cancelled"]);
  });

  it("refuses a stay of several rooms found again with a room the owner cancelled, and takes back the rest", async () => {
    const c = connection(HARBOURLIGHT);
    const w = writer(c);
    const two = twoRooms();
    const link = await w.put(c.ctx(), two, null, "provisional");
    const [first, second] = (link.externalId ?? "").split(",").map((id) => c.fake.reservations.get(Number(id)));
    if (first) first.status = "cancelled";
    await expect(w.put(c.ctx(), two, null, "provisional")).rejects.toMatchObject({
      code: "refused",
      message: "It was cancelled in Hostaway.",
    });
    expect(second?.status).toBe("cancelled");
    expect(c.fake.reservations.size).toBe(2);
  });

  it("moves a stay of several rooms together, room by room by listing, or puts it back as it was", async () => {
    const c = connection(HARBOURLIGHT);
    const w = writer(c);
    const two = twoRooms();
    const link = await w.put(c.ctx(), two, null, "confirmed");
    const [id1, id2] = (link.externalId ?? "").split(",");
    const r1 = c.fake.reservations.get(Number(id1));
    const r2 = c.fake.reservations.get(Number(id2));
    // The rooms given in the other order: each still goes to its own listing's reservation.
    const moved = { ...two, checkIn: "2026-12-14", checkOut: "2026-12-17", rooms: [...two.rooms].reverse() };
    const after = await w.put(c.ctx(), moved, link, "confirmed");
    expect(after.externalId).toBe(`${id2},${id1}`);
    expect([r1?.arrivalDate, r2?.arrivalDate]).toEqual(["2026-12-14", "2026-12-14"]);
    expect([r1?.totalPrice, r2?.totalPrice]).toEqual([551, 400]);
    // The second room refused: the first, already moved, is put back as it was.
    c.fake.platform.fail("PUT", `https://api.hostaway.com/v1/reservations/${id2}`, 404);
    await expect(
      w.put(c.ctx(), { ...two, checkIn: "2026-12-20", checkOut: "2026-12-22" }, link, "confirmed"),
    ).rejects.toMatchObject({ code: "refused" });
    expect([r1?.arrivalDate, r1?.departureDate]).toEqual(["2026-12-14", "2026-12-17"]);
    expect([r2?.arrivalDate, r2?.departureDate]).toEqual(["2026-12-14", "2026-12-17"]);
    // A room added or taken away is Hostaway's to do.
    await expect(w.put(c.ctx(), { ...two, rooms: two.rooms.slice(0, 1) }, after, "confirmed")).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("in Hostaway"),
    });
    // One of them cancelled in Hostaway: never brought back by a change.
    if (r2) r2.status = "cancelled";
    await expect(w.put(c.ctx(), moved, after, "confirmed")).rejects.toMatchObject({
      code: "refused",
      message: "It was cancelled in Hostaway.",
    });
    // Cancelling the stay cancels what still holds, and the cancelled one is done.
    await w.cancel(c.ctx(), after);
    expect(r1?.status).toBe("cancelled");
  });

  it("cancels by status as the host, takes a cancellation made already as done, and says when it must be done in Hostaway", async () => {
    const c = connection(HARBOURLIGHT);
    const w = writer(c);
    const link = await w.put(c.ctx(), stayOf("310021", "2026-12-10", "2026-12-12"), null, "confirmed");
    await w.cancel(c.ctx(), link);
    await w.cancel(c.ctx(), link);
    await w.cancel(c.ctx(), { externalId: "99999999", etag: null, calendar: null });
    const [cancel] = bodies(c, "PUT", `/reservations/${link.externalId}/statuses/cancelled`);
    expect(cancel).toEqual({ cancelledBy: "host" });
    expect(c.fake.platform.requests("DELETE", "https://api.hostaway.com/v1/reservations")).toHaveLength(0);
    // Gone already is done; Hostaway not taking it while it still holds its nights is the owner's to do there.
    const other = await w.put(
      c.ctx(),
      stayOf("310022", "2026-12-20", "2026-12-23", { key: "sd-other" }),
      null,
      "confirmed",
    );
    // A 404 on the cancel path is checked: the reservation still holds its nights, so it is not done.
    c.fake.platform.fail("PUT", `https://api.hostaway.com/v1/reservations/${other.externalId}/statuses/cancelled`, 404);
    await expect(w.cancel(c.ctx(), other)).rejects.toMatchObject({
      code: "refused",
      message: "Hostaway did not take it.",
    });
    c.fake.mode.cancel = "refuse";
    // In Hostaway's words, never a bare status code; the inbox adds "cancel it there".
    await expect(w.cancel(c.ctx(), other)).rejects.toMatchObject({
      code: "refused",
      message: "Hostaway said: Reservation can not be cancelled",
    });
    expect(c.fake.reservations.get(Number(other.externalId))?.status).toBe("new");
  });
});

/* --- limits -------------------------------------------------------------------------------- */

describe("Hostaway: X-RateLimit-Retry-After is a Unix time, not a delay", () => {
  const at = Date.parse("2026-11-02T09:00:00Z");

  it("reads the time against the answer's own Date, in seconds", () => {
    const h = new Headers({ date: new Date(at).toUTCString(), "x-ratelimit-retry-after": String(at / 1000 + 7) });
    expect(hostawayRetryAfterMs(h, at + 3_600_000)).toBe(7_000);
    // Without a Date header, against this inbox's own clock.
    expect(hostawayRetryAfterMs(new Headers({ "x-ratelimit-retry-after": String(at / 1000 + 4) }), at)).toBe(4_000);
  });

  it("never reads a Unix time as a delay of decades, nor a delay as a time long past", () => {
    expect(hostawayRetryAfterMs(new Headers({ "x-ratelimit-retry-after": String(at / 1000 + 9000) }), at)).toBe(
      3_600_000,
    );
    expect(hostawayRetryAfterMs(new Headers({ "x-ratelimit-retry-after": String(at / 1000 - 30) }), at)).toBe(1_000);
    expect(hostawayRetryAfterMs(new Headers({ "x-ratelimit-retry-after": "12" }), at)).toBe(12_000);
    expect(hostawayRetryAfterMs(new Headers({ "x-ratelimit-retry-after": String(at + 5_000) }), at)).toBe(5_000);
    expect(hostawayRetryAfterMs(new Headers({ "x-ratelimit-retry-after": "soon" }), at)).toBe(10_000);
    expect(hostawayRetryAfterMs(new Headers(), at)).toBe(10_000);
  });

  it("asks the inbox to wait until then, and says no credits are left only when Hostaway says so", async () => {
    const c = connection(HARBOURLIGHT);
    c.fake.mode.limit = 1;
    await stays(c).properties(c.ctx());
    const waited = await stays(c)
      .rooms(c.ctx(), HOBART)
      .catch((e: unknown) => e);
    expect(waited).toBeInstanceOf(ConnectorError);
    expect((waited as ConnectorError).code).toBe("rate_limited");
    expect((waited as ConnectorError).retryAfterMs).toBe(10_000);
    const last = await c.fake.platform.fetch("https://api.hostaway.com/v1/listings", {
      headers: { authorization: `Bearer ${c.secret.access_token}` },
    });
    expect(last.status).toBe(429);
    const res = { status: 429, headers: last.headers, text: "", url: "" };
    expect(stays(c).credits?.(res)).toMatchObject({ remaining: 0 });
    expect(stays(c).credits?.({ ...res, status: 200 })).toBeNull();
  });

  it("doubles the wait for each 429 close after another, with a random part, until Hostaway answers again", async () => {
    // "If you get a second 429, double the wait each time and add a random delay."
    expect(hostawayBackoffMs(10_000, 0, 0)).toBe(10_000);
    expect(hostawayBackoffMs(10_000, 1, 0)).toBe(20_000);
    expect(hostawayBackoffMs(10_000, 2, 0.5)).toBe(44_000);
    expect(hostawayBackoffMs(10_000, 0, 1)).toBe(12_000);
    expect(hostawayBackoffMs(600_000, 6, 1)).toBe(3_600_000);
    const fake = hostawayFake({ accountId: HOBART_ACCOUNT, clientSecret: CLIENT_SECRET, listings: HARBOURLIGHT });
    fakes.push(fake);
    const def = hostawayConnector({ wait: (ms) => fake.wait(ms), random: () => 0.5 });
    const secret = { account_id: HOBART_ACCOUNT, client_secret: CLIENT_SECRET, access_token: fake.issue() };
    const run = (at: number) => runContext(fake.platform.http, secret, at);
    const props = def.stays;
    if (!props) throw new Error("no stays");
    const waited = async (at: number) =>
      ((await props.properties(run(at)).catch((e: unknown) => e)) as ConnectorError).retryAfterMs;
    const now = fake.clock.now;
    fake.platform.fail("GET", "https://api.hostaway.com/v1/listings", 429, 3);
    // The fake's 429 names no time: the 10-second window, and a part of up to a fifth on top.
    expect(await waited(now)).toBe(11_000);
    expect(await waited(now + 11_000)).toBe(22_000);
    expect(await waited(now + 33_000)).toBe(44_000);
    // Answered again: the next 429 waits the window once more.
    await props.properties(run(now + 80_000));
    fake.platform.fail("GET", "https://api.hostaway.com/v1/listings", 429);
    expect(await waited(now + 81_000)).toBe(11_000);
  });
});

/* --- webhooks ------------------------------------------------------------------------------ */

describe("Hostaway: the unified webhook, its login checked in constant time, its body only a hint", () => {
  const request = (headers: Headers, body: string): InboundRequest => ({
    headers,
    body,
    query: new URLSearchParams(),
  });

  async function hooked() {
    const c = connection(HARBOURLIGHT);
    const made = await c.def.refresh?.({ ...c.ctx(), hookUrl: HOOK_URL });
    return { ...c, extra: made?.extra ?? {} };
  }

  it("takes a delivery with the connection's own login and password, and nothing else", async () => {
    const c = await hooked();
    const hooks = c.def.hooks;
    if (!hooks) throw new Error("no hooks");
    const r = c.fake.otaBooking(310021, "2026-12-10", "2026-12-12");
    const [d] = c.fake.deliveries("reservation.created", r.id);
    if (!d) throw new Error("no delivery");
    expect(d.url).toBe(HOOK_URL);
    const event = await hooks.verify(c.ctx(), request(d.headers, d.body));
    expect(event).toMatchObject({ topic: "reservation.created", refs: [`reservation:${r.id}`] });
    const basic = (user: string, pass: string) => new Headers({ authorization: `Basic ${btoa(`${user}:${pass}`)}` });
    const login = c.secret.hook_login ?? "";
    const password = c.secret.hook_password ?? "";
    for (const headers of [
      new Headers(),
      basic(login, ""),
      basic(login, password.slice(0, -1)),
      basic(login, `${password}x`),
      basic(`${login}x`, password),
      basic("", password),
      basic(password, login),
      new Headers({ authorization: `Bearer ${password}` }),
      new Headers({ authorization: "Basic not-base64!" }),
    ]) {
      await expect(hooks.verify(c.ctx(), request(headers, d.body))).rejects.toMatchObject({ code: "refused" });
    }
    // A connection without its webhook credentials takes nothing, even an empty login.
    const bare = { ...c.ctx(), secret: { ...c.secret, hook_login: "", hook_password: "" } };
    await expect(hooks.verify(bare, request(basic("", ""), d.body))).rejects.toMatchObject({ code: "refused" });
  });

  it("answers an event it does not use, a body it cannot read, and another account's, and reads nothing", async () => {
    const c = await hooked();
    const hooks = c.def.hooks;
    if (!hooks) throw new Error("no hooks");
    const r = c.fake.otaBooking(310021, "2026-12-10", "2026-12-12");
    const [d] = c.fake.deliveries("message.received", r.id);
    if (!d) throw new Error("no delivery");
    const seen = c.fake.platform.seen.length;
    expect(await hooks.verify(c.ctx(), request(d.headers, d.body))).toBeNull();
    // An event added later about something else (here a listing): answered, nothing read.
    const later = d.body
      .replace("message.received", "listing.updated")
      .replace('"object":"reservation"', '"object":"listing"');
    expect(later).toContain('"object":"listing"');
    expect(await hooks.verify(c.ctx(), request(d.headers, later))).toBeNull();
    expect(await hooks.verify(c.ctx(), request(d.headers, "not json"))).toBeNull();
    const other = JSON.parse(d.body.replace("message.received", "reservation.updated")) as Record<string, unknown>;
    other.accountId = 12345;
    expect(await hooks.verify(c.ctx(), request(d.headers, JSON.stringify(other)))).toBeNull();
    expect(c.fake.platform.seen.length).toBe(seen);
  });

  it("reads back what a delivery names, out of order and twice, and believes none of its body", async () => {
    const c = await hooked();
    const hooks = c.def.hooks;
    if (!hooks) throw new Error("no hooks");
    const w = writer(c);
    const link = await w.put(c.ctx(), stayOf("310021", "2026-12-10", "2026-12-12"), null, "confirmed");
    const id = Number(link.externalId);
    const [created] = c.fake.deliveries("reservation.created", id);
    await w.put(c.ctx(), stayOf("310021", "2026-12-15", "2026-12-18"), link, "confirmed");
    const [updated] = c.fake.deliveries("reservation.updated", id);
    if (!created || !updated) throw new Error("no delivery");
    // The update comes first, then the creation, then the update again.
    const events = [];
    for (const d of [updated, created, updated]) {
      const e = await hooks.verify(c.ctx(), request(d.headers, d.body));
      if (e) events.push(e);
    }
    expect(events).toHaveLength(3);
    expect(events[2]?.eventId).toBe(events[0]?.eventId);
    expect(events[1]?.eventId).not.toBe(events[0]?.eventId);
    // Whichever comes first, what is read is Hostaway's own word now: the stay where it is, and where it was.
    for (const e of events) {
      expect(await hooks.read(c.ctx(), e)).toEqual([
        { kind: "stay_nights", roomIds: ["310021"], from: "2026-12-15", to: "2026-12-18" },
        { kind: "stay_nights", roomIds: ["310021"], from: "2026-12-10", to: "2026-12-12" },
      ]);
    }
    // A body that lies about its listing and its dates changes nothing: only its id is read back.
    const forged = JSON.parse(updated.body) as { data: Record<string, unknown>; listingMapId: number };
    forged.listingMapId = 310023;
    forged.data.arrivalDate = "2027-06-01";
    const e = await hooks.verify(c.ctx(), request(updated.headers, JSON.stringify(forged)));
    if (!e) throw new Error("no event");
    expect((await hooks.read(c.ctx(), e))[0]).toMatchObject({ roomIds: ["310021"], from: "2026-12-15" });
    // A delivery sent again in a later ten minutes is read again: harmless, since reading is the truth.
    const later = await hooks.verify(
      { ...c.ctx(), now: c.fake.clock.now + 11 * 60_000 },
      request(updated.headers, updated.body),
    );
    expect(later?.eventId).not.toBe(events[0]?.eventId);
  });

  it("reads back a delivery about a reservation whatever its event is called: the documented names are prose", async () => {
    const c = await hooked();
    const hooks = c.def.hooks;
    if (!hooks) throw new Error("no hooks");
    const r = c.fake.otaBooking(310023, "2027-01-05", "2027-01-09");
    for (const name of ["reservation.created", "reservationCreated", "reservation_updated", "booking.changed", ""]) {
      const [d] = c.fake.deliveries(name, r.id);
      if (!d) throw new Error("no delivery");
      const e = await hooks.verify(c.ctx(), request(d.headers, d.body));
      expect(e).toMatchObject({ topic: name || "reservation", refs: [`reservation:${r.id}`] });
      if (!e) continue;
      expect(await hooks.read(c.ctx(), e)).toEqual([
        { kind: "stay_nights", roomIds: ["310023"], from: "2027-01-05", to: "2027-01-09" },
      ]);
    }
  });

  it("reads a body shaped like the documented webhook log object by its object, and leaves a guest message alone", async () => {
    const c = await hooked();
    const hooks = c.def.hooks;
    if (!hooks) throw new Error("no hooks");
    const r = c.fake.otaBooking(310022, "2027-02-03", "2027-02-06");
    const [d] = c.fake.deliveries("reservation.updated", r.id);
    if (!d) throw new Error("no delivery");
    const shaped = (object: string, event: string) =>
      unifiedLogObject({ accountId: Number(HOBART_ACCOUNT), listingMapId: 310022, object, objectId: r.id, event });
    // The documented example: a guest message. Answered, nothing read.
    const seen = c.fake.platform.seen.length;
    expect(
      await hooks.verify(c.ctx(), request(d.headers, shaped("conversationMessage", "message.received"))),
    ).toBeNull();
    expect(c.fake.platform.seen.length).toBe(seen);
    // About a reservation, whatever its event is called: its objectId is read back, never the log's own id.
    for (const event of ["reservation.created", "updated", "reservationModified"]) {
      const e = await hooks.verify(c.ctx(), request(d.headers, shaped("reservation", event)));
      expect(e).toMatchObject({ refs: [`reservation:${r.id}`] });
      if (!e) continue;
      expect(await hooks.read(c.ctx(), e)).toEqual([
        { kind: "stay_nights", roomIds: ["310022"], from: "2027-02-03", to: "2027-02-06" },
      ]);
    }
  });

  it("reads a reservation Hostaway does not show yet again later, never drops it", async () => {
    const c = await hooked();
    const hooks = c.def.hooks;
    if (!hooks) throw new Error("no hooks");
    const r = c.fake.otaBooking(310022, "2026-12-20", "2026-12-23");
    const [d] = c.fake.deliveries("reservation.created", r.id);
    if (!d) throw new Error("no delivery");
    const e = await hooks.verify(c.ctx(), request(d.headers, d.body));
    if (!e) throw new Error("no event");
    c.fake.reservations.delete(r.id);
    const err = await hooks.read(c.ctx(), e).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ConnectorError);
    // `unreachable` is tried again by the job; `not_found` would be dropped.
    expect((err as ConnectorError).code).toBe("unreachable");
    // A delivery that names only a listing marks the listing's next nights to read again.
    const body = JSON.stringify({
      event: "reservation.updated",
      accountId: Number(HOBART_ACCOUNT),
      listingMapId: 310022,
    });
    const byListing = await hooks.verify(c.ctx(), request(d.headers, body));
    if (!byListing) throw new Error("no event");
    const [fact] = await hooks.read(c.ctx(), byListing);
    expect(fact).toMatchObject({ kind: "stay_nights", roomIds: ["310022"] });
  });
});

/* --- where it calls, and what it never sends ------------------------------------------------- */

describe("Hostaway: only Hostaway's API, and never a card, a commission or forceOverbooking", () => {
  it("calls nothing but api.hostaway.com, and never follows a redirect elsewhere", async () => {
    expect(HOSTAWAY_HOSTS).toEqual(["api.hostaway.com"]);
    const c = connection(HARBOURLIGHT);
    c.fake.platform.on("GET", "https://169.254.169.254/latest/meta-data", () => new Response("secret"));
    c.fake.platform.fail("GET", "https://api.hostaway.com/v1/listings", {
      redirect: "https://169.254.169.254/latest/meta-data",
    });
    await expect(stays(c).properties(c.ctx())).rejects.toMatchObject({ code: "bad_response" });
    c.fake.platform.fail("GET", "https://api.hostaway.com/v1/listings", {
      redirect: "https://evil.example/v1/listings",
    });
    await expect(stays(c).properties(c.ctx())).rejects.toMatchObject({ code: "bad_response" });
    await stays(c).properties(c.ctx());
    expect(new Set(c.fake.platform.seen.map((r) => r.url.host))).toEqual(new Set(["api.hostaway.com"]));
  });

  it("sends a guest's stay through every write without a card field, a fee it set or a commission", async () => {
    const c = connection(PARATY, PARATY_ACCOUNT);
    const w = writer(c);
    const guest = { name: "Marina Alves", email: "marina@example.com.br", phone: "+55 24 0000-0000" };
    const s = stayOf("420101", "2027-02-10", "2027-02-13", {
      value: 152_000,
      currency: "BRL",
      propertyId: PARATY_ID,
      guest,
    });
    const link = await w.put(c.ctx(), s, null, "confirmed");
    await w.put(c.ctx(), { ...s, checkOut: "2027-02-14" }, link, "confirmed");
    await w.oversold?.(c.ctx(), s, link);
    await w.cancel(c.ctx(), link);
    const sent = c.fake.platform.seen.filter((r) => r.body).map((r) => r.body.toLowerCase());
    expect(sent.length).toBeGreaterThan(0);
    for (const body of sent) {
      expect(body).not.toMatch(/card|cvc|cvv|iban|commission|markup|forceoverbooking|cleaningfee|taxamount/);
    }
    for (const r of c.fake.platform.seen) expect(r.url.searchParams.has("forceOverbooking")).toBe(false);
  });
});
