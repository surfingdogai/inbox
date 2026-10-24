import type { DatedPolicy } from "@surfingdog/core";
import { formatClock, formatDay, formatMoney } from "../lib/format";
import { useIntegrations } from "../lib/queries";
import { datedSteps, depositPaid, useStaff, withWhom } from "../lib/staff";
import type { Item, Money } from "../lib/types";
import "./staff.css";

/**
 * A booking with someone (ADR-035), on its detail, beside its confirm: who it is with, what was added,
 * the deposit (how much, by when, what was paid of it, and that the owner asks for it themselves where
 * no payment platform takes it), the cancellation policy as the customer confirmed it, each step dated
 * in the business's zone, and what to check first when a person must. Nothing for a booking with none.
 */
export function BookingSalon({
  item,
  tz,
  checkFirst,
}: {
  item: Item;
  tz: string | undefined;
  checkFirst?: string | undefined;
}) {
  const staff = useStaff();
  const integrations = useIntegrations();
  const payments = (integrations.data?.connections ?? []).some((c) => c.pay_on === true);
  if (item.type !== "booking") return null;
  const p = item.payload as typeof item.payload & {
    resourceId?: string;
    staffName?: string;
    anyStaff?: boolean;
    addOns?: { id: string; name: string; durationMin: number; price?: Money }[];
    deposit?: { amount: Money; dueBy?: string; refundable: boolean };
    policy?: DatedPolicy;
  };
  if (!p.staffName && !p.anyStaff && !p.addOns?.length && !p.deposit && !p.policy && !checkFirst) return null;
  // A time proposed with someone else: who it goes with if the customer says yes, said as proposed.
  const who = withWhom(item.state, p);
  const person = staff.data?.items.find((s) => s.id === who.resourceId);
  const when = (iso: string) => `${formatDay(iso, tz)} ${formatClock(iso, tz)}`;
  // What was paid of the deposit, as the inbox reads it (`depositPaid`), as the cancel's note reads it.
  const paid = depositPaid(p)?.paid ?? 0;
  return (
    <section className="booking-salon" aria-label="Who, deposit and policy">
      {checkFirst && (
        <div className="bs-row">
          <span className="k">Check first</span>
          <span>{checkFirst}</span>
        </div>
      )}
      {(who.staffName || p.anyStaff) && (
        <div className="bs-row">
          <span className="k">With</span>
          <span>
            {who.proposed && "Proposed with "}
            {who.staffName ? <b>{who.staffName}</b> : "Whoever is free"}
            {person && person.name !== who.staffName && <span className="hint"> · {person.name}</span>}
            {p.anyStaff && who.staffName && <span className="hint"> · asked for anyone</span>}
          </span>
        </div>
      )}
      {p.addOns && p.addOns.length > 0 && (
        <div className="bs-row">
          <span className="k">Added</span>
          <span>
            {p.addOns
              .map((a) => `${a.name} (+${a.durationMin} min${a.price ? `, ${formatMoney(a.price)}` : ""})`)
              .join(" · ")}
          </span>
        </div>
      )}
      {p.deposit && (
        <div className="bs-row">
          <span className="k">Deposit</span>
          <span>
            {formatMoney(p.deposit.amount)}
            {paid >= p.deposit.amount.value
              ? " · paid"
              : paid > 0
                ? ` · ${formatMoney({ value: paid, currency: p.deposit.amount.currency })} paid`
                : !payments
                  ? " · no payment platform: ask for it yourself"
                  : p.deposit.dueBy
                    ? ` · due by ${when(p.deposit.dueBy)}`
                    : " · asked once you confirm"}
            {!p.deposit.refundable && (
              <span className="hint">
                {" "}
                · kept once cancelling is no longer free, unless the customer may still withdraw
              </span>
            )}
          </span>
        </div>
      )}
      {p.policy && (
        <div className="bs-row">
          <span className="k">Cancelling</span>
          <span>
            {datedSteps(p.policy, (m) => formatMoney(m), when, {
              depositKept: p.deposit !== undefined && !p.deposit.refundable,
              deposit: p.deposit?.amount,
            }).join(" · ")}
          </span>
        </div>
      )}
    </section>
  );
}
