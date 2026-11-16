import type { SqliteClient } from "@surfingdog/platform";
import type { Capabilities } from "../src/capabilities/service";
import type { Contact } from "../src/domain/types";
import type { Caller } from "../src/write/caller";
import { WriteError } from "../src/write/errors";

/** A SqliteClient for whichever runtime the test runs on. */
export async function makeClient(): Promise<SqliteClient> {
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
    const spec = "cloudflare:test";
    const { env } = (await import(/* @vite-ignore */ spec)) as { env: { DB: unknown } };
    const { d1Client } = await import("@surfingdog/platform/cloudflare");
    return d1Client(env.DB as Parameters<typeof d1Client>[0]);
  }
  const { nodeSqliteClient } = await import("@surfingdog/platform/node");
  return nodeSqliteClient(":memory:");
}

/**
 * Empties every application table. Node tests get a fresh in-memory database per client, but D1
 * storage is isolated per test file, so tests in one file would otherwise see each other's rows.
 */
export async function resetTables(client: SqliteClient): Promise<void> {
  const { rows } = await client.query({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'search_fts%' AND name <> 'migrations'",
  });
  const tables = rows.map((r) => String(r[0]));
  await client.batch([
    { sql: "PRAGMA defer_foreign_keys = ON", method: "run" },
    ...tables.map((t) => ({ sql: `DELETE FROM "${t}"`, method: "run" as const })),
    { sql: "DELETE FROM search_fts", method: "run" },
  ]);
}

/** A fake number no one answers, a new one per call, so two test requests never match as one customer by phone. */
let phones = 0;
export const testPhone = () => `+1 555 ${String(++phones).padStart(6, "0")}`;

/** The number a request sent with an idempotency key is given: the same on its retry, so the retry is the same request. */
const keyedPhones = new Map<string, string>();
function phoneFor(key: string | undefined): string {
  if (!key) return testPhone();
  const known = keyedPhones.get(key);
  if (known) return known;
  const phone = testPhone();
  keyedPhones.set(key, phone);
  return phone;
}

/**
 * `contact` as an assistant brings it (ADR-048): a name when it has none, and a fake phone when it has no email
 * and no phone. A phone, not an email: it adds no acknowledgement email, no network key and no spam handle, so a
 * test that sent no contact behaves as before. `key`, the request's idempotency key: its retry gets the same number.
 */
export function clientOf(contact?: Contact | undefined, key?: string | undefined): Contact {
  return {
    ...contact,
    name: contact?.name || "Ana Test",
    ...(contact?.email || contact?.phone ? {} : { phone: phoneFor(key) }),
  };
}

/**
 * Capabilities whose assistants bring their person's details (ADR-048): requestQuote, createBooking, createOrder,
 * sendMessage without item_id and stays.request / stays.hold get `clientOf(contact)` for a `customer_agent` caller.
 * For tests about something else; the client rule's own tests use the capabilities as they are.
 */
export function withClient<C extends Capabilities>(caps: C): C {
  const filled = <I>(caller: Caller, input: I): I => {
    if (caller.actor.kind !== "customer_agent" || !input || typeof input !== "object") return input;
    const i = input as { contact?: Contact; item_id?: unknown; idempotency_key?: string };
    if (i.item_id !== undefined) return input;
    return { ...input, contact: clientOf(i.contact, i.idempotency_key) };
  };
  const wrap =
    <I, R, O>(fn: (caller: Caller, input: I, opts?: O) => Promise<R>) =>
    (caller: Caller, input: I, opts?: O): Promise<R> =>
      fn(caller, filled(caller, input), opts);
  caps.requestQuote = wrap(caps.requestQuote.bind(caps));
  caps.createBooking = wrap(caps.createBooking.bind(caps));
  caps.createOrder = wrap(caps.createOrder.bind(caps));
  caps.sendMessage = wrap(caps.sendMessage.bind(caps)) as typeof caps.sendMessage;
  const stays = caps.stays;
  const request = stays.request.bind(stays);
  const hold = stays.hold.bind(stays);
  stays.request = (caller, raw) => request(caller, filled(caller, raw));
  stays.hold = (caller, raw) => hold(caller, filled(caller, raw));
  return caps;
}

/**
 * A product on sale at a fixed price, made by the owner, for a test that orders (ADR-048: an assistant's order
 * names a product the business sells). Its id.
 */
export async function aProduct(
  caps: Capabilities,
  p: { readonly name?: string; readonly value: number; readonly currency?: string; readonly sku?: string },
): Promise<string> {
  const owner: Caller = {
    actor: { kind: "owner", id: "owner", channel: "owner_ui" },
    tier: "verified_principal",
    sandbox: false,
  };
  const made = await caps.setup.createProduct(owner, {
    name: p.name ?? "Bread",
    price: { value: p.value, currency: p.currency ?? "EUR" },
    active: true,
    ...(p.sku ? { sku: p.sku } : {}),
  });
  return made.id;
}

/**
 * Capabilities whose customers say yes at the confirm step (ADR-018 §5): a priced booking or order
 * asked for without `terms_sha` is sent again with the fingerprint its `confirm_terms` answer gave,
 * as an assistant does once its person confirmed the summary. Their assistants bring their person's
 * details too (`withClient`). For tests about something else; the confirm step's own tests use the
 * capabilities as they are.
 */
export function confirming<C extends Capabilities>(caps: C): C {
  withClient(caps);
  const again =
    <I extends { terms_sha?: string | undefined }, R, O>(fn: (caller: Caller, input: I, opts?: O) => Promise<R>) =>
    async (caller: Caller, input: I, opts?: O): Promise<R> => {
      try {
        return await fn(caller, input, opts);
      } catch (error) {
        const sha = (error as WriteError).details?.terms_sha;
        if (
          !(error instanceof WriteError) ||
          error.code !== "confirm_terms" ||
          input.terms_sha ||
          typeof sha !== "string"
        ) {
          throw error;
        }
        return fn(caller, { ...input, terms_sha: sha }, opts);
      }
    };
  caps.createBooking = again(caps.createBooking.bind(caps));
  caps.createOrder = again(caps.createOrder.bind(caps));
  return caps;
}

/**
 * Opening hours, Monday to Saturday 09:00 to 18:00, for the whole business: hours nobody set are no
 * hours (nothing is offered or booked in them), and a customer asks only for a time inside them
 * (ADR-044 §2), so a test that books opens the business first. Sunday stays closed.
 * Idempotent: a business that has hours keeps them.
 */
export async function openWeekdays(db: { client: SqliteClient }): Promise<void> {
  const day = [["09:00", "18:00"]];
  await openHours(db, { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day });
}

/**
 * Open every hour of every day, for tests about something other than hours (the spam filter, the
 * mail): any time they book is one the business takes. Idempotent like `openWeekdays`.
 */
export async function openAllWeek(db: { client: SqliteClient }): Promise<void> {
  const day = [["00:00", "24:00"]];
  await openHours(db, { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day });
}

async function openHours(db: { client: SqliteClient }, weekly: Record<string, string[][]>): Promise<void> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM availability_rules WHERE kind = 'open' AND service_id IS NULL LIMIT 1",
    method: "all",
  });
  if (rows.length) return;
  await db.client.query({
    sql: "INSERT INTO availability_rules (id, service_id, kind, weekly, created_at) VALUES (?, NULL, 'open', ?, ?)",
    params: [`hours${Math.random().toString(36).slice(2, 12)}`, JSON.stringify(weekly), Date.now()],
    method: "run",
  });
}
