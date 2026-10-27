import { describe, expect, it } from "vitest";
import { agent, DAY, MIN, owner, spamSetup, T0, visitor } from "./harness";

/**
 * A quote request put aside (ADR-041 §9.4): the business sees it under Spam; its customer reads it as
 * received, then as expired once its request lapsed, exactly as one nobody answered. Not spam brings it
 * back with its clock wound again, so it does not lapse at once.
 */

const ask = (s: Awaited<ReturnType<typeof spamSetup>>, t: number, caller = agent(t)) =>
  s.caps.requestQuote(caller, {
    payload: {
      itemOffered: { name: "Coffee for a wedding" },
      description: "Coffee cart for 80 guests on 12 December, in the afternoon.",
    },
    contact: { name: "Imani", email: "imani@example.co.ke" },
  });

describe("a quote request put aside", () => {
  it("by the owner, reads as received, then expired once its request lapsed", async () => {
    const s = await spamSetup();
    const q = await ask(s, T0);
    const id = q.view.item.id;
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "mark_spam" });
    expect(await s.q("SELECT state, closed_at IS NOT NULL FROM items WHERE id = ?", [id])).toEqual([["spam", 1]]);
    const read = (t: number) => s.caps.getItemStatus(agent(t), { item_id: id, access_token: q.accessToken as string });
    const soon = await read(T0 + 2 * MIN);
    expect(soon.item.state).toBe("received");
    expect(soon.human).toContain("is with us; we will get back to you soon");
    const expires = (await s.q("SELECT request_expires_at FROM items WHERE id = ?", [id]))[0]?.[0] as number;
    const late = await s.caps.getItemStatus(
      { ...agent(expires + DAY), now: () => expires + DAY },
      { item_id: id, access_token: q.accessToken as string },
    );
    expect(late.human).not.toContain("spam");
    expect(late.item.state).toBe("expired");
    expect(late.human).toContain("has expired");
  });

  it("comes back with Not spam, its request's clock wound again", async () => {
    const s = await spamSetup();
    const q = await ask(s, T0);
    const id = q.view.item.id;
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "mark_spam" });
    const before = (await s.q("SELECT request_expires_at FROM items WHERE id = ?", [id]))[0]?.[0] as number;
    await s.caps.transitionItem(owner(T0 + 3 * DAY), { item_id: id, event: "unspam" });
    const [state, after] = (await s.q("SELECT state, request_expires_at FROM items WHERE id = ?", [id]))[0] as [
      string,
      number,
    ];
    expect(state).toBe("received");
    expect(after).toBeGreaterThan(before);
    // The owner taught the filter: this sender comes straight in now.
    expect(await s.q("SELECT list, value FROM spam_lists")).toEqual([["allow", "imani@example.co.ke"]]);
  });

  it("by the filter, for what a bot did: put aside at once, and its sender reads it as received", async () => {
    const s = await spamSetup();
    const q = await s.caps.requestQuote(
      visitor(T0),
      {
        payload: { itemOffered: { name: "Anything" }, description: "Buy now best price" },
        contact: { name: "Bot", email: "bot@example.net" },
      },
      { screen: { door: "form", form: { key: "valid", trap: true, drawnAt: T0 - 30_000 } } },
    );
    expect(await s.q("SELECT state, screen FROM items WHERE id = ?", [q.view.item.id])).toEqual([["spam", "aside"]]);
    expect(q.view.item.state).toBe("received");
  });

  it("is something the owner's AI may put aside and bring back, teaching the filter nothing", async () => {
    const s = await spamSetup();
    const q = await ask(s, T0);
    const ai = { ...owner(T0 + MIN), actor: { kind: "owner_ai" as const, id: "app_1", channel: "mcp_owner" as const } };
    await s.caps.transitionItem(ai, { item_id: q.view.item.id, event: "mark_spam" });
    expect(await s.q("SELECT state FROM items WHERE id = ?", [q.view.item.id])).toEqual([["spam"]]);
    await expect(s.caps.transitionItem(ai, { item_id: q.view.item.id, event: "unspam" })).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(await s.q("SELECT COUNT(*) FROM spam_lists")).toEqual([[0]]);
    expect(await s.q("SELECT mark FROM spam_prints WHERE item_id = ?", [q.view.item.id])).toEqual([[0]]);
  });
});
