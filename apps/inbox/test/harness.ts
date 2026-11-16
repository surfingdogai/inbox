import { type Contact, createDb, type Db, MIGRATIONS, schema, ulid } from "@surfingdog/core";
import { runMigrations, type SqliteClient } from "@surfingdog/platform";

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

/** A migrated, empty database for one test. */
export async function freshDb(): Promise<Db> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  const { rows } = await db.client.query({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'search_fts%' AND name <> 'migrations'",
  });
  await db.client.batch([
    { sql: "PRAGMA defer_foreign_keys = ON", method: "run" },
    ...rows.map((r) => ({ sql: `DELETE FROM "${String(r[0])}"`, method: "run" as const })),
    { sql: "DELETE FROM search_fts", method: "run" },
  ]);
  return db;
}

/**
 * A weekday (Monday to Friday, UTC) at least `daysAhead` days from now, as YYYY-MM-DD. The inbox
 * never books a time that has passed, so a test that books through a door with the real clock books
 * in the future, on a day the default opening hours cover.
 */
export function futureDay(daysAhead = 7): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The day after a YYYY-MM-DD, as YYYY-MM-DD. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
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

/** An owner key: the business writing, which brings no client (`sdi_own_…`, ADR-048). */
const OWNER_KEY = "sdi_own_";

/** A create of a new request, as `confirmed` fills its client: not a reply, and not the business's own. */
const NEW_REQUEST = /\/v1\/(bookings|orders|quotes|messages|stays|stays\/holds)\/?$/;

/**
 * A product on sale at a fixed price, for a test that orders (ADR-048: an assistant's order names a product the
 * business sells). Its id.
 */
export async function aProduct(
  db: Db,
  p: { readonly value: number; readonly currency?: string; readonly name?: string; readonly sku?: string },
): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await db.orm.insert(schema.products).values({
    id,
    name: p.name ?? "Bread",
    ...(p.sku ? { sku: p.sku } : {}),
    price: { value: p.value, currency: p.currency ?? "EUR" },
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/**
 * A request as a customer's assistant sends it once its person confirmed the summary (ADR-018 §5): a
 * priced booking or order answered `409 confirm_terms` is sent again, as it was, with the fingerprint
 * it was given. Anything else is answered as it is. A new request carries its person's details, as an
 * assistant brings them (`clientOf`, ADR-048), unless it is the business's own.
 */
export async function confirmed(
  send: (request: Request) => Response | Promise<Response>,
  incoming: Request,
): Promise<Response> {
  const request = await withClientBody(incoming);
  // Only a create: an acceptance's confirm step is each test's own to answer.
  const create = request.method === "POST" && /\/v1\/(bookings|orders)\/?$/.test(new URL(request.url).pathname);
  const body = create ? await request.clone().text() : "";
  const first = await send(request);
  if (first.status !== 409 || !body) return first;
  const problem = (await first
    .clone()
    .json()
    .catch(() => null)) as { code?: string; details?: { terms_sha?: unknown } } | null;
  const sha = problem?.code === "confirm_terms" ? problem.details?.terms_sha : undefined;
  if (typeof sha !== "string") return first;
  const json = JSON.parse(body) as Record<string, unknown>;
  return send(
    new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ ...json, terms_sha: sha }),
    }),
  );
}

/**
 * The request with its person's details filled in (`clientOf`), when it is a new request an assistant sends:
 * never a reply (`item_id`), and never one the business sends with its own key or session.
 */
async function withClientBody(request: Request): Promise<Request> {
  if (request.method !== "POST" || !NEW_REQUEST.test(new URL(request.url).pathname)) return request;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (bearer.startsWith(OWNER_KEY) || request.headers.has("cookie")) return request;
  const text = await request.clone().text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return request;
  }
  if (!json || typeof json !== "object" || Array.isArray(json) || json.item_id !== undefined) return request;
  const key =
    (typeof json.idempotency_key === "string" ? json.idempotency_key : undefined) ??
    request.headers.get("idempotency-key") ??
    undefined;
  const filled = { ...json, contact: clientOf(json.contact as Contact | undefined, key) };
  return new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(filled) });
}

/** The tools that make a new request, whose person's details `confirmedTool` fills in. */
const NEW_REQUEST_TOOLS = new Set(["create_booking", "create_order", "request_quote", "request_stay", "hold_stay"]);

/**
 * A tool call as an assistant makes it once its person confirmed: a priced create answered with the
 * summary to confirm (`structuredContent.confirm`) is called again with its `terms_sha`. A new request
 * carries its person's details, as an assistant brings them (`clientOf`, ADR-048).
 */
export async function confirmedTool<R>(
  call: (params: { name: string; arguments: Record<string, unknown> }) => Promise<R>,
  incoming: { name: string; arguments: Record<string, unknown> },
): Promise<R> {
  const a = incoming.arguments;
  const fills = NEW_REQUEST_TOOLS.has(incoming.name) || (incoming.name === "send_message" && a.item_id === undefined);
  const params = fills
    ? {
        ...incoming,
        arguments: {
          ...a,
          contact: clientOf(
            a.contact as Contact | undefined,
            typeof a.idempotency_key === "string" ? a.idempotency_key : undefined,
          ),
        },
      }
    : incoming;
  const first = await call(params);
  const sha = (first as { structuredContent?: { confirm?: { terms_sha?: unknown } } }).structuredContent?.confirm
    ?.terms_sha;
  if (typeof sha !== "string") return first;
  return call({ ...params, arguments: { ...params.arguments, terms_sha: sha } });
}

/**
 * Opening hours, Monday to Friday 08:00 to 18:00, for the whole business: hours nobody set are no
 * hours (nothing is offered or booked in them), and a customer asks only for a time inside them
 * (ADR-044 §2), so a test that books opens the business first.
 * Idempotent: a business that has hours keeps them.
 */
export async function openWeekdays(db: Db): Promise<void> {
  const day = [["08:00", "18:00"]];
  await openHours(db, { mon: day, tue: day, wed: day, thu: day, fri: day });
}

/**
 * Open every hour of every day, for a test that books a time counted from the clock it runs on
 * ("in two hours", "in three days"): whatever the day and hour, the time is one the business takes.
 * Idempotent like `openWeekdays`.
 */
export async function openAllWeek(db: Db): Promise<void> {
  const day = [["00:00", "24:00"]];
  await openHours(db, { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day });
}

/** Rounds a time up to the half hour, the grid the tests' services are booked on. */
export function onTheGrid(ms: number): number {
  return Math.ceil(ms / 1_800_000) * 1_800_000;
}

async function openHours(db: Db, weekly: Record<string, string[][]>): Promise<void> {
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
