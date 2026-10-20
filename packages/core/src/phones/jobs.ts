import { eq } from "drizzle-orm";
import { calendarFit } from "../capabilities/availability";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import type { JobHandler } from "../jobs/runner";
import { ensureJob } from "../jobs/schedule";
import { machines } from "../machine/tables";
import { business, items, products, services } from "../schema/tables";
import { rowToItem } from "../write/views";
import { buildPushPayload, encodePayload } from "./payload";
import type { PhoneCapabilities } from "./phones";
import { deliverAt, pushKindOf, readPrefs } from "./prefs";

/**
 * Notifications to the owner's phones (ADR-026), as jobs. Whatever the owner is emailed about (a new
 * request, a reply, a change asked for, a draft waiting), each phone that wants to hear of it is sent
 * one notification: at once, or when its quiet hours end. A notification held overnight is built when
 * it goes, so one about something already dealt with on the computer is not sent at all.
 */
export const PHONE_PUSH_KIND = "phone_push";
export const PHONE_PUSH_ONE_KIND = "phone_push_one";
/** A phone hears at most this many notifications in an hour; the inbox itself shows the rest. */
export const MAX_PUSHES_PER_HOUR = 30;
/** Rules get a moment to answer a new request first, so the phone is told whether they did. */
export const PUSH_DELAY_MS = 3_000;

interface FanoutPayload {
  readonly itemId: string;
  readonly event: string;
  readonly key: string;
}

interface OnePayload {
  readonly deviceId: string;
  readonly itemId: string;
  readonly event: string;
  readonly held: boolean;
}

/**
 * Whether the owner has something to do on it: a person was asked for, something happened after it
 * arrived (a reply, a change asked for, a draft waiting), or it is as it arrived, nobody having
 * answered it yet. A new request a rule already confirmed or answered is `handled`.
 */
export function awaitsOwner(item: Item, event: string): boolean {
  return item.flags.needsHuman === true || event !== "create" || item.state === machines[item.type].initial;
}

/** Whether any phone hears anything here: no phone, no job. */
async function anyListener(db: Db): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM phone_devices WHERE revoked_at IS NULL AND confirmed_at IS NOT NULL AND push_state = 'on' LIMIT 1",
    method: "all",
  });
  return rows.length > 0;
}

/**
 * The owner's `notify` job, and a phone notification beside it: queued before the email is even
 * tried, so a phone hears of a request on an inbox that cannot send email at all.
 */
export function withPhonePush(notify: JobHandler): JobHandler {
  return async (job, ctx) => {
    const p = job.payload as { to?: string; itemId?: string; event?: string };
    if (p.to === "owner" && typeof p.itemId === "string" && (await anyListener(ctx.db))) {
      await ensureJob(ctx.db, PHONE_PUSH_KIND, `${PHONE_PUSH_KIND}:${job.id}`, {
        now: ctx.now,
        runAt: ctx.now + PUSH_DELAY_MS,
        payload: { itemId: p.itemId, event: p.event ?? "create", key: job.id } satisfies FanoutPayload,
      });
    }
    return notify(job, ctx);
  };
}

async function timezoneOf(db: Db): Promise<{ tz: string; name: string }> {
  const [b] = await db.orm.select({ tz: business.timezone, name: business.name }).from(business);
  return { tz: b?.tz ?? "UTC", name: b?.name ?? "" };
}

/** One job per phone that wants it, due now or when its quiet hours end. */
export function phonePushFanoutHandler(phones: PhoneCapabilities): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as FanoutPayload;
    const [row] = await db.orm.select().from(items).where(eq(items.id, p.itemId));
    if (!row) return { note: "item gone" };
    const item = rowToItem(row);
    if (item.flags.sandbox) return { note: "test item: no notification" };
    const kind = pushKindOf(item, awaitsOwner(item, p.event));
    const { tz } = await timezoneOf(db);
    let queued = 0;
    for (const device of await phones.listeners()) {
      const prefs = readPrefs(device.notify);
      if (!prefs.kinds[kind]) continue;
      const at = deliverAt(prefs, now, tz);
      await ensureJob(db, PHONE_PUSH_ONE_KIND, `${PHONE_PUSH_ONE_KIND}:${p.key}:${device.id}`, {
        now,
        runAt: at,
        payload: { deviceId: device.id, itemId: item.id, event: p.event, held: at > now } satisfies OnePayload,
      });
      queued++;
    }
    return { note: `${queued} phone${queued === 1 ? "" : "s"}` };
  };
}

/** The newest words the customer wrote on an item: its last message in, else what the request said. */
async function newestWords(db: Db, itemId: string, fallback: string | undefined): Promise<string | null> {
  const { rows } = await db.client.query({
    sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 1",
    params: [itemId],
    method: "all",
  });
  const text = rows[0]?.[0];
  return typeof text === "string" && text.trim() ? text : (fallback ?? null);
}

async function displayName(db: Db, partyId: string): Promise<string | null> {
  const { rows } = await db.client.query({
    sql: "SELECT display_name FROM parties WHERE id = ? AND erased_at IS NULL",
    params: [partyId],
    method: "all",
  });
  const name = rows[0]?.[0];
  return typeof name === "string" && name.trim() ? name : null;
}

/**
 * The business's own name for what is asked for, from its catalogue: the service booked, or the
 * service or product a quote is for. Null when the catalogue has none, so a customer's own words for
 * it never reach a lock screen without details on.
 */
async function catalogueName(db: Db, item: Item): Promise<string | null> {
  const service = async (id: string | undefined) => {
    if (!id) return null;
    const [row] = await db.orm.select({ name: services.name }).from(services).where(eq(services.id, id));
    return row?.name?.trim() || null;
  };
  if (item.type === "booking") return service(item.payload.reservationFor.serviceId);
  if (item.type === "quote_request") {
    const named = await service(item.payload.itemOffered.serviceId);
    if (named || !item.payload.itemOffered.productId) return named;
    const [row] = await db.orm
      .select({ name: products.name })
      .from(products)
      .where(eq(products.id, item.payload.itemOffered.productId));
    return row?.name?.trim() || null;
  }
  return null;
}

/** One notification to one phone: built now, from the item as it is now, for that phone's settings. */
export function phonePushOneHandler(phones: PhoneCapabilities): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as OnePayload;
    const device = (await phones.listeners()).find((d) => d.id === p.deviceId);
    if (!device) return { note: "phone removed or push off" };
    const [row] = await db.orm.select().from(items).where(eq(items.id, p.itemId));
    if (!row) return { note: "item gone" };
    const item = rowToItem(row);
    const awaits = awaitsOwner(item, p.event);
    // Held overnight, and dealt with since (on the computer, or by a rule): nothing to wake anyone for.
    if (p.held && p.event === "create" && (!awaits || item.closedAt !== null)) return { note: "dealt with" };
    const { rows } = await db.client.query({
      sql: `SELECT COUNT(*) FROM jobs WHERE kind = ? AND status = 'done' AND done_at > ?
              AND json_extract(payload, '$.deviceId') = ?`,
      params: [PHONE_PUSH_ONE_KIND, now - 3_600_000, p.deviceId],
      method: "all",
    });
    if (Number(rows[0]?.[0] ?? 0) >= MAX_PUSHES_PER_HOUR) return { note: "this hour's notifications are used up" };
    const prefs = readPrefs(device.notify);
    const { tz } = await timezoneOf(db);
    const fallback =
      item.type === "message"
        ? item.payload.text
        : item.type === "quote_request"
          ? item.payload.description
          : item.type === "booking" || item.type === "order"
            ? item.payload.notes
            : undefined;
    const kind = pushKindOf(item, awaits);
    const fit = await calendarFit(db, item, tz);
    const payload = buildPushPayload({
      item,
      kind,
      event: p.event,
      details: prefs.details,
      who: prefs.details ? await displayName(db, item.partyId) : null,
      text: prefs.details ? await newestWords(db, item.id, fallback) : null,
      offered: await catalogueName(db, item),
      free: fit ? fit.free : null,
      timezone: tz,
      now,
    });
    // A new booking request's notification lives no longer than until it starts: "Accept 14:00" after
    // 14:00 is no use. Anything later about a booking (a reply) goes as anything else does.
    const startsIn =
      item.type === "booking" && p.event === "create"
        ? Math.floor((Date.parse(item.payload.startTime) - now) / 1000)
        : Number.POSITIVE_INFINITY;
    if (startsIn <= 0) return { note: "already started" };
    const r = await phones.deliver(
      p.deviceId,
      encodePayload(payload),
      { urgency: kind === "handled" ? "normal" : "high", ttlS: Math.min(86_400, startsIn), item: item.id, key: job.id },
      now,
    );
    return { note: r.note };
  };
}
