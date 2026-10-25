import { schema } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { readPhoneLink } from "../../../packages/core/src/phones/links";
import { alreadyDone } from "../../inbox/client/src/lib/spam";
import { createInbox } from "../../inbox/src/app";
import { freshDb, futureDay, openWeekdays } from "../../inbox/test/harness";
import { clientIp, signInByCode } from "../../inbox/test/owner-session";
import { InboxClient } from "../src/lib/client";
import { webNative } from "../src/lib/native";
import type { KV } from "../src/lib/offline";
import { type Fetch, InboxError, Sessions } from "../src/lib/session";
import { actionsFor, spamFiltersLine, spamFoot } from "../src/lib/view";

/**
 * The spam filter on the phone (ADR-029 §12), against a real inbox: the foot line, Held and Spam as
 * the computer lists them, Let it in and Spam from the phone, the read-only line about the filters and
 * the two emails it may switch — and Spam never styled as a warning.
 */
const ORIGIN = "https://inbox.test";
const OWNER = "owner@studiokalinda.example";
const T = Date.now();

function memory(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

async function setup() {
  const db = await freshDb();
  const mail = logMailOut(() => {});
  const inbox = createInbox({ db, mailOut: mail, ownerEmails: [OWNER], pushRelay: "off" });
  const cookie = await signInByCode(inbox.app, mail, ORIGIN, OWNER);
  const fetchImpl: Fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("cf-connecting-ip", clientIp());
    return inbox.app.request(input, { ...init, headers });
  };
  const made = (await (
    await inbox.app.request(`${ORIGIN}/v1/owner/phones/pairings`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
    })
  ).json()) as { id: string; qr: string };
  const link = readPhoneLink(made.qr);
  if (!link) throw new Error("no code");
  const sessions = new Sessions(webNative(memory()), fetchImpl);
  const pending = await sessions.pair(link);
  await inbox.app.request(`${ORIGIN}/v1/owner/phones/pairings/${made.id}/confirm`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
  });
  await sessions.confirmed(pending);
  const entry = await sessions.finish(pending);
  return { db, inbox, client: new InboxClient(entry, sessions, fetchImpl), cookie };
}

/** A booking a bot sent from a form never drawn: held at the door. */
async function heldBooking(s: Awaited<ReturnType<typeof setup>>) {
  const id = `svc_${crypto.randomUUID()}`;
  await s.db.orm.insert(schema.services).values({
    id,
    name: "Massage",
    durationMin: 60,
    capacity: 4,
    granularityMin: 30,
    price: { model: "fixed", value: 9000, currency: "AUD" },
    createdAt: T,
    updatedAt: T,
  });
  const day = futureDay(5);
  const visitor = {
    actor: { kind: "customer_human" as const, id: "anon:1", channel: "form" as const },
    tier: "anonymous" as const,
    sandbox: false,
  };
  const input = {
    payload: {
      reservationFor: { serviceId: id, name: "Massage" },
      startTime: `${day}T10:00:00Z`,
      endTime: `${day}T11:00:00Z`,
    },
    contact: { name: "Bot", email: "bot@example.net" },
  };
  const screen = { screen: { door: "form" as const, form: { key: "none" as const, trap: false } } };
  // A priced booking binds nobody until its summary is confirmed: sent again with the fingerprint given.
  const sha = await s.inbox.caps.createBooking(visitor, input, screen).then(
    () => null,
    (e: { details?: { terms_sha?: string } }) => e.details?.terms_sha ?? null,
  );
  const b = await s.inbox.caps.createBooking(visitor, { ...input, ...(sha ? { terms_sha: sha } : {}) }, screen);
  return b.view.item.id;
}

describe("the words on the phone", () => {
  it("shows Held only while something is, and Spam this week", () => {
    expect(spamFoot(null)).toBeNull();
    expect(spamFoot({ held_now: 0, this_week: { aside: 23 } })).toEqual({ held: null, spam: "Spam · 23 this week" });
    expect(spamFoot({ held_now: 2, this_week: { aside: 23 } })).toEqual({
      held: "Held · 2",
      spam: "Spam · 23 this week",
    });
    expect(spamFiltersLine(["pitches", "scams"])).toBe("Spam filters: Sales pitches, Scams · Change them on the web.");
    expect(spamFiltersLine([])).toBe("Spam filters: none on · Change them on the web.");
  });

  it("never treats Spam as a warning: it is not the Decline button", () => {
    const v = {
      item: { id: "m", type: "message", state: "open", payload: { text: "x" } },
      transitions: [
        { event: "answer", label: "Reply" },
        { event: "mark_spam", label: "Mark as spam" },
      ],
    };
    expect(actionsFor(v as never).decline).toBeNull();
  });
});

describe("against an inbox", () => {
  it("reads Held, lets one in, and sends another to Spam, with the owner's own phone token", async () => {
    const s = await setup();
    await openWeekdays(s.db);
    const first = await heldBooking(s);
    const second = await heldBooking(s);
    const spam = await s.client.spam();
    expect(spam).toMatchObject({ filters: [], held_now: 2, this_week: { aside: 0 } });
    const held = await s.client.screened("held");
    expect(held.items.map((v) => v.item.id).sort()).toEqual([first, second].sort());
    expect(held.items[0]?.spam).toMatchObject({ screen: "held", chip: "Not sent from your form" });
    await s.client.spamAct(first, "let-in", crypto.randomUUID());
    await s.client.spamAct(second, "spam", crypto.randomUUID());
    expect((await s.client.screened("held")).items).toEqual([]);
    expect((await s.client.screened("spam")).items.map((v) => v.item.id)).toEqual([second]);
    const detail = await s.client.item(first);
    expect(detail.spam).toMatchObject({ screen: "released" });
    expect((await s.client.spam()).held_now).toBe(0);
  });

  it("hears that a held request was let in already, when an answer to it did so first", async () => {
    const s = await setup();
    await openWeekdays(s.db);
    const id = await heldBooking(s);
    const detail = await s.client.item(id);
    await s.client.transition(id, { event: "confirm", expected_version: detail.item.version }, crypto.randomUUID());
    const late = await s.client.spamAct(id, "let-in", crypto.randomUUID()).catch((e: InboxError) => e);
    expect(late).toBeInstanceOf(InboxError);
    expect(late).toMatchObject({ code: "wrong_state", details: { screen: "released" } });
    expect(alreadyDone("let_in", late as InboxError)).toBe(true);
  });

  it("switches the two emails, but never a filter", async () => {
    const s = await setup();
    const after = await s.client.setSpamEmails({ held_digest: false });
    expect(after.emails).toEqual({ held_digest: false, weekly_summary: true });
    // Switching a filter is the web's, signed in on a computer: the phone's token is refused there.
    const res = await s.inbox.app.request(`${ORIGIN}/v1/owner/spam/filters/pitches`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await (s.client as unknown as { sessions: Sessions }).sessions.token(s.client.entry, false)}`,
        "content-type": "application/json",
        "cf-connecting-ip": clientIp(),
      },
      body: JSON.stringify({ on: true }),
    });
    expect(res.status).toBe(403);
  });
});
