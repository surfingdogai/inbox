import type { DatedPolicy } from "@surfingdog/core";
import { formatClock, formatDay, formatMoney } from "../lib/format";
import { datedSteps, useStaff } from "../lib/staff";
import type { Item, Money } from "../lib/types";
import "./staff.css";

/**
 * A booking with someone (ADR-035), on its detail: who it is with, what was added, the deposit (how
 * much, by when, and what was paid of it) and the cancellation policy as the customer confirmed it,
 * each step dated in the business's zone. Nothing for a booking with none of them.
 */
export function BookingSalon({ item, tz }: { item: Item; tz: string | undefined }) {
  const staff = useStaff();
  if (item.type !== "booking") return null;
  const p = item.payload as typeof item.payload & {
    resourceId?: string;
    staffName?: string;
    addOns?: { id: string; name: string; durationMin: number; price?: Money }[];
    deposit?: { amount: Money; dueBy?: string; refundable: boolean };
    policy?: DatedPolicy;
  };
  if (!p.staffName && !p.addOns?.length && !p.deposit && !p.policy) return null;
  const person = staff.data?.items.find((s) => s.id === p.resourceId);
  const when = (iso: string) => `${formatDay(iso, tz)} ${formatClock(iso, tz)}`;
  const paid =
    p.paidAmount && p.deposit && p.paidAmount.currency === p.deposit.amount.currency ? p.paidAmount.value : 0;
  return (
    <section className="booking-salon" aria-label="Who, deposit and policy">
      {p.staffName && (
        <div className="row">
          <span className="k">With</span>
          <span>
            <b>{p.staffName}</b>
            {person && person.name !== p.staffName && <span className="hint"> · {person.name}</span>}
          </span>
        </div>
      )}
      {p.addOns && p.addOns.length > 0 && (
        <div className="row">
          <span className="k">Added</span>
          <span>
            {p.addOns
              .map((a) => `${a.name} (+${a.durationMin} min${a.price ? `, ${formatMoney(a.price)}` : ""})`)
              .join(" · ")}
          </span>
        </div>
      )}
      {p.deposit && (
        <div className="row">
          <span className="k">Deposit</span>
          <span>
            {formatMoney(p.deposit.amount)}
            {paid >= p.deposit.amount.value
              ? " · paid"
              : paid > 0
                ? ` · ${formatMoney({ value: paid, currency: p.deposit.amount.currency })} paid`
                : p.deposit.dueBy
                  ? ` · due by ${when(p.deposit.dueBy)}`
                  : ""}
            {!p.deposit.refundable && <span className="hint"> · kept if cancelled</span>}
          </span>
        </div>
      )}
      {p.policy && (
        <div className="row">
          <span className="k">Cancelling</span>
          <span>{datedSteps(p.policy, (m) => formatMoney(m), when).join(" · ")}</span>
        </div>
      )}
    </section>
  );
}
