import { createApiKey, sendStepUpCode } from "@surfingdog/adapters";
import { schema, ulid } from "@surfingdog/core";
import { logMailOut, type MailOut, type SqliteSnapshot } from "@surfingdog/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unzip } from "../../../packages/core/test/unzip";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * Downloading the inbox through the owner's door, on both runtimes: the code a download needs goes to
 * the owner's own address and nowhere else, works once, for ten minutes, for five tries; the zip
 * comes back; the owner is told. The copy here is a stand-in (`snapshot`); the real one, over a
 * database file, is in download.node.test.ts. Without a way to copy its database (D1), the inbox
 * says so before it sends any code.
 */
const BASE = "https://inbox.test";
const OWNER = "rosa@salaorosa.pt";
const T0 = Date.parse("2026-10-12T14:03:00Z");

async function setup(opts: { snapshot?: boolean; mailOut?: MailOut } = {}) {
  const db = await freshDb();
  let now = T0;
  const mail = logMailOut();
  const strips: string[][] = [];
  const snapshot: SqliteSnapshot = async (strip) => {
    strips.push([...strip]);
    return { bytes: new TextEncoder().encode("SQLite format 3\u0000"), tables: [{ name: "items", rows: 3 }] };
  };
  const inbox = createInbox({
    db,
    mailOut: opts.mailOut ?? mail,
    baseUrl: BASE,
    now: () => now,
    background: () => {},
    ...(opts.snapshot === false ? {} : { snapshot }),
  });
  const userId = ulid();
  await db.orm.insert(schema.users).values({ id: userId, email: OWNER, role: "owner", createdAt: T0 });
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Salão Rosa",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages: ["pt"],
    createdAt: T0,
    updatedAt: T0,
  });
  // A full owner key, as the command line mints it, for the owner who signed up: the owner in person.
  const owner = await createApiKey(db, { kind: "owner", name: "laptop", userId });
  const post = (path: string, body: unknown, key: string = owner.key) =>
    inbox.app.request(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  /** The code in the last email to the owner, which is only ever there. */
  const lastCode = () => /\b(\d{6})\b/.exec(mail.sent.filter((m) => m.to.includes(OWNER)).at(-1)?.subject ?? "")?.[1];
  return {
    db,
    inbox,
    mail,
    post,
    strips,
    lastCode,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("downloading the inbox", () => {
  afterEach(() => vi.restoreAllMocks());

  it("needs the code sent to the owner, gives the zip once, and tells the owner", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await setup();
    expect((await s.post("/v1/owner/download", {})).status).toBe(422);
    const asked = await s.post("/v1/owner/download/code", {});
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ sent_to: "r•••@s•••.pt", expires_at: "2026-10-12T14:13:00.000Z" });
    const code = s.lastCode();
    if (!code) throw new Error("no code mailed");
    expect(s.mail.sent.at(-1)).toMatchObject({
      to: [OWNER],
      subject: `${code} is your code to download Salão Rosa's inbox`,
    });

    const wrong = await s.post("/v1/owner/download", { code: code === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toMatchObject({ code: "bad_code" });
    const res = await s.post("/v1/owner/download", { code });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="salao-rosa-2026-10-12.zip"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const files = await unzip(new Uint8Array(await res.arrayBuffer()));
    expect(files.map((f) => f.name)).toEqual(["README.txt", "manifest.json", "inbox.db"]);
    expect(s.strips).toHaveLength(1);
    expect(s.strips[0]).toContain("DELETE FROM sessions");

    // The owner is told, and the code works once.
    expect(s.mail.sent.at(-1)).toMatchObject({ to: [OWNER], subject: "A copy of Salão Rosa's inbox was downloaded" });
    expect(s.mail.sent.at(-1)?.text).toContain("12 Oct 2026, 14:03 UTC");
    expect((await s.post("/v1/owner/download", { code })).status).toBe(422);
    // The code went to the owner's mailbox and nowhere else: never to a log.
    const said = [...logged.mock.calls, ...errors.mock.calls].flat().map(String).join("\n");
    expect(said).not.toContain(code);
  });

  it("stops a code after ten minutes, and a new code makes the last one stop working", async () => {
    const s = await setup();
    await s.post("/v1/owner/download/code", {});
    const first = s.lastCode();
    s.tick(10 * 60_000 + 1);
    const late = await s.post("/v1/owner/download", { code: first });
    expect(late.status).toBe(422);
    expect(await late.json()).toMatchObject({ code: "code_expired" });
    await s.post("/v1/owner/download/code", {});
    const second = s.lastCode();
    await s.post("/v1/owner/download/code", {});
    const third = s.lastCode();
    if (second !== third) expect((await s.post("/v1/owner/download", { code: second })).status).toBe(422);
    expect((await s.post("/v1/owner/download", { code: third })).status).toBe(200);
  });

  it("burns the code after five wrong tries", async () => {
    const s = await setup();
    await s.post("/v1/owner/download/code", {});
    const code = s.lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await s.post("/v1/owner/download", { code: wrong })).status).toBe(422);
    const sixth = await s.post("/v1/owner/download", { code });
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toMatchObject({ code: "too_many_attempts" });
    // The right code no longer works either, once the tries come back.
    s.tick(5 * 60_000);
    expect((await s.post("/v1/owner/download", { code })).status).toBe(422);
    expect(s.strips).toHaveLength(0);
  });

  it("is the owner's in person: never an integration key, and nobody without credentials", async () => {
    const s = await setup();
    const key = await createApiKey(s.db, { kind: "integration", name: "Zapier", scopes: ["inbox:read"] });
    const refused = await s.post("/v1/owner/download/code", {}, key.key);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "not_allowed" });
    const nobody = await s.inbox.app.request(
      new Request(`${BASE}/v1/owner/download/code`, { method: "POST", body: "{}" }),
    );
    expect(nobody.status).toBe(401);
    // Someone signed in as staff gets no code: what a download takes is the owner's.
    const staff = ulid();
    await s.db.orm.insert(schema.users).values({ id: staff, email: "ana@salaorosa.pt", role: "staff", createdAt: T0 });
    const words = { subject: (code: string) => code, text: (code: string) => code };
    await expect(
      sendStepUpCode(
        { db: s.db, mailOut: s.mail },
        {
          actor: { kind: "owner", id: staff, channel: "rest" },
          principal: { via: "session", id: "s1", name: "ana@salaorosa.pt", scopes: ["*"], userId: staff },
          tier: "verified_principal",
          sandbox: false,
        },
        "download",
        words,
      ),
    ).rejects.toMatchObject({ code: "not_allowed" });
    expect(s.mail.sent).toEqual([]);
  });

  it("says the code could not be sent when the email fails, without the code", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: MailOut = {
      sender: { address: "inbox@salaorosa.pt" },
      async send() {
        throw new Error("E_SENDER_NOT_VERIFIED");
      },
    };
    const s = await setup({ mailOut: failing });
    const res = await s.post("/v1/owner/download/code", {});
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: "mail_failed",
      detail: "The code could not be sent. Try again in a minute.",
    });
    expect(errors.mock.calls.flat().map(String).join("\n")).not.toMatch(/\b\d{6}\b/);
  });

  it("says how to copy the database instead where it cannot copy it, before sending any code", async () => {
    const s = await setup({ snapshot: false });
    const res = await s.post("/v1/owner/download/code", {});
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      code: "not_available",
      detail: expect.stringContaining("wrangler d1 export"),
    });
    expect(s.mail.sent).toEqual([]);
  });
});
