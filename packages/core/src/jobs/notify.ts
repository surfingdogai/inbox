import type { MailOut, OutboundMail } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import { keyLine, keysDeliveredStatement, keysFor } from "../identity/pending";
import { items, parties } from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { readSettings, type Settings } from "../settings/schema";
import { moneyText } from "../util/money";
import { CUSTOMER_KINDS } from "../write/caller";
import { describe, rowToItem } from "../write/views";
import type { JobHandler } from "./runner";

/**
 * Turns a `notify` job into an email: to the customer when the item has a contact address, to the
 * owner when settings name one. Plain text first; every mail says what happened and what to do.
 *
 * The customer most often does not know which software a business runs, or that there is any: they
 * wrote to the business. So every email to them is the business speaking, in its own name and its
 * own words — its reply when there is one — and nothing in it names anyone else.
 */
export interface NotifyPayload {
  readonly to: "owner" | "customer";
  readonly itemId: string;
  readonly event: string;
  /** The transition that caused it, when one did. */
  readonly eventId?: string;
  /** The thread entry an outgoing message is, for `event: "message"`. */
  readonly entry?: string;
}

/** Who every email from this inbox is from — the business — and where a reply goes. */
export function senderOf(settings: Settings): Pick<OutboundMail, "from" | "replyTo"> {
  const business = settings.business.name || "the business";
  return {
    from: {
      address: settings.email.fromAddress ?? "inbox@localhost",
      name: settings.email.fromName || business,
    },
    ...(settings.email.replyTo ? { replyTo: settings.email.replyTo } : {}),
  };
}

export function notifyHandler(
  mailOut: MailOut,
  opts: { baseUrl?: string; secrets?: SecretBox | null } = {},
): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as NotifyPayload;
    const [row] = await db.orm.select().from(items).where(eq(items.id, p.itemId));
    if (!row) return { note: "item gone" };
    const item = rowToItem(row);
    const settings = await readSettings(db);
    const { from } = senderOf(settings);
    const appUrl = settings.notifications.appUrl ?? opts.baseUrl ?? "";

    if (p.to === "owner") {
      const to = settings.notifications.ownerEmail;
      if (!to) return { note: "no owner email configured" };
      const [party] = await db.orm
        .select({ displayName: parties.displayName })
        .from(parties)
        .where(eq(parties.id, item.partyId));
      const who = party?.displayName ?? "a customer";
      const mail: OutboundMail = {
        from,
        to: [to],
        subject: ownerSubject(item, p.event, who),
        text: [
          describe(item),
          "",
          `From: ${who}`,
          appUrl ? `Open: ${appUrl}/items/${item.id}` : "",
          "",
          "Reply in your inbox to answer.",
        ]
          .filter((l) => l !== null)
          .join("\n"),
      };
      await mailOut.send(mail);
      return { note: `owner ${to}` };
    }

    const email = await customerEmail(db, item.partyId);
    if (!email) return { note: "customer has no email" };
    // A first contact's key rides on the first email to the customer (ADR-017 §2.1), then is gone:
    // one quiet line, the business's, and only while the business keeps it on.
    const keys = settings.customers.emailKey ? await keysFor(db, opts.secrets ?? null, item.id) : [];
    const cause = await causeOf(db, p);
    const message = customerMail({
      item,
      event: p.event,
      business: settings.business.name.trim(),
      timezone: settings.business.timezone,
      byCustomer: cause.actorKind !== null && CUSTOMER_KINDS.has(cause.actorKind),
      words: cause.words,
    });
    const mail: OutboundMail = {
      ...senderOf(settings),
      to: [email],
      subject: message.subject,
      text: [
        ...message.lines,
        "",
        `Reference: ${item.id}`,
        ...(settings.email.replyTo ? ["Reply to this email to reach us."] : []),
        ...(settings.business.name.trim() ? ["", settings.business.name.trim()] : []),
        ...(keys.length ? ["", keyLine(keys.map((k) => k.key))] : []),
      ].join("\n"),
    };
    await mailOut.send(mail);
    if (keys.length) {
      await db.client.query(
        keysDeliveredStatement(
          item.id,
          keys.map((k) => k.network),
          now,
        ),
      );
    }
    return { note: `customer ${email}${keys.length ? ` with ${keys.length} key(s)` : ""}` };
  };
}

/** The address the item's customer gave: its party's (a merge moves the item to the known party). */
export async function customerEmail(db: Db, partyId: string): Promise<string | null> {
  const [party] = await db.orm.select({ contact: parties.contact }).from(parties).where(eq(parties.id, partyId));
  const email = (party?.contact as { email?: string } | null)?.email;
  return typeof email === "string" && email ? email : null;
}

/**
 * Who caused the email, and the business's own words with it: the reply an outgoing message is,
 * or the note the owner wrote with the transition (written in the same batch, at the same instant).
 */
async function causeOf(db: Db, p: NotifyPayload): Promise<{ actorKind: string | null; words: string | null }> {
  if (p.entry) {
    const { rows } = await db.client.query({
      sql: "SELECT actor_kind, body_text FROM thread_entries WHERE id = ? AND direction = 'out'",
      params: [p.entry],
      method: "all",
    });
    return { actorKind: rows[0] ? String(rows[0][0]) : null, words: textOf(rows[0]?.[1]) };
  }
  if (!p.eventId) return { actorKind: null, words: null };
  const { rows } = await db.client.query({
    sql: `SELECT e.actor_kind,
                 (SELECT t.body_text FROM thread_entries t
                   WHERE t.item_id = e.item_id AND t.direction = 'out' AND t.created_at = e.created_at
                   ORDER BY t.id DESC LIMIT 1)
            FROM item_events e WHERE e.id = ?`,
    params: [p.eventId],
    method: "all",
  });
  return { actorKind: rows[0] ? String(rows[0][0]) : null, words: textOf(rows[0]?.[1]) };
}

const textOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const TYPE_WORD: Record<Item["type"], string> = {
  message: "message",
  quote_request: "quote request",
  booking: "booking",
  order: "order",
  refund: "refund request",
};

function ownerSubject(item: Item, event: string, who: string): string {
  if (event === "create") return `New ${TYPE_WORD[item.type]} from ${who}: ${item.subject ?? ""}`.trim();
  if (event === "message") return `${who} replied: ${item.subject ?? TYPE_WORD[item.type]}`;
  return `${who}: ${TYPE_WORD[item.type]} ${item.state.replaceAll("_", " ")}`;
}

export interface CustomerMailInput {
  readonly item: Item;
  readonly event: string;
  /** The business's name, or empty. */
  readonly business: string;
  /** The business's timezone, for the times it writes. */
  readonly timezone: string;
  /** The customer did this themselves (cancelled, declined a quote). */
  readonly byCustomer?: boolean;
  /** The business's own words with it: a reply, or the note written with the change. */
  readonly words?: string | null;
}

/**
 * What the business tells its customer, in its own voice: a subject and the opening lines. Pure,
 * so every wording is checked in tests on both runtimes.
 */
export function customerMail(input: CustomerMailInput): { subject: string; lines: string[] } {
  const { item, words } = input;
  const s = item.subject ?? TYPE_WORD[item.type];
  const q = `"${s}"`;
  const said = words ? ["", words] : [];
  const out = (subject: string, ...lines: string[]) => ({ subject, lines: [...lines, ...said] });
  // A reply the business wrote is the email; a sentence about it would only be in the way.
  if (input.event === "message" || (item.type === "message" && item.state === "answered")) {
    return { subject: `Re: ${s}`, lines: words ? [words] : [`We have answered your message ${q}.`] };
  }
  switch (item.type) {
    case "booking": {
      const when = whenIn(item.payload.startTime, input.timezone);
      switch (item.state) {
        case "confirmed":
          return out(`Confirmed: ${s}`, `Your booking ${q} for ${when} is confirmed.`);
        case "proposed": {
          const proposed = item.payload.proposed?.startTime;
          return out(
            `Another time for ${s}`,
            proposed
              ? `We would like to propose another time for ${q}: ${whenIn(proposed, input.timezone)}.`
              : `We would like to propose another time for ${q}.`,
          );
        }
        case "needs_info":
          return out(`We need a detail about ${s}`, `We need a little more detail about your booking ${q}.`);
        case "declined":
          return out(`We cannot take ${s}`, `Sorry, we cannot take your booking ${q} for ${when}.`);
        case "cancelled_by_business":
          return out(`Cancelled: ${s}`, `We are sorry: we had to cancel your booking ${q} for ${when}.`);
      }
      break;
    }
    case "order": {
      const url = (item.payload as { paymentUrl?: string }).paymentUrl;
      switch (item.state) {
        case "needs_info":
          return out(`We need a detail about ${s}`, `We need a little more detail about your order ${q}.`);
        case "accepted":
          return out(`Accepted: ${s}`, `We have accepted your order ${q}.`);
        case "awaiting_payment":
          return out(
            `Payment for ${s}`,
            `We have accepted your order ${q}; it is waiting for your payment.`,
            ...(url ? [`You can pay here: ${url}`] : []),
          );
        case "paid":
          return out(`Payment received: ${s}`, `Thank you: we have received your payment for ${q}.`);
        case "payment_failed":
          return out(
            `Your payment for ${s} did not go through`,
            `Your payment for ${q} did not go through. You can still pay${url ? `: ${url}` : "."}`,
          );
        case "fulfilled":
          return out(`Fulfilled: ${s}`, `We have fulfilled your order ${q}.`);
        case "declined":
          return out(`We cannot take ${s}`, `Sorry, we cannot take your order ${q}.`);
        case "cancelled":
          return input.byCustomer
            ? out(`Cancelled: ${s}`, `Your order ${q} is cancelled, as you asked.`)
            : out(`Cancelled: ${s}`, `We are sorry: we had to cancel your order ${q}.`);
      }
      break;
    }
    case "quote_request": {
      switch (item.state) {
        case "needs_info":
          return out(`We need a detail about ${s}`, `We need a little more detail about your request ${q}.`);
        case "quoted": {
          const quote = (
            item.payload as { quote?: { totalPrice?: { value: number; currency: string }; notes?: string } }
          ).quote;
          const total = quote?.totalPrice ? moneyText(quote.totalPrice) : null;
          return out(
            `Our quote for ${s}`,
            total ? `Here is our quote for ${q}: ${total}.` : `Here is our quote for ${q}.`,
            ...(quote?.notes?.trim() ? ["", quote.notes.trim()] : []),
          );
        }
        case "declined":
          return input.byCustomer
            ? out(`Declined: ${s}`, `You declined our quote for ${q}. Thank you for letting us know.`)
            : out(`We cannot take ${s}`, `Sorry, we cannot take on ${q}.`);
      }
      break;
    }
    case "refund": {
      switch (item.state) {
        case "approved":
          return out("Your refund is approved", "We have approved your refund request.");
        case "rejected":
          return out("Your refund request", "Sorry, we cannot approve your refund request.");
        case "refunded":
          return out("Your refund", "We have refunded you.");
      }
      break;
    }
  }
  return out(
    `${s}: ${item.state.replaceAll("_", " ")}`,
    `Your ${TYPE_WORD[item.type]} ${q} is now ${item.state.replaceAll("_", " ")}.`,
  );
}

/** A time as the business writes it: in its own timezone, with the zone named only when it is UTC. */
export function whenIn(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const utc = `${d.toISOString().replace("T", " ").slice(0, 16)} UTC`;
  if (!timezone || timezone === "UTC") return utc;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d);
  } catch {
    return utc;
  }
}
