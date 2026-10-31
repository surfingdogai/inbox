import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { readPhoneLink } from "../../../packages/core/src/phones/links";
import { createInbox } from "../../inbox/src/app";
import { freshDb } from "../../inbox/test/harness";
import { clientIp, signInByCode } from "../../inbox/test/owner-session";
import { InboxClient } from "../src/lib/client";
import { type Native, NativeError, webNative } from "../src/lib/native";
import type { KV } from "../src/lib/offline";
import { type Fetch, type InboxEntry, Sessions } from "../src/lib/session";

/**
 * An operator who looks after several businesses (ADR-028): each inbox has its own device key, and
 * past the minutes after an unlock none of them signs until the owner gives the fingerprint again.
 * When several inboxes refresh at once (Your inboxes counts them all, what waited from offline goes
 * to each), the owner is asked once, not once per inbox, and every one of them then signs.
 */
const OWNER = "owner@operadora.example";

function memory(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

describe("several inboxes on one phone", () => {
  it("ask for the fingerprint once when they all need it at the same time", async () => {
    const db = await freshDb();
    const mail = logMailOut(() => {});
    const inbox = createInbox({ db, mailOut: mail, ownerEmails: [OWNER], pushRelay: "off" });
    // One inbox answering at three addresses stands in for three businesses: the phone keeps one
    // entry, one device key and one refresh token for each address.
    const origins = ["https://a.test", "https://b.test", "https://c.test"];
    const cookie = await signInByCode(inbox.app, mail, origins[0] ?? "", OWNER);
    const inboxes = origins.map((origin) => ({ origin, inbox, cookie }));
    const fetchImpl: Fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("cf-connecting-ip", clientIp());
      return inbox.app.request(input, { ...init, headers });
    };
    const base = webNative(memory());
    const entries: InboxEntry[] = [];
    const first = new Sessions(base, fetchImpl);
    for (const i of inboxes) {
      const made = (await (
        await i.inbox.app.request(`${i.origin}/v1/owner/phones/pairings`, {
          method: "POST",
          headers: { cookie: i.cookie, origin: i.origin },
        })
      ).json()) as { id: string; qr: string };
      const pending = await first.pair(readPhoneLink(made.qr) as NonNullable<ReturnType<typeof readPhoneLink>>);
      await i.inbox.app.request(`${i.origin}/v1/owner/phones/pairings/${made.id}/confirm`, {
        method: "POST",
        headers: { cookie: i.cookie, origin: i.origin },
      });
      entries.push(await first.finish(pending));
    }
    // Later: the app opened again, every access token gone, and the keys sign only after an unlock.
    let unlocked = false;
    let asked = 0;
    const p: Native = {
      ...base,
      sign: async (alias, data) => {
        if (!unlocked) throw new NativeError("Unlock to continue.", "auth_required");
        return base.sign(alias, data);
      },
      authenticate: async () => {
        asked++;
        await new Promise((r) => setTimeout(r, 20));
        unlocked = true;
        return true;
      },
    };
    const sessions = new Sessions(p, fetchImpl);
    const pages = await Promise.all(entries.map((e) => new InboxClient(e, sessions, fetchImpl).items("all")));
    expect(pages.map((x) => x.items)).toEqual([[], [], []]);
    expect(asked).toBe(1);
  });
});
