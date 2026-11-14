import { describe, expect, it } from "vitest";
import { webNative } from "../src/lib/native";
import { Box, factsName, type KV, Outbox } from "../src/lib/offline";
import { MAX_QUICK_REPLIES, offerToSave, QuickReplies } from "../src/lib/replies";

/**
 * Quick replies (ADR-028 Amendment 5): the owner's own words, kept on the phone sealed, per inbox, and
 * gone with the inbox when it is removed from the phone.
 */
function memory(): KV & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => void raw.set(k, v),
    removeItem: (k) => void raw.delete(k),
    keys: () => [...raw.keys()],
  };
}

async function open() {
  const kv = memory();
  const native = webNative(memory());
  const box = await Box.open(native, kv);
  return { kv, native, box };
}

describe("quick replies", () => {
  it("are kept sealed: what the phone stores reads as nothing", async () => {
    const { kv, box } = await open();
    const replies = new QuickReplies(box, "ib_1");
    await replies.add("We open at nine on Saturdays.", 1);
    expect((await replies.list()).map((r) => r.text)).toEqual(["We open at nine on Saturdays."]);
    const stored = [...kv.raw.values()].join(" ");
    expect(stored).not.toContain("Saturdays");
    expect(stored).not.toContain("nine");
    // Sealed to their name: one inbox's cannot be read as another's.
    const sealed = kv.raw.get("sdi.cache.replies.ib_1");
    expect(sealed).toMatch(/^v1\./);
    kv.raw.set("sdi.cache.replies.ib_2", sealed ?? "");
    expect(await new QuickReplies(box, "ib_2").list()).toEqual([]);
  });

  it("keep the newest first, each words once, and only so many", async () => {
    const { box } = await open();
    const replies = new QuickReplies(box, "ib_1");
    await replies.add("Yes, bring it in.", 1);
    await replies.add("Sorry, we're full that day.", 2);
    await replies.add("yes, bring it  in.", 3);
    expect((await replies.list()).map((r) => r.text)).toEqual(["yes, bring it  in.", "Sorry, we're full that day."]);
    expect(await replies.has("Yes, bring it in.")).toBe(true);
    // Nothing, or a letter rather than an answer, is not kept.
    await replies.add("   ");
    await replies.add("x".repeat(121));
    expect(await replies.list()).toHaveLength(2);
    for (let i = 0; i < MAX_QUICK_REPLIES + 3; i++) await replies.add(`Answer ${i}`, 10 + i);
    const all = await replies.list();
    expect(all).toHaveLength(MAX_QUICK_REPLIES);
    expect(all[0]?.text).toBe(`Answer ${MAX_QUICK_REPLIES + 2}`);
    const [first] = all;
    await replies.remove(first?.id ?? "");
    expect((await replies.list()).map((r) => r.text)).not.toContain(first?.text);
  });

  it("keep two saves in a row, made at once", async () => {
    const { box } = await open();
    const replies = new QuickReplies(box, "ib_1");
    await Promise.all([replies.add("One.", 1), replies.add("Two.", 2)]);
    expect((await replies.list()).map((r) => r.text).sort()).toEqual(["One.", "Two."]);
  });

  it("go when their inbox is removed from the phone, with what its chips were made from", async () => {
    const { native, box } = await open();
    await new QuickReplies(box, "ib_1").add("See you then.");
    await new QuickReplies(box, "ib_2").add("Até já.");
    await box.put(factsName("ib_1"), { services: [], languages: ["en"], currency: "EUR", at: 1 });
    await new Outbox(box).add({
      alias: "ib_1",
      itemId: "i1",
      kind: "reply",
      body: { body: "See you then." },
      label: "Reply",
    });
    await box.forgetInbox("ib_1", native, false);
    expect(await new QuickReplies(box, "ib_1").list()).toEqual([]);
    expect(await box.get(factsName("ib_1"))).toBeNull();
    expect(await new Outbox(box).list("ib_1")).toEqual([]);
    // Another inbox's stay.
    expect((await new QuickReplies(box, "ib_2").list()).map((r) => r.text)).toEqual(["Até já."]);
    // The last inbox gone, the key that seals them goes too.
    await box.forgetInbox("ib_2", native, true);
    expect(await native.secureGet("cache.key")).toBeNull();
  });

  it("are offered only for words that hold nothing of the customer they answered", () => {
    const rita = {
      name: "Rita Amaral",
      email: "rita@example.com",
      phone: "+351 912 345 678",
      text: 'A table for 4 at 20:00 on 14 November {"partySize":4}',
    };
    expect(offerToSave("Yes, we can.", rita)).toBe(true);
    expect(offerToSave("We open at nine on Saturdays.", rita)).toBe(true);
    // Their name, their address, their phone, a number of theirs: never offered.
    expect(offerToSave("Hi Rita, see you then.", rita)).toBe(false);
    expect(offerToSave("hi rita!", rita)).toBe(false);
    expect(offerToSave("I wrote to rita@example.com.", rita)).toBe(false);
    expect(offerToSave("I'll call you on 912 345 678.", rita)).toBe(false);
    expect(offerToSave("Your table for 4 is confirmed.", rita)).toBe(false);
    expect(offerToSave("See you at 20:00.", rita)).toBe(false);
    // A name inside another word is not their name.
    expect(offerToSave("Our margarita is the best.", rita)).toBe(true);
    // Longer than a chip shows whole: typed, never saved.
    expect(offerToSave(`Thanks. ${"x".repeat(120)}`, rita)).toBe(false);
  });
});
