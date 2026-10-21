import type { DatedPolicy } from "@surfingdog/spec";
import type { Money, PayloadOf } from "../domain/types";
import { feeAt, policySentence, refundOwed } from "../policy/index";
import { canonicalJson } from "../util/canonical";
import { formatMinor } from "../util/money";
import { staffWords } from "./words";

/**
 * What cancelling a booking costs now under the policy it was confirmed with (ADR-035, ADR-032 §2): the
 * step's fee, at least the deposit when the policy keeps it, never more than the price; and what is
 * owed back of what was paid. Shown to the customer before anything is cancelled, with a fingerprint
 * they send back once their person said yes (`fee_sha`). The fee is the business's to take, from the
 * deposit it holds or through its own payment platform: nothing here charges anyone.
 */

type BookingPayload = PayloadOf<"booking">;

/** The fee for cancelling now: nothing for a booking without its own policy. */
export function bookingFeeAt(p: BookingPayload, now: number): Money {
  const total = p.totalPrice ?? null;
  const policy = p.policy as DatedPolicy | undefined;
  const currency = total?.currency ?? p.deposit?.amount.currency ?? "XXX";
  if (!policy) return { value: 0, currency };
  const paid = p.paidAmount;
  // A deposit the policy keeps comes back while cancelling is free, as the customer was told, and is
  // kept once no free step is still ahead, as far as it was paid.
  const freeAhead = policy.steps.some((s) => s.fee.value === 0 && Date.parse(s.until) >= now);
  const keep =
    !freeAhead && p.deposit && !p.deposit.refundable && paid && paid.currency === p.deposit.amount.currency
      ? { value: Math.min(paid.value, p.deposit.amount.value), currency: paid.currency }
      : undefined;
  const fee = feeAt(policy, now, { total: total ?? undefined, keep });
  return { value: Math.max(0, fee.value), currency: fee.currency };
}

export interface CancelFee {
  readonly fee: Money;
  /** What is owed back of what was paid; null when nothing was paid. */
  readonly refund: Money | null;
  /** The fingerprint the customer sends back once they said yes: the item, the fee and what comes back. */
  readonly sha: string;
  /** The fee and the policy, in the business's words and the customer's language. */
  readonly sentence: string;
}

export async function cancelFeeOf(
  item: { readonly id: string; readonly payload: BookingPayload },
  now: number,
  lang: string,
): Promise<CancelFee | null> {
  const p = item.payload;
  if (!p.policy) return null;
  const fee = bookingFeeAt(p, now);
  const refund = p.paidAmount ? refundOwed(p.paidAmount, fee) : null;
  const bytes = new TextEncoder().encode(canonicalJson({ kind: "cancel", item: item.id, fee, refund }));
  const sha = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
  const w = staffWords(lang);
  const locale = lang.includes("-") ? lang : undefined;
  const money = (m: Money) => formatMinor(m, locale ?? localeOf(lang));
  const head =
    fee.value === 0
      ? w.cancelFree
      : refund && refund.value > 0
        ? w.cancelFeeBack(money(fee), money(refund))
        : w.cancelFee(money(fee));
  const total = p.totalPrice ?? fee;
  const depositKept = p.deposit !== undefined && !p.deposit.refundable;
  const sentence = `${head} ${policySentence(p.policy as DatedPolicy, { lang, total, depositKept })}`;
  return { fee, refund, sha, sentence };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The locale money and dates are written in for a language tag: its own region, else the language's usual one. */
export function localeOf(lang: string): string {
  if (lang.includes("-")) return lang;
  const primary = lang.toLowerCase().split(/[-_]/)[0] ?? "en";
  return { en: "en-GB", es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT", pt: "pt-PT" }[primary] ?? "en-GB";
}
