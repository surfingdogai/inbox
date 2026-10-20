import type { MailOut } from "@surfingdog/platform";
import { businessFacts } from "../customer/audience";
import { oneLine } from "../customer/format";
import { autoHeaders, mailByJob, mailDomain, senderOf, sendLogged, storeMail } from "../jobs/mail-log";
import { ownerAddressOf } from "../jobs/notify";
import type { JobHandler } from "../jobs/runner";
import { readSettings } from "../settings/schema";
import { CONNECTOR_SYNC_INTERVAL_MS, type ConnectorCapabilities } from "./capability";
import type { PayNotice } from "./payments";

/**
 * The jobs a connection runs. A sync (every five minutes, and when the owner asks) writes bookings
 * out and reads busy times; a push (after every booking event) only writes bookings out. A sync
 * queues its successor before it calls the platform, so a platform that is down today is read again
 * later rather than never: later the more it fails, and not at all after a day of refused sign-ins,
 * until the owner connects again or syncs now. A connection that is gone or paused ends its chain;
 * connecting or unpausing starts it again.
 */
export function connectorSyncHandler(connectors: ConnectorCapabilities): JobHandler {
  return async (job, { now }) => {
    const id = (job.payload as { connectorId?: unknown } | null)?.connectorId;
    if (typeof id !== "string") return { note: "no connection id" };
    if (!(await connectors.active(id))) return { note: `connection ${id} is gone or paused` };
    const delay = await connectors.nextSyncDelay(id, now);
    if (delay !== null) await connectors.scheduleNext(id, now, delay);
    const report = await connectors.run(id, now, "sync");
    // The chain had stopped (a day of refused sign-ins) and this sync, which the owner asked for,
    // worked: it starts again.
    if (delay === null && report?.ok) await connectors.scheduleNext(id, now, CONNECTOR_SYNC_INTERVAL_MS);
    const stopped = delay === null && !report?.ok ? "; not tried again until it is connected again or synced now" : "";
    return { note: report ? `connection ${id}: ${report.note}${stopped}` : `connection ${id} is gone` };
  };
}

/**
 * A shop's catalogue read on its own (ADR-026 §3): after a webhook said products changed, and to go on
 * with a pass that has more pages. In its connection's lane, so it never meets a sync reading the same.
 */
export function connectorCatalogueHandler(connectors: ConnectorCapabilities): JobHandler {
  return async (job, { now }) => {
    const id = (job.payload as { connectorId?: unknown } | null)?.connectorId;
    if (typeof id !== "string") return { note: "no connection id" };
    return { note: `connection ${id}: ${await connectors.catalogueNow(id, now)}` };
  };
}

export function connectorPushHandler(connectors: ConnectorCapabilities): JobHandler {
  return async (job, { now }) => {
    const id = (job.payload as { connectorId?: unknown } | null)?.connectorId;
    if (typeof id !== "string") return { note: "no connection id" };
    const report = await connectors.run(id, now, "push");
    return { note: report ? `connection ${id}: ${report.note}` : `connection ${id} is gone` };
  };
}

/**
 * The one email that says a connection stopped syncing, to the owner, in the inbox's own words: what
 * went wrong in the platform's terms, and where to connect it again. It goes through the mail log
 * like every other email, so a retry sends it once, and not at all if the connection works again (or
 * is gone) by then.
 */
export function connectorNoticeHandler(
  connectors: ConnectorCapabilities,
  mailOut: MailOut,
  opts: { readonly baseUrl?: string | undefined } = {},
): JobHandler {
  return async (job, { db, now }) => {
    const payload = job.payload as { connectorId?: unknown; reason?: unknown } | null;
    const id = payload?.connectorId;
    if (typeof id !== "string") return { note: "no connection id" };
    const settings = await readSettings(db);
    const publicUrl = opts.baseUrl ?? settings.notifications.appUrl ?? "";
    const facts = await businessFacts(db, settings);
    const sender = senderOf(settings, { transport: mailOut, publicUrl, business: facts.name });
    let logged = await mailByJob(db, job.id);
    // A shop with more products than one connection takes (ADR-026 §3): said once.
    if (!logged && payload?.reason === "catalogue_cap") {
      const shop = await connectors.cappedNotice(id);
      if (!shop) return { note: `connection ${id}: nothing to tell` };
      const appUrl = (settings.notifications.appUrl ?? publicUrl).replace(/\/+$/, "");
      logged = await storeMail(
        db,
        {
          itemId: null,
          jobKey: job.id,
          recipient: "owner",
          template: "owner.catalogue_capped",
          lang: "en",
          subject: oneLine(`${shop.title}: the first ${shop.max.toLocaleString("en")} products are in your inbox`),
          text: [
            `${shop.title} has more products than one connection brings in, so your inbox has the first ${shop.max.toLocaleString("en")}. Agents are offered only those.`,
            "",
            "Products past them are not taken off sale, and nothing in your shop changes.",
            ...(appUrl ? ["", `Settings → Integrations: ${appUrl}/settings/integrations`] : []),
          ].join("\n"),
          ...(sender ? {} : { skip: "no_sender" as const }),
        },
        mailDomain(sender?.from.address, publicUrl),
        now,
      );
    }
    if (!logged) {
      const notice = await connectors.failingNotice(id);
      if (!notice) return { note: `connection ${id} works again, or is gone: nothing to tell` };
      const appUrl = (settings.notifications.appUrl ?? publicUrl).replace(/\/+$/, "");
      const again = `Connect it again in Settings → Integrations${appUrl ? `: ${appUrl}/settings/integrations` : "."}`;
      // A payment platform is not a calendar: what stops is the links to pay, not the busy times.
      const payments = notice.group === "payments";
      const text = payments
        ? [
            `${notice.title} stopped working with your inbox${notice.error ? `: ${notice.error}` : "."}`,
            "",
            again,
            "",
            `Until then, orders you accept get no link to pay. Payments on links already sent still go into your ${notice.title} account; check them there.`,
          ].join("\n")
        : [
            `Your ${notice.title} stopped syncing${notice.error ? `: ${notice.error}` : "."}`,
            "",
            again,
            "",
            "Until then, what you add in that calendar does not take times off what your inbox offers.",
          ].join("\n");
      logged = await storeMail(
        db,
        {
          itemId: null,
          jobKey: job.id,
          recipient: "owner",
          template: payments ? "owner.payments_failing" : "owner.connector_failing",
          lang: "en",
          subject: oneLine(
            payments ? `${notice.title} stopped working with your inbox` : `Your ${notice.title} stopped syncing`,
          ),
          text,
          ...(sender ? {} : { skip: "no_sender" as const }),
        },
        mailDomain(sender?.from.address, publicUrl),
        now,
      );
    }
    if (logged.status === "skipped") return { note: `not sent: ${logged.skipReason ?? "skipped"}` };
    if (logged.status === "sent" || logged.status === "failed") return { note: `already ${logged.status}` };
    const address = await ownerAddressOf(db, settings);
    if (!address || !sender) {
      await db.client.query({
        sql: "UPDATE outbound_mail SET status = 'skipped', skip_reason = ?, updated_at = ? WHERE id = ?",
        params: [address ? "no_sender" : "no_address", now, logged.id],
        method: "run",
      });
      return { note: `not sent: ${address ? "no sender" : "no address"}` };
    }
    const sent = await sendLogged(
      db,
      mailOut,
      logged,
      {
        ...sender,
        to: [address],
        subject: logged.subject,
        text: logged.bodyText,
        headers: autoHeaders({ automatic: true, template: logged.template }),
      },
      { final: job.attempts >= job.maxAttempts, now },
    );
    return { note: sent === null ? "not sent: held back" : "told the owner the connection stopped syncing" };
  };
}

/**
 * An order's pay link brought in step with the order (ADR-023): made when it is accepted, made again
 * when its total changes or a payment failed, closed when it ends. Every order event queues one, when
 * a payment platform is connected or the order holds a live link.
 */
export function payLinkHandler(connectors: ConnectorCapabilities): JobHandler {
  return async (job, { now }) => {
    const itemId = (job.payload as { itemId?: unknown } | null)?.itemId;
    if (typeof itemId !== "string") return { note: "no item id" };
    return { note: `order ${itemId}: ${await connectors.payments.ensure(itemId, now)}` };
  };
}

/**
 * One email to the owner about one payment that needs them: paid after the order ended, paid twice,
 * paid another amount, or a link that could not be made. In the inbox's own words, once per reason,
 * through the mail log like every other email.
 */
export function payNoticeHandler(
  connectors: ConnectorCapabilities,
  mailOut: MailOut,
  opts: { readonly baseUrl?: string | undefined } = {},
): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as PayNotice | null;
    if (typeof p?.reason !== "string" || (p.reason !== "disconnected" && typeof p.payId !== "string")) {
      return { note: "no payment named" };
    }
    const reason = p.reason;
    const settings = await readSettings(db);
    const publicUrl = opts.baseUrl ?? settings.notifications.appUrl ?? "";
    const facts = await businessFacts(db, settings);
    const sender = senderOf(settings, { transport: mailOut, publicUrl, business: facts.name });
    let logged = await mailByJob(db, job.id);
    if (!logged) {
      const appUrl = (settings.notifications.appUrl ?? publicUrl).replace(/\/+$/, "");
      const notice = await connectors.payments.noticeText(p, appUrl);
      if (!notice) return { note: `payment ${p.payId ?? ""}: nothing to tell any more` };
      logged = await storeMail(
        db,
        {
          itemId: notice.itemId,
          jobKey: job.id,
          recipient: "owner",
          template: `owner.payment_${reason}`,
          lang: "en",
          subject: oneLine(notice.subject),
          text: notice.text,
          ...(sender ? {} : { skip: "no_sender" as const }),
        },
        mailDomain(sender?.from.address, publicUrl),
        now,
      );
    }
    if (logged.status === "skipped") return { note: `not sent: ${logged.skipReason ?? "skipped"}` };
    if (logged.status === "sent" || logged.status === "failed") return { note: `already ${logged.status}` };
    const address = await ownerAddressOf(db, settings);
    if (!address || !sender) {
      await db.client.query({
        sql: "UPDATE outbound_mail SET status = 'skipped', skip_reason = ?, updated_at = ? WHERE id = ?",
        params: [address ? "no_sender" : "no_address", now, logged.id],
        method: "run",
      });
      return { note: `not sent: ${address ? "no sender" : "no address"}` };
    }
    const sent = await sendLogged(
      db,
      mailOut,
      logged,
      {
        ...sender,
        to: [address],
        subject: logged.subject,
        text: logged.bodyText,
        headers: autoHeaders({ automatic: true, template: logged.template }),
      },
      { final: job.attempts >= job.maxAttempts, now },
    );
    return { note: sent === null ? "not sent: held back" : `told the owner: ${reason.replaceAll("_", " ")}` };
  };
}

/**
 * A payment platform being disconnected (ADR-023): the next few of its links switched off on the
 * platform, and the connection gone once none is left (or after a few tries).
 */
export function payCloseHandler(connectors: ConnectorCapabilities): JobHandler {
  return async (job, { now }) => {
    const id = (job.payload as { connectorId?: unknown } | null)?.connectorId;
    if (typeof id !== "string") return { note: "no connection id" };
    return { note: `connection ${id}: ${await connectors.continueDisconnect(id, now)}` };
  };
}
