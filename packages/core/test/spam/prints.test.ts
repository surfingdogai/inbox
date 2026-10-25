import { describe, expect, it } from "vitest";
import { sentenceOf } from "../../src/spam/copy";
import { normalise, shingles } from "../../src/spam/normalise";
import { bandsOf, hamming, printOf, simhash } from "../../src/spam/prints";
import { agent, idOf, owner, spamSetup, T0 } from "./harness";

/**
 * Prints (ADR-029 §8): the same message is the same print whatever its spacing, case, invisible
 * characters or look-alike letters, in every script; a reworded one lands within a few bits; and only
 * other senders count. Hashes and domains are kept, never words.
 */

const LONG_PITCH =
  "Dear business owner, our agency helps cafés rank on the first page of search results within thirty days. We build links, write articles and grow your traffic. Reply today for a free audit of your website.";

describe("normalising", () => {
  it("folds case, spacing, invisible characters and look-alike letters, in every script", () => {
    expect(normalise("  Hello\u200b   WORLD \n")).toBe("hello world");
    expect(normalise("pаypal")).toBe(normalise("paypal")); // a Cyrillic а
    expect(normalise("Ｆｕｌｌｗｉｄｔｈ")).toBe("fullwidth");
    expect(normalise("Café  à   Montréal")).toBe("café à montréal");
    for (const text of [
      "Здравствуйте, можно записаться?",
      "مرحبا، هل يمكنني الحجز؟",
      "नमस्ते, क्या मैं बुक कर सकता हूँ?",
      "こんにちは、予約できますか",
      "你好，我想预约",
      "🙂👍 thanks",
    ]) {
      expect(normalise(text).length, text).toBeGreaterThan(0);
      expect(normalise(text)).toBe(normalise(`${text}  `));
    }
  });

  it("cuts every script into runs of four characters", () => {
    expect(shingles(normalise("the class"))).toEqual(["the ", "he c", "e cl", " cla", "clas", "lass"]);
    expect(shingles(normalise("こんにちは予約"))).toEqual(["こんにち", "んにちは", "にちは予", "ちは予約"]);
    expect(shingles("ab")).toEqual(["ab"]);
  });
});

describe("SimHash", () => {
  it("is the same for the same text, near for a reworded one, far for another", async () => {
    const a = simhash(normalise(LONG_PITCH));
    expect(simhash(normalise(LONG_PITCH.toUpperCase()))).toBe(a);
    const reworded = simhash(normalise(LONG_PITCH.replace("thirty days", "thirty-one days")));
    expect(hamming(a, reworded)).toBeLessThanOrEqual(6);
    expect(
      hamming(
        a,
        simhash(
          normalise("Hi, can I book the latte art class for two on Friday afternoon? We are visiting from Nairobi."),
        ),
      ),
    ).toBeGreaterThan(12);
    // Six bits apart, one of the eight bands is always the same: what the indexed lookup relies on.
    const b = bandsOf(a);
    const c = bandsOf(reworded);
    expect(b.some((band, i) => band === c[i])).toBe(true);
    expect((await printOf(normalise(LONG_PITCH))).substantial).toBe(true);
    expect((await printOf(normalise("Table for two tonight?"))).substantial).toBe(false);
  });
});

describe("repeats", () => {
  it("count other senders only, from the fifth a wave; one sender saying it twice is no repeat", async () => {
    const s = await spamSetup();
    for (let i = 0; i < 5; i++) {
      await s.caps.sendMessage(agent(T0 + i * 1_000), {
        body: LONG_PITCH,
        contact: { name: `A${i}`, email: `a${i}@agency${i}.example.net` },
      });
    }
    const causes = (
      await s.q("SELECT v.cause, i.screen FROM spam_verdicts v JOIN items i ON i.id = v.item_id ORDER BY v.created_at")
    ).map((r) => `${r[1]}:${r[0] ?? ""}`);
    expect(causes).toEqual(["delivered:", "delivered:", "warned:same_text", "warned:same_text", "aside:wave"]);
    const t = await spamSetup();
    for (let i = 0; i < 3; i++) {
      await t.caps.sendMessage(agent(T0 + i * 1_000), {
        body: LONG_PITCH,
        contact: { name: "Same", email: "same@agency.example.net" },
      });
    }
    expect((await t.q("SELECT screen FROM items")).map((r) => r[0])).toEqual(["delivered", "delivered", "delivered"]);
  });

  it("let a short honest question repeat freely: many people ask the same thing", async () => {
    const s = await spamSetup();
    for (let i = 0; i < 8; i++) {
      await s.caps.sendMessage(agent(T0 + i * 1_000), {
        body: "Are you open on Sunday?",
        contact: { name: `P${i}`, email: `p${i}@home${i}.example.org` },
      });
    }
    expect((await s.q("SELECT screen FROM items")).every((r) => r[0] === "delivered")).toBe(true);
  });

  it("keep the owner's marks: one like a message marked spam is put aside, one like a message brought back is lifted", async () => {
    const s = await spamSetup();
    const first = await s.caps.sendMessage(agent(T0), {
      body: LONG_PITCH,
      contact: { name: "A", email: "a@agency.example.net" },
    });
    const id = (first as { view: { item: { id: string } } }).view.item.id;
    await s.caps.transitionItem(owner(T0 + 1_000), { item_id: id, event: "mark_spam" });
    // The same template, another greeting: what a mailing to many businesses looks like.
    const second = await s.caps.sendMessage(agent(T0 + 2_000), {
      body: LONG_PITCH.replace("Dear business owner", "Hello"),
      contact: { name: "B", email: "b@other.example.net" },
    });
    expect((await s.q("SELECT cause FROM spam_verdicts ORDER BY created_at DESC LIMIT 1"))[0]?.[0]).toBe("like_marked");
    // The day of the mark in the app's words, in the business's time.
    const detail = await s.caps.getItem(owner(T0 + 3_000), { item_id: idOf(second) });
    expect(detail.spam?.reasons).toContain("It reads like a message you marked as spam on Mon 26 Oct.");
    const late = { c: "like_marked", w: 6, f: "basic" as const, x: 1 as const, v: Date.parse("2026-10-25T20:00:00Z") };
    expect(sentenceOf(late, { tz: "Asia/Jakarta" })).toBe("It reads like a message you marked as spam on Mon 26 Oct.");
    expect(sentenceOf(late, { tz: "UTC" })).toBe("It reads like a message you marked as spam on Sun 25 Oct.");
    // Never a word kept: hashes and domains only.
    const prints = await s.q("SELECT * FROM spam_prints");
    expect(JSON.stringify(prints)).not.toMatch(/agency|audit|first page/i);
  });
});
