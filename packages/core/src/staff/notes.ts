import type { Db } from "../db";
import type { Item } from "../domain/types";
import { formatMinor } from "../util/money";
import { localeOf } from "./fee";
import { leadHours } from "./requires";

/**
 * A salon's booking as the owner's email says it (ADR-035), under its line (which gives its time in the
 * business's zone): who it is with; what was added; the deposit, and that nothing will ask for it where
 * no payment platform takes it; and, when a person must check what comes first, what to check. Nothing
 * for any other booking.
 */
export async function ownerSalonLines(
  db: Db,
  item: Item,
  opts: { readonly lang: string; readonly payLinks: boolean },
): Promise<string[]> {
  if (item.type !== "booking") return [];
  const p = item.payload;
  if (!p.resourceId && !p.anyStaff && !p.addOns?.length && !p.deposit && !p.policy) {
    if (!(await checkFirstOf(db, item.id))) return [];
  }
  const locale = localeOf(opts.lang);
  const out: string[] = [];
  if (p.staffName) out.push(`With: ${p.staffName}`);
  else if (p.anyStaff) out.push("With: whoever is free");
  if (p.addOns?.length) out.push(`Added: ${p.addOns.map((a) => a.name).join(", ")}`);
  if (p.deposit) {
    const amount = formatMinor(p.deposit.amount, locale);
    out.push(
      opts.payLinks
        ? `Deposit: ${amount}${p.deposit.refundable ? "" : ", kept once cancelling is no longer free"}`
        : `Deposit: ${amount}. No payment platform is connected: ask for it yourself.`,
    );
  }
  const first = await checkFirstOf(db, item.id);
  if (first) out.push(`Check first: ${first}`);
  return out;
}

/**
 * What a person must check before this booking is confirmed, when its create said so; once it is
 * confirmed, what to check before the visit, with nothing more to confirm.
 */
export async function checkFirstOf(db: Db, itemId: string): Promise<string | null> {
  const { rows } = await db.client.query({
    sql: `SELECT s.requires, f.name, i.state FROM item_events e
            JOIN items i ON i.id = e.item_id
            JOIN services s ON s.id = json_extract(i.payload, '$.reservationFor.serviceId')
            LEFT JOIN services f ON f.id = json_extract(s.requires, '$.serviceId')
           WHERE e.item_id = ? AND e.seq = 1 AND json_extract(e.meta, '$.checkFirst') = 1 LIMIT 1`,
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  if (!r) return null;
  let requires: { withinDays?: number; atLeastHours?: number } = {};
  try {
    requires = (typeof r[0] === "string" ? JSON.parse(r[0]) : (r[0] ?? {})) as typeof requires;
  } catch {
    requires = {};
  }
  const days = requires.withinDays ?? 0;
  const hours = leadHours({ serviceId: "", withinDays: days, atLeastHours: requires.atLeastHours });
  const span = hours > 0 ? `between ${days} days and ${hours} hours before` : `within ${days} days before`;
  const what = String(r[1] ?? "what comes first");
  const open = r[2] === "requested" || r[2] === "needs_info" || r[2] === "proposed";
  return open
    ? `${what}, ${span}. Check this client has had it, then confirm.`
    : `${what}, ${span}: check this client has had it.`;
}
