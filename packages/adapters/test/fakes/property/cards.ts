import type { FakeRequest } from "../platform";

/**
 * No card ever leaves the inbox for a property system (ADR-033 §11): what each fake received is read,
 * JSON or form, for a field that would carry card data (a card number, its token, a payment account,
 * an authorization, a credit card id) and for any run of 13 to 19 digits that passes the Luhn check.
 * Answers the offending requests; empty is the only good answer.
 */

const CARD_KEYS = /card|cvc|cvv|^pan$|expiry|payment.?account|authori[sz]ation|iban|^bic$|commission|application_fee/i;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function keysOf(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) keysOf(v, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysOf(v, out);
    }
  }
}

/** The requests whose body names a card field or holds a card-like number. */
export function cardRequests(seen: readonly FakeRequest[]): FakeRequest[] {
  return seen.filter((r) => {
    if (!r.body) return false;
    const keys: string[] = [];
    try {
      keysOf(JSON.parse(r.body), keys);
    } catch {
      for (const [k] of new URLSearchParams(r.body)) keys.push(...k.split(/[[\]]+/).filter(Boolean));
    }
    if (keys.some((k) => CARD_KEYS.test(k))) return true;
    return (r.body.match(/\d{13,19}/g) ?? []).some(luhn);
  });
}
