import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logMailOut } from "@surfingdog/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BuildDeps, tenantMailOut } from "../src/build";
import { CHECKS_DAILY_CAP, Ledger, RECIPIENT_DAILY_CAP } from "../src/ledger";
import { redact } from "../src/redact";
import { normalizePolicy, type PolicyPayload } from "../src/types";
import { OWNER, PARENT, type Runtime, startRuntime } from "./harness";

/**
 * Host policy by level (acceptance 14) and mail (acceptance 16), as a hosted inbox lives them: at
 * level 1 the owner cannot switch a network on, list the inbox or change the sender, the Inbox
 * address, private targets or extra authorities, and nobody but the owner is written to; at level 2
 * listing and the networks are the owner's, as a new inbox starts them: on. Every email goes from the inbox's pinned
 * sender. The ledger holds what no inbox sees alone: a recipient's day across inboxes, the
 * addresses nobody writes to, and inboxes whose sending is paused. Logs keep no secret.
 */

let rt: Runtime;
beforeAll(async () => {
  rt = await startRuntime();
});
afterAll(async () => {
  await rt.close();
});

const put = (host: string, cookie: string, doc: Record<string, unknown>) =>
  rt.http(host, "PUT", "/v1/owner/settings", {
    headers: { cookie, "content-type": "application/json", origin: `https://${host}` },
    body: JSON.stringify({ doc }),
  });

describe("the host policy by level", () => {
  it("at level 1 holds networks, listing, the sender, the address, private targets and authorities", async () => {
    const t = await rt.createTenant();
    const cookie = await rt.signIn(t, t.slugHost);
    for (const doc of [
      { networks: { "https://network.example.org": { enabled: true } } },
      { email: { fromAddress: "me@salaorosa.pt" } },
      { email: { replyTo: "me@salaorosa.pt" } },
      { notifications: { appUrl: "https://elsewhere.example.org" } },
      { integrations: { webhooks: { allowPrivateTargets: true } } },
      { identity: { extraAuthorities: ["elsewhere.example.org"] } },
    ]) {
      const r = await put(t.slugHost, cookie, doc);
      expect(r.status, JSON.stringify(doc)).toBeGreaterThanOrEqual(400);
      expect(r.text, JSON.stringify(doc)).toContain("set by your host");
    }
    // Its own details are the owner's.
    expect((await put(t.slugHost, cookie, { business: { name: "Salão Rosa e Filhas" } })).status).toBe(200);
    // Listed or not is the owner's choice for when it is live: taken now, out of the directories meanwhile.
    expect((await put(t.slugHost, cookie, { directory: { listed: false } })).status).toBe(200);
    const s = (await rt.http(t.slugHost, "GET", "/v1/owner/settings", { headers: { cookie } })).json as {
      doc: { directory: { listed: boolean; resume?: boolean } };
    };
    expect(s.doc.directory).toMatchObject({ listed: false, resume: false });
  });

  it("at level 2 names the business's site and hands listing to the owner: listed, as a new inbox starts", async () => {
    const t = await rt.createTenant();
    await rt.setState(t, "live", { ownResolves: true });
    const manifest = (await rt.http(t.ownHost ?? "", "GET", "/.well-known/agent-inbox.json")).json as {
      directory?: { listed?: boolean };
    };
    expect(manifest.directory?.listed).toBeUndefined();
    const cookie = await rt.signIn(t, t.ownHost ?? "");
    const settings = (await rt.http(t.ownHost ?? "", "GET", "/v1/owner/settings", { headers: { cookie } })).json as {
      doc: { directory: { url: string; listed: boolean } };
    };
    expect(settings.doc.directory.url).toBe(`https://${t.domain}`);
    expect(settings.doc.directory.listed).toBe(true);
    expect((await put(t.ownHost ?? "", cookie, { directory: { listed: false } })).status).toBe(200);
    expect((await put(t.ownHost ?? "", cookie, { directory: { listed: true } })).status).toBe(200);
    // Still held: the sender and the Inbox address.
    expect((await put(t.ownHost ?? "", cookie, { email: { fromAddress: "me@salaorosa.pt" } })).text).toContain(
      "set by your host",
    );
  });
});

describe("mail", () => {
  it("goes from the pinned sender: the setup name below level 2, the business's at level 2", async () => {
    const t = await rt.createTenant();
    const before = rt.mail.length;
    const ask = await rt.http(t.slugHost, "POST", "/auth/magic-link", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: OWNER }),
    });
    expect(ask.status).toBeLessThan(400);
    const signIn = rt.mail.slice(before).find((m) => m.mail.to.includes(OWNER));
    const slug = t.slugHost.split(".")[0];
    expect(signIn?.from).toEqual({ address: `${slug}@mail.${PARENT}`, name: "Surfing Dog Inbox" });
    expect(signIn?.mail.text).toContain(`https://${t.slugHost}/`);
    await rt.setState(t, "live", { ownResolves: true });
    const sent = await rt.http(t.ownHost ?? "", "POST", "/v1/quotes", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: { itemOffered: { name: "Colour" }, description: "Curly hair, shoulder length" },
        contact: { name: "Rita", email: "rita@example.org" },
      }),
    });
    expect(sent.status).toBe(201);
    // The acknowledgement waits a moment after the request.
    rt.later(5 * 60_000);
    const shard = rt.shardOf(t);
    shard.due.set(t.tenantId, 0);
    await shard.tick();
    const ack = rt.mail.find((m) => m.mail.to.includes("rita@example.org"));
    expect(ack?.from).toEqual({ address: `${slug}@mail.${PARENT}`, name: "Salão Rosa" });
    expect(ack?.mail.subject).not.toContain("curly");
    // The pinned sender takes no mail: a customer's reply goes to the conversation's own address,
    // never to the owner's (ADR-026 §4, §6).
    expect(ack?.mail.replyTo).toMatch(new RegExp(`^${slug}\\+t[a-z2-7]{16}@in\\.example\\.net$`));
    expect(JSON.stringify(ack)).not.toContain(OWNER);
    expect(ack?.mail.text).toContain("Responda a este email para falar connosco."); // the business's language
  });

  it("asks a customer for no reply when the policy names no Reply-To: a reply would reach nobody", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdh-"));
    const ledger = new Ledger(join(dir, "ledger.db"), { hashKey: "k" });
    try {
      const policy = (replyTo: string | null): PolicyPayload => ({
        tenant_id: "tn_a",
        policy_version: 1,
        state: "live",
        level: 2,
        agents: "open",
        address: "https://inbox.bikeworkshop.example",
        site: "https://bikeworkshop.example",
        owner_email: OWNER,
        mail: {
          from: "bike-workshop@mail.example.net",
          from_name: "Bike Workshop",
          reply_to: replyTo,
          customer_mail: true,
          customer_daily_cap: 200,
        },
        read_only: false,
        suspended_reason: null,
      });
      const deps = (p: PolicyPayload) =>
        ({ tenantId: "tn_a", policy: p, ledger, transport: () => logMailOut() }) as unknown as BuildDeps;
      expect(tenantMailOut(deps(policy(null))).replies).toBe(false);
      // The owner's sign-in address is never a Reply-To (ADR-026 §6): the policy as applied drops it.
      expect(normalizePolicy(policy(OWNER)).mail.reply_to).toBeNull();
      expect(tenantMailOut(deps(normalizePolicy(policy(OWNER)))).replies).toBe(false);
      // With an address of its own, every conversation has one: a reply always reaches the inbox.
      const withInbound = { ...policy(null), mail: { ...policy(null).mail, inbound: "bike-workshop@in.example.net" } };
      expect(tenantMailOut(deps(withInbound)).replies).toBe(true);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps one recipient across inboxes at five a day", async () => {
    const tenants = [await rt.createTenant(), await rt.createTenant(), await rt.createTenant()];
    for (const t of tenants) await rt.setState(t, "live", { ownResolves: true });
    const to = "same.person@example.org";
    for (const t of tenants) {
      for (let i = 0; i < 2; i++) {
        const r = await rt.http(t.ownHost ?? "", "POST", "/v1/quotes", {
          headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${i + 1}` },
          body: JSON.stringify({
            payload: { itemOffered: { name: "Cut" }, description: `Question ${i}` },
            contact: { name: "Same", email: to },
          }),
        });
        expect(r.status).toBe(201);
      }
    }
    rt.later(5 * 60_000);
    for (const t of tenants) {
      const shard = rt.shardOf(t);
      shard.due.set(t.tenantId, 0);
      await shard.tick();
    }
    expect(rt.mail.filter((m) => m.mail.to.includes(to))).toHaveLength(RECIPIENT_DAILY_CAP);
  });
});

describe("the ledger", () => {
  const mail = (to: string) => ({ from: { address: "a@mail.example.net" }, to: [to], subject: "s", text: "t" });
  const customer = { recipient: "customer" as const, kind: "acknowledgement" as const, template: "ack.message" };
  const owner = { recipient: "owner" as const, template: "owner.create" };

  it("holds a suppressed address, a paused inbox, an inbox past its day, and counts what goes", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdh-"));
    const ledger = new Ledger(join(dir, "ledger.db"), { hashKey: "k" });
    try {
      ledger.suppress("Bounced@Example.org", "bounce");
      expect(ledger.hold("tn_a", mail("bounced@example.org"), customer, 100)).toBe("suppressed");
      expect(ledger.hold("tn_a", mail("bounced@example.org"), owner, 100)).toBe("suppressed");
      expect(ledger.hold("tn_a", mail("x@example.org"), customer, 1)).toBeNull();
      expect(ledger.hold("tn_a", mail("y@example.org"), customer, 1)).toBe("daily_limit");
      // The owner's email is counted, not capped here.
      for (let i = 0; i < 10; i++) expect(ledger.hold("tn_a", mail(OWNER), owner, 0)).toBeNull();
      expect(ledger.pauseMail("tn_a", "complaints")).toBe(true);
      expect(ledger.hold("tn_a", mail(OWNER), owner, 0)).toBe("paused");
      ledger.resumeMail("tn_a");
      expect(ledger.mailSent("tn_a", new Date().toISOString().slice(0, 7))).toBe(11);
      // Recipients are kept as keyed hashes.
      const rows = ledger.db.prepare("SELECT rcpt FROM recipient_day UNION SELECT rcpt FROM suppressed").all() as {
        rcpt: string;
      }[];
      expect(JSON.stringify(rows)).not.toContain("@");
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts forwarding checks per inbox and against the recipient's day, as email to a customer is", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdh-"));
    const ledger = new Ledger(join(dir, "ledger.db"), { hashKey: "k" });
    const check = { recipient: "owner" as const, template: "forward.check" };
    try {
      // One outside address: its day's cap across every inbox here, whichever inbox asks.
      for (let i = 0; i < RECIPIENT_DAILY_CAP; i++) {
        expect(ledger.hold(i % 2 ? "tn_a" : "tn_b", mail("victim@target.example"), check, 100)).toBeNull();
      }
      expect(ledger.hold("tn_c", mail("victim@target.example"), check, 100)).toBe("recipient_limit");
      // One inbox: its own cap of checks, wherever they go.
      let held: string | null = null;
      for (let i = 0; i < CHECKS_DAILY_CAP + 1; i++)
        held = ledger.hold("tn_d", mail(`a${i}@other.example`), check, 100);
      expect(held).toBe("daily_limit");
      // An alert to the owner is still counted, not capped.
      expect(ledger.hold("tn_d", mail(OWNER), owner, 0)).toBeNull();
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hands each event to one shard at a time, and tries again later", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdh-"));
    const one = new Ledger(join(dir, "ledger.db"), { hashKey: "k" });
    const two = new Ledger(join(dir, "ledger.db"), { hashKey: "k" });
    try {
      one.queueEvent({ tenant_id: "tn_a", type: "download", at: new Date().toISOString(), data: {} });
      const first = one.claimEvents(10);
      expect(first).toHaveLength(1);
      expect(two.claimEvents(10)).toHaveLength(0);
      two.eventRetry(first[0]?.id ?? 0, 0);
      one.eventDone(first[0]?.id ?? 0);
      expect(two.claimEvents(10)).toHaveLength(0);
    } finally {
      one.close();
      two.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("logs", () => {
  it("keep no key, token, code, link token, session or address", () => {
    const line = [
      "owner key sdi_own_AbCdEf0123456789xyz",
      "Authorization: Bearer sdi_at_0123456789abcdef",
      "https://quiet-otter-7k2m.example.net/auth/handoff?token=abcDEF0123456789&next=/",
      "your code: 123456",
      "Cookie: __Host-sdi_session=s3cr3tvalue; other=1",
      "https://app.example.net/connect/AbCdEfGhIjKlMnOpQrStUv",
      "https://inbox.example.com/c/AbCdEfGhIjKlMnOpQrStUv",
      `X-SD-Sig: v1=${"a".repeat(64)}`,
      "sdkey1_network.example.org_abcdefghijklmnop_abcdefghijklmnopqrstuvwxyz234567",
      "from rita@example.org",
    ].join("\n");
    const out = redact(line);
    for (const secret of [
      "AbCdEf0123456789xyz",
      "0123456789abcdef",
      "abcDEF0123456789",
      "123456",
      "s3cr3tvalue",
      "AbCdEfGhIjKlMnOpQrStUv",
      "a".repeat(64),
      "abcdefghijklmnopqrstuvwxyz234567",
      "rita@",
    ]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain("@example.org");
    expect(out).toContain("next=/");
  });
});
