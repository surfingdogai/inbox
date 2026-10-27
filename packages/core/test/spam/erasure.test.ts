import { describe, expect, it } from "vitest";
import { DOWNLOAD_TABLES } from "../../src/capabilities/download";
import { agent, DAY, fakeJudge, MIN, owner, spamSetup, T0 } from "./harness";

/**
 * Erasing a customer erases what the spam filter kept about them (ADR-029 §9.4): its verdicts and
 * prints on their items, the owner's list rows that came from them, and the handle it trusted their
 * mailbox by. The owner's download carries the verdicts, the lists, the filters and the counts — not
 * the prints, the handles or the caches, which mean something only here.
 */

describe("erasing a customer", () => {
  it("removes the filter's verdicts, prints, list rows and mailbox handle with them", async () => {
    const s = await spamSetup();
    const m = await s.caps.sendMessage(agent(T0), {
      body: "Hello, I'd like to order the Toraja beans again, the same as last month, two bags please.",
      contact: { name: "Hamid Karimi", email: "hamid.karimi@example.ir" },
    });
    const id = (m as { view: { item: { id: string } } }).view.item.id;
    // The owner marked it not spam, then spam: a list row, a print, a trusted handle, a verdict.
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "mark_spam" });
    await s.caps.transitionItem(owner(T0 + 2 * MIN), { item_id: id, event: "unspam" });
    expect(await s.q("SELECT COUNT(*) FROM spam_lists")).toEqual([[1]]);
    expect(Number((await s.q("SELECT COUNT(*) FROM spam_handles WHERE kind = 'mailbox'"))[0]?.[0])).toBe(1);
    const party = (await s.q("SELECT party_id FROM items WHERE id = ?", [id]))[0]?.[0] as string;
    const asked = await s.caps.customers.erase(owner(T0 + 3 * MIN), { party_id: party }).catch((e) => e);
    await s.caps.customers.erase(owner(T0 + 3 * MIN), { party_id: party, confirm: asked.details.confirm });
    for (const table of ["spam_verdicts", "spam_prints", "spam_lists"]) {
      expect(await s.q(`SELECT COUNT(*) FROM ${table}`), table).toEqual([[0]]);
    }
    expect(await s.q("SELECT COUNT(*) FROM spam_handles WHERE kind = 'mailbox'")).toEqual([[0]]);
  });
});

describe("erasing a customer the AI check read", () => {
  it("removes its answer for their words, which quotes them, and every handle counted under them", async () => {
    const judge = fakeJudge({
      kind: "customer",
      certainty: "high",
      customer_intent: true,
      topic: "none",
      quotes: ["my daughter Aiko has a nut allergy"],
    });
    const s = await spamSetup({ filters: ["pitches"], judge });
    const m = await s.caps.sendMessage(agent(T0, { key: "ownKeyOfTheirAssistant00000000000000000000" }), {
      body: "Hello, my daughter Aiko has a nut allergy. Are the pastries at the class made without nuts?",
      contact: { name: "Yuki Tanaka", email: "yuki.tanaka@example.jp" },
    });
    await s.drain(T0 + MIN);
    const id = (m as { view: { item: { id: string } } }).view.item.id;
    expect(String((await s.q("SELECT answer FROM spam_cache"))[0]?.[0])).toContain("aiko");
    expect(Number((await s.q("SELECT COUNT(*) FROM spam_handles WHERE kind = 'agent_key'"))[0]?.[0])).toBe(1);
    const party = (await s.q("SELECT party_id FROM items WHERE id = ?", [id]))[0]?.[0] as string;
    const asked = await s.caps.customers.erase(owner(T0 + 3 * MIN), { party_id: party }).catch((e) => e);
    await s.caps.customers.erase(owner(T0 + 3 * MIN), { party_id: party, confirm: asked.details.confirm });
    expect(await s.q("SELECT COUNT(*) FROM spam_cache")).toEqual([[0]]);
    // Their mailbox's and their assistant's own key's counts went with them; the domain's is nobody's.
    expect(await s.q("SELECT kind FROM spam_handles ORDER BY kind")).toEqual([["mail_domain"]]);
  });

  it("leaves nothing of a stranger's handles for longer than a month unseen, unless a person or a mark needs it", async () => {
    const s = await spamSetup();
    await s.caps.sendMessage(agent(T0), {
      body: "Hello, do you sell gift cards for the latte art class?",
      contact: { name: "Lee", email: "lee@studio.example.org" },
    });
    expect(Number((await s.q("SELECT COUNT(*) FROM spam_handles"))[0]?.[0])).toBe(2);
    await s.caps.spam.daily(T0 + 20 * DAY);
    expect(Number((await s.q("SELECT COUNT(*) FROM spam_handles"))[0]?.[0])).toBe(2);
    await s.caps.spam.daily(T0 + 31 * DAY);
    expect(await s.q("SELECT COUNT(*) FROM spam_handles")).toEqual([[0]]);
  });
});

describe("the owner's download", () => {
  it("carries the verdicts, the lists, the filters and the counts, and strips the prints, handles and caches", () => {
    for (const table of ["spam_verdicts", "spam_lists", "spam_filter_spans", "spam_days"]) {
      expect(DOWNLOAD_TABLES[table]?.strip, table).toBeUndefined();
    }
    for (const table of ["spam_prints", "spam_handles", "spam_cache", "spam_domains"]) {
      expect(DOWNLOAD_TABLES[table]?.strip?.(0), table).toEqual([`DELETE FROM ${table}`]);
    }
  });
});
