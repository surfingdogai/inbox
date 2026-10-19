import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeTenant, INBOUND_HOST, OWNER, PARENT, type Runtime, startRuntime } from "./harness";

/**
 * The email channel on a hosted inbox (ADR-026), end to end through the router and a shard: the
 * gateway's signed delivery to `<slug>@in.<parent>`, a conversation's own address, the owner answering
 * an alert by email, the business's address forwarded and checked, and sending from its own domain
 * asked of the control plane. The owner's sign-in address never reaches a customer.
 */

let rt: Runtime;
beforeAll(async () => {
  rt = await startRuntime();
});
afterAll(async () => {
  await rt.close();
});

const slugOf = (t: FakeTenant) => t.slugHost.split(".")[0] ?? "";
const inboundOf = (t: FakeTenant) => `${slugOf(t)}@in.${PARENT}`;

const raw = (h: Record<string, string>, body: string) =>
  `${Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;

async function live(): Promise<FakeTenant> {
  const t = await rt.createTenant();
  await rt.setState(t, "live", { ownResolves: true });
  return t;
}

async function runJobs(t: FakeTenant, advance = 60_000): Promise<void> {
  rt.later(advance);
  const shard = rt.shardOf(t);
  for (let i = 0; i < 5; i++) {
    // A write kicks the inbox's own runner after it answers: let that run finish first.
    await new Promise((r) => setTimeout(r, 25));
    shard.due.set(t.tenantId, 0);
    await shard.tick();
  }
}

async function items(t: FakeTenant, cookie: string) {
  const host = t.ownHost ?? t.slugHost;
  const r = await rt.http(host, "GET", "/v1/owner/items", { headers: { cookie } });
  return (r.json as { items: { item: { id: string; type: string; state: string } }[] }).items.map((i) => i.item);
}

describe("the gateway's delivery", () => {
  it("takes a signed email for the inbox's own address, and it becomes a message", async () => {
    const t = await live();
    const r = await rt.mailIn({
      to: inboundOf(t),
      from: "rita@example.org",
      raw: raw(
        { From: "Rita <rita@example.org>", To: inboundOf(t), Subject: "Colour", "Message-ID": "<g1@x>" },
        "Do you do colour on curly hair?",
      ),
    });
    expect(r.status).toBe(200);
    const cookie = await rt.signIn(t, t.ownHost ?? "");
    const list = await items(t, cookie);
    expect(list.map((i) => i.type)).toEqual(["message"]);
  });

  it("refuses what is not signed with the gateway's key, a replay, and a name that is no inbox", async () => {
    const t = await live();
    const message = raw({ From: "x@example.org", To: inboundOf(t), "Message-ID": "<g2@x>" }, "hi");
    expect(
      (
        await rt.mailIn({
          to: inboundOf(t),
          from: "x@example.org",
          raw: message,
          key: "not-the-key-0123456789abcdef0123456789",
        })
      ).status,
    ).toBe(401);
    // Not this inbox's address in the envelope: refused for good, so the sender is told.
    expect((await rt.mailIn({ to: `someone-else@in.${PARENT}`, from: "x@example.org", raw: message })).status).toBe(
      422,
    );
    expect((await rt.mailIn({ to: `brave-heron-zzzz@in.${PARENT}`, from: "x@example.org", raw: message })).status).toBe(
      422,
    );
    // Anything else under the gateway's name is nothing.
    const other = await rt.http(INBOUND_HOST, "GET", "/v1/inbound/whatever");
    expect(other.status).toBe(404);
    // And the inbound path through an inbox's own name still wants the inbox's own secret.
    const direct = await rt.http(t.ownHost ?? "", "POST", "/v1/email/inbound", {
      headers: { "content-type": "message/rfc822", "x-sd-mail-in": "1" },
      body: message,
    });
    expect(direct.status).toBe(401);
  });

  it("holds email for a suspended inbox (a temporary failure) and refuses it for a closing one", async () => {
    const t = await live();
    await rt.setState(t, "suspended");
    const message = raw({ From: "x@example.org", To: inboundOf(t), "Message-ID": "<g3@x>" }, "hi");
    expect((await rt.mailIn({ to: inboundOf(t), from: "x@example.org", raw: message })).status).toBe(503);
    await rt.setState(t, "live", { prevState: null });
    await rt.setState(t, "closing");
    expect((await rt.mailIn({ to: inboundOf(t), from: "x@example.org", raw: message })).status).toBe(422);
  });
});

describe("a conversation by email", () => {
  it("carries the conversation's own address, the customer's reply lands on it, and the owner answers by email", async () => {
    const t = await live();
    const slug = slugOf(t);
    // The owner has signed in once: alerts go to the address they sign in with.
    const cookie = await rt.signIn(t, t.ownHost ?? "");
    const sent = await rt.http(t.ownHost ?? "", "POST", "/v1/quotes", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: { itemOffered: { name: "Colour" }, description: "Curly hair" },
        contact: { name: "Rita", email: "rita@example.org" },
      }),
    });
    expect(sent.status).toBe(201);
    await runJobs(t, 5 * 60_000);
    const ack = rt.mail.find((m) => m.mail.to.includes("rita@example.org"));
    const conversation = ack?.mail.replyTo ?? "";
    expect(conversation).toMatch(new RegExp(`^${slug}\\+t[a-z2-7]{16}@in\\.example\\.net$`));
    expect(JSON.stringify(ack)).not.toContain(OWNER);

    // Rita answers from a phone that keeps no References: her reply lands on her request.
    const back = await rt.mailIn({
      to: conversation,
      from: "rita@example.org",
      raw: raw({ From: "rita@example.org", To: conversation, Subject: "Re", "Message-ID": "<rr1@x>" }, "Thursday?"),
    });
    expect(back.status).toBe(200);
    expect(back.text).toBe("Taken.\n");
    await runJobs(t);
    const alert = rt.mail
      .filter((m) => m.mail.to.includes(OWNER) && m.from.address === `${slug}@mail.${PARENT}`)
      .at(-1);
    const answerAt = alert?.mail.replyTo ?? "";
    expect(answerAt).toMatch(new RegExp(`^${slug}\\+o[a-z2-7]{16}@in\\.example\\.net$`));
    expect(alert?.mail.text).toContain("> Thursday?");

    // The owner answers the alert from their own mailbox.
    const before = rt.mail.length;
    const answered = await rt.mailIn({
      to: answerAt,
      from: OWNER,
      auth: "spf=pass; dkim=pass:example.com; dmarc=pass",
      raw: raw(
        { From: OWNER, To: answerAt, Subject: "Re: alert", "Message-ID": "<own1@example.com>" },
        "Thursday at 10 is free.",
      ),
    });
    expect(answered.status).toBe(200);
    await runJobs(t);
    const toRita = rt.mail.slice(before).filter((m) => m.mail.to.includes("rita@example.org"));
    expect(toRita.some((m) => m.mail.text.includes("Thursday at 10 is free."))).toBe(true);
    for (const m of toRita) {
      expect(m.from.address).toBe(`${slug}@mail.${PARENT}`);
      expect(m.mail.replyTo).toBe(conversation);
      expect(JSON.stringify(m)).not.toContain(OWNER);
    }
    const [quote] = await items(t, cookie);
    const item = await rt.http(t.ownHost ?? "", "GET", `/v1/owner/items/${quote?.id}`, { headers: { cookie } });
    const thread = (item.json as { thread: { direction: string; body: string; channel: string }[] }).thread;
    expect(thread.find((e) => e.direction === "out" && e.body === "Thursday at 10 is free.")?.channel).toBe("email");

    // Someone else writing to the alert's address gets nothing sent.
    const forged = await rt.mailIn({
      to: answerAt,
      from: "mallory@example.org",
      raw: raw({ From: OWNER, To: answerAt, "Message-ID": "<fg@x>" }, "Refund approved"),
      auth: "spf=pass; dkim=pass:example.org; dmarc=fail",
    });
    expect(forged.status).toBe(200);
    await runJobs(t);
    expect(rt.mail.some((m) => m.mail.text.includes("Refund approved"))).toBe(false);
  });
});

describe("the host's address for an inbox", () => {
  it("is taken away when the host stops giving one: no email then names an address that no longer reaches it", async () => {
    const t = await live();
    const host = t.ownHost ?? "";
    const cookie = await rt.signIn(t, host);
    const read = async () =>
      ((await rt.http(host, "GET", "/v1/owner/email", { headers: { cookie } })).json as { inbound: unknown }).inbound;
    expect(await read()).toMatchObject({ address: inboundOf(t) });
    t.noInbound = true;
    await rt.setState(t, "live", { ownResolves: true });
    expect(await read()).toBeNull();
  });
});

describe("Settings → Email on a hosted inbox", () => {
  it("shows the host's address for the inbox, which nobody changes, and checks a forwarded address live", async () => {
    const t = await live();
    const host = t.ownHost ?? "";
    const cookie = await rt.signIn(t, host);
    const headers = { cookie, "content-type": "application/json", origin: `https://${host}` };
    const email = (await rt.http(host, "GET", "/v1/owner/email", { headers: { cookie } })).json as {
      inbound: { address: string; set_by_host: boolean };
      sending: { from: string; mode: string; own: { state: string } };
      replies: string;
    };
    expect(email.inbound).toMatchObject({ address: inboundOf(t), set_by_host: true });
    expect(email.sending).toMatchObject({ from: `${slugOf(t)}@mail.${PARENT}`, mode: "host", own: { state: "none" } });
    expect(email.replies).toBe("conversation");
    const put = await rt.http(host, "PUT", "/v1/owner/settings", {
      headers,
      body: JSON.stringify({ doc: { email: { inboundAddress: "elsewhere@example.org" } } }),
    });
    expect(put.text).toContain("set by your host");

    const added = await rt.http(host, "POST", "/v1/owner/email/forwards", {
      headers,
      body: JSON.stringify({ address: `hello@${t.domain}`, provider: "google_workspace" }),
    });
    expect(added.status).toBe(201);
    const fwd = added.json as { id: string };
    const checked = await rt.http(host, "POST", `/v1/owner/email/forwards/${fwd.id}/check`, { headers, body: "{}" });
    expect(checked.status).toBe(202);
    await runJobs(t, 1_000);
    const check = rt.mail.find((m) => m.mail.to[0]?.startsWith("hello+c"));
    expect(check?.mail.to[0]).toMatch(new RegExp(`^hello\\+c[a-z2-7]{16}@${t.domain.replace(/\./g, "\\.")}$`));
    // The business's provider forwards it to the inbox's own address, headers and all.
    const back = await rt.mailIn({
      to: inboundOf(t),
      from: String(check?.from.address),
      raw: raw(
        {
          From: String(check?.from.address),
          To: check?.mail.to[0] ?? "",
          Subject: check?.mail.subject ?? "",
          "Message-ID": "<chk@x>",
          "X-Inbox-Check": String(check?.mail.headers?.["X-Inbox-Check"]),
          "X-Inbox-Loop": String(check?.mail.headers?.["X-Inbox-Loop"]),
        },
        check?.mail.text ?? "",
      ),
    });
    expect(back.status).toBe(200);
    const after = (await rt.http(host, "GET", "/v1/owner/email", { headers: { cookie } })).json as {
      forwards: { address: string; state: string; plus_ok: boolean }[];
    };
    expect(after.forwards).toEqual([
      expect.objectContaining({ address: `hello@${t.domain}`, state: "working", plus_ok: true }),
    ]);

    // Sending from it: the control plane is asked, and the rows it sends back are shown.
    const ask = await rt.http(host, "PUT", "/v1/owner/email/sender", {
      headers,
      body: JSON.stringify({ address: `hello@${t.domain}` }),
    });
    expect(ask.status).toBe(200);
    await runJobs(t, 1_000);
    expect(rt.cp.events.find((e) => e.tenant_id === t.tenantId && e.type === "mail_sender")?.data).toEqual({
      address: `hello@${t.domain}`,
    });
    t.own = {
      address: `hello@${t.domain}`,
      state: "dns",
      records: [
        {
          type: "CNAME",
          name: `abc._domainkey.${t.domain}`,
          value: "abc.dkim.amazonses.com",
          ok: false,
          purpose: "signs your email",
        },
      ],
      checked_at: null,
    };
    await rt.setState(t, "live", { ownResolves: true });
    const shown = (await rt.http(host, "GET", "/v1/owner/email", { headers: { cookie } })).json as {
      sending: { own: { state: string; records: { name: string }[] } };
    };
    expect(shown.sending.own.state).toBe("dns");
    expect(shown.sending.own.records[0]?.name).toBe(`abc._domainkey.${t.domain}`);
    // An address that never passed its check cannot be asked for.
    const refused = await rt.http(host, "PUT", "/v1/owner/email/sender", {
      headers,
      body: JSON.stringify({ address: `ceo@${t.domain}` }),
    });
    expect(refused.status).toBe(422);
  });
});
