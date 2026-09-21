import type { MailOut, OutboundMail } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import { items, parties } from "../schema/tables";
import { readSettings } from "../settings/schema";
import { describe, rowToItem } from "../write/views";
import type { JobHandler } from "./runner";

/**
 * Turns a `notify` job into an email: to the customer when the item has a contact address, to the
 * owner when settings name one. Plain text first; every mail says what happened and what to do.
 */
export interface NotifyPayload {
  readonly to: "owner" | "customer";
  readonly itemId: string;
  readonly event: string;
}

export function notifyHandler(mailOut: MailOut, opts: { baseUrl?: string } = {}): JobHandler {
  return async (job, { db }) => {
    const p = job.payload as NotifyPayload;
    const [row] = await db.orm.select().from(items).where(eq(items.id, p.itemId));
    if (!row) return { note: "item gone" };
    const item = rowToItem(row);
    const settings = await readSettings(db);
    const business = settings.business.name || "the business";
    const from = { address: settings.email.fromAddress ?? "inbox@localhost", ...(settings.email.fromName ? { name: settings.email.fromName } : { name: business }) };
    const appUrl = settings.notifications.appUrl ?? opts.baseUrl ?? "";

    if (p.to === "owner") {
      const to = settings.notifications.ownerEmail;
      if (!to) return { note: "no owner email configured" };
      const [party] = await db.orm.select({ displayName: parties.displayName }).from(parties).where(eq(parties.id, item.partyId));
      const who = party?.displayName ?? "a customer";
      const mail: OutboundMail = {
        from,
        to: [to],
        subject: ownerSubject(item, p.event, who),
        text: [describe(item), "", `From: ${who}`, appUrl ? `Open: ${appUrl}/items/${item.id}` : "", "", "Reply in your inbox to answer."].filter((l) => l !== null).join("\n"),
      };
      await mailOut.send(mail);
      return { note: `owner ${to}` };
    }

    const [party] = await db.orm.select({ contact: parties.contact }).from(parties).where(eq(parties.id, item.partyId));
    const email = (party?.contact as { email?: string } | null)?.email;
    if (!email) return { note: "customer has no email" };
    const mail: OutboundMail = {
      from,
      to: [email],
      ...(settings.email.replyTo ? { replyTo: settings.email.replyTo } : {}),
      subject: customerSubject(item, p.event, business),
      text: [describe(item), "", `This message is from ${business}.`, settings.email.replyTo ? "Reply to this email to reach them." : ""].join("\n"),
    };
    await mailOut.send(mail);
    return { note: `customer ${email}` };
  };
}

const TYPE_WORD: Record<Item["type"], string> = { message: "message", quote_request: "quote request", booking: "booking", order: "order", refund: "refund request" };

function ownerSubject(item: Item, event: string, who: string): string {
  if (event === "create") return `New ${TYPE_WORD[item.type]} from ${who}: ${item.subject ?? ""}`.trim();
  if (event === "message") return `${who} replied: ${item.subject ?? TYPE_WORD[item.type]}`;
  return `${who}: ${TYPE_WORD[item.type]} ${item.state.replaceAll("_", " ")}`;
}

function customerSubject(item: Item, event: string, business: string): string {
  const subject = item.subject ?? TYPE_WORD[item.type];
  switch (item.state) {
    case "confirmed":
      return `Confirmed: ${subject}`;
    case "proposed":
      return `${business} proposed another time for ${subject}`;
    case "quoted":
      return `Your quote from ${business}: ${subject}`;
    case "declined":
      return `${business} could not take ${subject}`;
    case "needs_info":
      return `${business} needs a detail about ${subject}`;
    case "answered":
      return `Re: ${subject}`;
    default:
      return event === "message" ? `Re: ${subject}` : `${subject}: ${item.state.replaceAll("_", " ")}`;
  }
}
