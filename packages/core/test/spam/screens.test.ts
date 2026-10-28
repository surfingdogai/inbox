import { describe, expect, it } from "vitest";
import type { JudgePort } from "../../src/spam/judge";
import { type ModelKit, ModelKitError, TEST_SAMPLES } from "../../src/spam/model";
import type { Caller } from "../../src/write/caller";
import { transitionItem } from "../../src/write/transition";
import {
  agent,
  classPayload,
  DAY,
  fakeJudge,
  HOUR,
  hostPolicy,
  MIN,
  owner,
  ownerAi,
  spamSetup,
  T0,
  visitor,
} from "./harness";

/**
 * What the owner's screens read (ADR-041 §11, §12): Held and Spam as lists with their chips, who may
 * be a customer after all, the counts Settings shows, the one notification a held booking for a time
 * close at hand gets, and the owner's own AI model on their own server.
 */

type Setup = Awaited<ReturnType<typeof spamSetup>>;

const pitch = "Hello, we can get your café on the first page of Google with our SEO services. Reply for prices.";

async function heldByBot(s: Setup, t: number, contact: { name: string; email: string }, at?: number) {
  const b = await s.caps.createBooking(
    visitor(t),
    { payload: classPayload(s.svc, at), contact },
    { screen: { door: "form", form: { key: "none", trap: false } } },
  );
  return b.view.item.id;
}

describe("Held and Spam, as lists", () => {
  it("lists everything put aside under Spam, and only what is held under Held", async () => {
    const s = await spamSetup();
    const bot = await heldByBot(s, T0, { name: "Bot", email: "bot@example.net" });
    const aside = await s.caps.sendMessage(
      visitor(T0),
      { body: "Win a prize now", contact: { name: "Prize Desk", email: "desk@prize.example" } },
      { screen: { door: "form", form: { key: "valid", trap: true, drawnAt: T0 - 30_000 } } },
    );
    const asideId = (aside as { view: { item: { id: string } } }).view.item.id;
    // One the owner marked: no chip, and nothing to doubt.
    const own = await s.caps.sendMessage(agent(T0), {
      body: "Guest posts on our blog, from 50 dollars.",
      contact: { name: "Blog Offers", email: "offers@blog.example" },
    });
    const ownId = (own as { view: { item: { id: string } } }).view.item.id;
    await transitionItem(s.db, owner(T0 + MIN), { itemId: ownId, event: "mark_spam" });
    // A held booking a person sent to Spam keeps its own state, and shows there too.
    const sent = await heldByBot(s, T0, { name: "Another Bot", email: "bot2@example.net" });
    await s.caps.markHeldSpam(owner(T0 + 2 * MIN), { item_id: sent });

    const spam = await s.caps.listItems(owner(T0 + 3 * MIN), {
      state: "spam",
      open_only: false,
      sandbox: false,
      limit: 30,
    });
    expect(spam.items.map((v) => v.item.id).sort()).toEqual([asideId, ownId, sent].sort());
    const byId = new Map(spam.items.map((v) => [v.item.id, v.spam]));
    expect(byId.get(asideId)).toMatchObject({ screen: "aside", chip: "Filled by a bot", certain: true });
    expect(byId.get(ownId)).toMatchObject({ chip: "", may_be_customer: false });

    const held = await s.caps.listItems(owner(T0 + 3 * MIN), {
      screen: "held",
      open_only: false,
      sandbox: false,
      limit: 30,
    });
    expect(held.items.map((v) => v.item.id)).toEqual([bot]);
    expect(held.items[0]?.spam).toMatchObject({
      screen: "held",
      chip: "Not sent from your form",
      cause: "no_key",
      may_be_customer: false,
      sender: { address: "bot@example.net", company_domain: "example.net", app: false },
    });
    // The desk shows neither.
    const desk = await s.caps.listItems(owner(T0 + 3 * MIN), { open_only: false, sandbox: false, limit: 30 });
    expect(desk.items.some((v) => [bot, asideId, sent].includes(v.item.id))).toBe(false);
  });

  it("marks who may be a customer after all: many new requests, an unsure check, words naming the offer", async () => {
    const judge = fakeJudge({ kind: "unclear", certainty: "low", topic: "none", quotes: [] });
    const s = await spamSetup({ filters: ["pitches"], judge });
    // Five bookings from one address are its day's budget; the sixth is held, and may well be a customer.
    let last = "";
    for (let i = 0; i < 6; i++) {
      const b = await s.caps.createBooking(agent(T0 + i * MIN), {
        payload: classPayload(s.svc, T0 + (3 + i) * DAY),
        contact: { name: "Kenji Watanabe", email: "kenji@example.jp" },
      });
      last = b.view.item.id;
    }
    await s.drain(T0 + 10 * MIN);
    const held = await s.caps.listItems(owner(T0 + 11 * MIN), {
      screen: "held",
      open_only: false,
      sandbox: false,
      limit: 30,
    });
    const kenji = held.items.find((v) => v.item.id === last);
    expect(kenji?.spam).toMatchObject({ cause: "many_new", may_be_customer: true });
    // A bot's form is certain, and not a customer's.
    const bot = await heldByBot(s, T0 + 12 * MIN, { name: "Bot", email: "bot@example.net" });
    const again = await s.caps.listItems(owner(T0 + 13 * MIN), {
      screen: "held",
      open_only: false,
      sandbox: false,
      limit: 30,
    });
    expect(again.items.find((v) => v.item.id === bot)?.spam?.may_be_customer).toBe(false);
  });

  it("offers a company's domain to let through, never a provider many share or a throwaway one", async () => {
    const s = await spamSetup();
    const ids: Record<string, string> = {};
    for (const email of ["ana@gmail.com", "ana@mailinator.com", "ana@studio-norte.example"]) {
      ids[email] = await heldByBot(s, T0, { name: "Ana", email });
    }
    const held = await s.caps.listItems(owner(T0 + MIN), {
      screen: "held",
      open_only: false,
      sandbox: false,
      limit: 30,
    });
    const domain = (email: string) => held.items.find((v) => v.item.id === ids[email])?.spam?.sender.company_domain;
    expect(domain("ana@gmail.com")).toBeNull();
    expect(domain("ana@mailinator.com")).toBeNull();
    expect(domain("ana@studio-norte.example")).toBe("studio-norte.example");
  });

  it("counts this week's put aside, and an owner's own model's tokens, for Settings", async () => {
    const s = await spamSetup();
    await s.caps.sendMessage(
      visitor(T0),
      { body: "Bonus spins", contact: { name: "Spin", email: "spin@example.net" } },
      { screen: { door: "form", form: { key: "valid", trap: true, drawnAt: T0 - 30_000 } } },
    );
    await s.db.client.query({
      sql: "INSERT INTO spam_days (day, key, n) VALUES (?, 'tokens_in', 900), (?, 'tokens_out', 100)",
      params: ["2026-10-26", "2026-10-26"],
      method: "run",
    });
    const status = await s.caps.spamStatus(owner(T0 + HOUR));
    expect(status.this_week).toEqual({ aside: 1 });
    expect(status.checks.tokens_this_month).toBe(1000);
  });
});

describe("the owner's own AI model, on their own server", () => {
  function kit(): ModelKit & { keys: string[]; judged: string[] } {
    const keys: string[] = [];
    const judged: string[] = [];
    const answers = fakeJudge((req) =>
      req.user.includes("backlinks")
        ? { kind: "sales_pitch", certainty: "high", topic: "seo", quotes: [] }
        : { kind: "customer", certainty: "high", customer_intent: true, topic: "none", quotes: [] },
    );
    return {
      keys,
      judged,
      judge: ({ model, key }) => {
        keys.push(key);
        const port: JudgePort = {
          judge: (req, signal) => {
            judged.push(model);
            return answers.judge(req, signal);
          },
        };
        return port;
      },
      models: async ({ provider, key }) => {
        if (key === "bad-key-12345") throw new ModelKitError("key", "refused");
        keys.push(key);
        return [{ id: `${provider}-small`, name: "Small" }];
      },
    };
  }

  it("keeps the key sealed, never shows it, and reads with the model it was given", async () => {
    const s = await spamSetup({ filters: ["pitches"] });
    const k = kit();
    s.caps.spam.attach({ kit: k });
    const me = owner(T0);
    expect(await s.caps.spamModel(me)).toMatchObject({ offered: true, own: null, can_change: true });
    expect(await s.caps.spamModels(me, { provider: "openai", key: "sk-test-key-0001" })).toEqual({
      models: [{ id: "openai-small", name: "Small" }],
    });
    await expect(s.caps.spamModels(me, { provider: "openai", key: "bad-key-12345" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    const card = await s.caps.setSpamModel(me, { provider: "openai", model: "openai-small", key: "sk-test-key-0001" });
    expect(card.own).toMatchObject({ provider: "openai", provider_name: "OpenAI", model: "openai-small" });
    // Nowhere to be read back: not the card, not the status, not the table in the clear.
    expect(JSON.stringify(card)).not.toContain("sk-test-key-0001");
    expect(JSON.stringify(await s.caps.spamStatus(me))).not.toContain("sk-test-key-0001");
    expect(JSON.stringify(await s.q("SELECT * FROM spam_model"))).not.toContain("sk-test-key-0001");
    const status = await s.caps.spamStatus(me);
    expect(status.reader).toBe("own_model");
    expect(status.model).toEqual({ provider: "OpenAI", model: "openai-small", set_by_server: false });
    // Test: the two samples, as the filter would send them.
    expect(await s.caps.testSpamModel(me)).toEqual({ ok: true, pitch: true, customer: true });
    expect((await s.caps.spamModel(me)).own?.tested).toMatchObject({ pitch: true, customer: true });
    expect(TEST_SAMPLES.customer).toMatch(/[぀-ヿ]/);
    // A stranger's pitch is read by it.
    await s.caps.sendMessage(agent(T0 + MIN), { body: pitch, contact: { name: "SEO", email: "seo@growth.example" } });
    await s.drain(T0 + 2 * MIN);
    expect(k.judged.length).toBeGreaterThanOrEqual(3);
    expect(k.keys).toContain("sk-test-key-0001");
    // Remove: the key goes, and the filters look for phrases only again.
    expect((await s.caps.removeSpamModel(me)).own).toBeNull();
    expect((await s.caps.spamStatus(me)).reader).toBe("no_model");
  });

  it("is a person's, signed in: never the owner's AI", async () => {
    const s = await spamSetup();
    s.caps.spam.attach({ kit: kit() });
    const ai: Caller = ownerAi(T0);
    expect((await s.caps.spamModel(ai)).can_change).toBe(false);
    await expect(
      s.caps.setSpamModel(ai, { provider: "anthropic", model: "x", key: "sk-test-key-0002" }),
    ).rejects.toMatchObject({ code: "not_allowed" });
    await expect(s.caps.removeSpamModel(ai)).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("is the owner's alone: staff signed in may switch filters, never set where messages are sent", async () => {
    const s = await spamSetup();
    s.caps.spam.attach({ kit: kit() });
    const staff: Caller = {
      actor: { kind: "staff", id: "user_2", channel: "owner_ui" },
      tier: "verified_principal",
      sandbox: false,
      principal: { via: "session", id: "sess_2", name: "staff@kopisenja.example", scopes: ["*"], userId: "user_2" },
      now: () => T0,
    };
    expect((await s.caps.spamModel(staff)).can_change).toBe(false);
    await expect(
      s.caps.setSpamModel(staff, { provider: "openai", model: "m", key: "sk-test-key-0004" }),
    ).rejects.toMatchObject({ code: "not_allowed", details: { reason: "owner_in_person" } });
    await expect(s.caps.spamModels(staff, { provider: "openai", key: "sk-test-key-0004" })).rejects.toMatchObject({
      code: "not_allowed",
    });
    await expect(s.caps.removeSpamModel(staff)).rejects.toMatchObject({ code: "not_allowed" });
    // A filter is still staff's to switch.
    expect((await s.caps.spam.setFilter(staff, { filter: "junk", on: true }, T0)).filters[2]?.on).toBe(true);
    expect((await s.caps.spamModel(owner(T0))).can_change).toBe(true);
  });

  it("is not offered where the host reads, nor where the server set one", async () => {
    const hosted = await spamSetup({
      host: hostPolicy({ ai: false }),
    });
    hosted.caps.spam.attach({ kit: kit() });
    expect(await hosted.caps.spamModel(owner(T0))).toMatchObject({ offered: false, not_offered: "hosted" });
    await expect(
      hosted.caps.setSpamModel(owner(T0), { provider: "gemini", model: "x", key: "sk-test-key-0003" }),
    ).rejects.toMatchObject({ code: "not_allowed", details: { reason: "hosted" } });

    const server = await spamSetup({
      judge: fakeJudge({ kind: "customer", certainty: "high", topic: "none", quotes: [] }),
    });
    server.caps.spam.attach({ kit: kit(), model: { provider: "this server", model: "Small", setByServer: true } });
    expect(await server.caps.spamModel(owner(T0))).toMatchObject({
      offered: false,
      set_by_server: { provider: "this server", model: "Small" },
    });
  });
});

/**
 * The AI check on a Pro the host gave for free (ADR-041 §15.3): off until the owner turns it on in
 * Settings → Spam. The owner's own act, signed in, in person, since it decides whether new senders'
 * messages go to the host's AI; kept as a span (who, when) and told to the host, which decides.
 */
describe("the AI check on a Pro given for free", () => {
  const staff: Caller = {
    actor: { kind: "staff", id: "user_2", channel: "owner_ui" },
    tier: "verified_principal",
    sandbox: false,
    principal: { via: "session", id: "sess_2", name: "staff@kopisenja.example", scopes: ["*"], userId: "user_2" },
    now: () => T0,
  };

  it("is the owner's alone to switch, kept with who and when, and told to the host every time", async () => {
    const told: boolean[] = [];
    const s = await spamSetup({
      filters: ["pitches"],
      judge: fakeJudge({}),
      host: hostPolicy({
        ai: false,
        aiByOwner: true,
        ownerReader: "Claude Haiku, by Anthropic",
        giftUntil: "2026-11-27T00:00:00.000Z",
      }),
    });
    s.caps.spam.attach({ tellAi: (on) => told.push(on) });
    const first = await s.caps.spam.status(staff, T0);
    expect(first.gift_until).toBe("2026-11-27T00:00:00.000Z");
    expect(first.owner_ai).toEqual({
      on: false,
      chosen: false,
      chosen_at: null,
      can_switch: false,
      reader: "Claude Haiku, by Anthropic",
    });
    expect(await s.caps.spam.aiReader(T0)).toBeNull();
    for (const who of [staff, ownerAi(T0)]) {
      await expect(s.caps.spam.setHostedAi(who, { on: true }, T0)).rejects.toMatchObject({
        code: "not_allowed",
        details: { reason: "owner_in_person" },
      });
    }
    expect(told).toEqual([]);
    const on = await s.caps.spam.setHostedAi(owner(T0), { on: true }, T0 + MIN);
    expect(on.owner_ai).toMatchObject({
      on: false,
      chosen: true,
      chosen_at: new Date(T0 + MIN).toISOString(),
      can_switch: true,
    });
    // Asked again, nothing more is kept, and the host is told again.
    await s.caps.spam.setHostedAi(owner(T0), { on: true }, T0 + 2 * MIN);
    expect(told).toEqual([true, true]);
    expect(await s.q("SELECT by_kind, by_id, from_at, to_at FROM spam_filter_spans WHERE filter = 'ai'")).toEqual([
      ["owner", "user_1", T0 + MIN, null],
    ]);
    // Until the host's policy says so, nothing is read.
    expect(await s.caps.spam.aiReader(T0 + 2 * MIN)).toBeNull();
    // A plan that withdraws the filters leaves the owner's choice as it is; it is no filter.
    s.caps.spam.attach({ host: hostPolicy({ plan: "free", ai: false, filters: [] }) });
    await s.caps.spam.applyHost(T0 + HOUR);
    expect(await s.q("SELECT to_at FROM spam_filter_spans WHERE filter = 'ai'")).toEqual([[null]]);
    expect((await s.caps.spam.status(owner(T0), T0 + HOUR)).filters.map((f) => f.filter)).toEqual([
      "pitches",
      "scams",
      "junk",
    ]);
    await expect(s.caps.spam.setHostedAi(owner(T0), { on: false }, T0 + HOUR)).rejects.toMatchObject({
      code: "not_allowed",
      details: { reason: "plan" },
    });
    // Back on the gift, with the filters back and the host having it on: off is the owner's to choose again.
    s.caps.spam.attach({
      host: hostPolicy({ ai: true, defaultOn: true, aiByOwner: true, ownerReader: "Claude Haiku, by Anthropic" }),
    });
    await s.caps.spam.applyHost(T0 + HOUR);
    expect(await s.caps.spam.aiReader(T0 + HOUR)).toBe("host");
    const off = await s.caps.spam.setHostedAi(owner(T0), { on: false }, T0 + 2 * HOUR);
    expect(off.owner_ai).toMatchObject({ on: true, chosen: false, chosen_at: new Date(T0 + 2 * HOUR).toISOString() });
    expect(told).toEqual([true, true, false]);
  });

  it("isn't offered on paid Pro, on Free, or on one's own server", async () => {
    for (const host of [hostPolicy(), hostPolicy({ plan: "free", ai: false, filters: [] }), null]) {
      const s = await spamSetup({ host });
      s.caps.spam.attach({ tellAi: () => undefined });
      expect((await s.caps.spam.status(owner(T0), T0)).owner_ai).toBeNull();
      await expect(s.caps.spam.setHostedAi(owner(T0), { on: true }, T0)).rejects.toMatchObject({ code: "not_allowed" });
    }
  });
});
