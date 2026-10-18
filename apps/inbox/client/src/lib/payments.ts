import vocabulary from "../../../../../packages/spec/vocab/payments.json" with { type: "json" };

/**
 * The ways to pay the owner ticks in Settings → Payments: the payments vocabulary's ways a person pays (its methods
 * and wallets), by their English names, in groups people recognise, the common ones out first and the business's own
 * country's local ones beside them. The ways an agent pays at a door (x402, AP2, ACP, Visa Intelligent Commerce,
 * Mastercard Agent Pay, UCP handlers) are not here: a network reads them from the door that runs them, and a tick
 * would declare a checkout no agent could pay at. A test holds every way a person pays to exactly one group.
 */
export interface PaymentGroup {
  readonly id: string;
  readonly title: string;
  readonly tokens: readonly string[];
  /** Folded under "More ways", unless the business's country makes one of them local (`paymentGroupsFor`). */
  readonly more?: boolean;
}

/** The card brands: each is a card, offered once Card is ticked ("Which cards?"). */
export const CARD_BRANDS: readonly string[] = ["visa", "mastercard", "amex"];

export const PAYMENT_GROUPS: readonly PaymentGroup[] = [
  { id: "cards", title: "Cards", tokens: ["card", ...CARD_BRANDS] },
  {
    id: "wallets",
    title: "Wallets",
    tokens: ["apple_pay", "google_pay", "paypal", "shop_pay", "stripe_link", "amazon_pay"],
  },
  { id: "everyday", title: "In person and by bank", tokens: ["cash", "bank_transfer"] },
  {
    id: "local",
    title: "Local",
    tokens: [
      "sepa",
      "pix",
      "upi",
      "mb_way",
      "multibanco",
      "ideal",
      "blik",
      "swish",
      "bancontact",
      "twint",
      "alipay",
      "wechat_pay",
      "mpesa",
      "interac",
      "venmo",
      "cash_app",
      "zelle",
      "bizum",
      "paynow",
      "promptpay",
      "gcash",
      "paypay",
      "kakaopay",
      "mercado_pago",
      "oxxo",
    ],
    more: true,
  },
  { id: "later", title: "Pay later", tokens: ["klarna", "afterpay", "affirm", "tabby", "tamara"], more: true },
  { id: "other", title: "Other", tokens: ["crypto"], more: true },
];

/** The euro area, where SEPA's transfers and debits are everyday. */
const EURO = "AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK";

/**
 * The ways people pay locally, by country (ISO 3166-1): the ones a business there is most likely to take, offered
 * open beside the everyday ones. Every region the vocabulary names a way for is here; a country it names none for
 * keeps them all under "More ways".
 */
const LOCAL_BY_COUNTRY: Readonly<Record<string, readonly string[]>> = {
  PT: ["mb_way", "multibanco"],
  BR: ["pix", "mercado_pago"],
  IN: ["upi"],
  NL: ["ideal"],
  BE: ["bancontact"],
  PL: ["blik"],
  SE: ["swish"],
  CH: ["twint"],
  LI: ["twint"],
  CN: ["alipay", "wechat_pay"],
  HK: ["alipay", "wechat_pay"],
  ES: ["bizum"],
  KE: ["mpesa"],
  TZ: ["mpesa"],
  CA: ["interac"],
  US: ["venmo", "cash_app", "zelle"],
  SG: ["paynow"],
  TH: ["promptpay"],
  PH: ["gcash"],
  JP: ["paypay"],
  KR: ["kakaopay"],
  MX: ["mercado_pago", "oxxo"],
  AR: ["mercado_pago"],
  CL: ["mercado_pago"],
  CO: ["mercado_pago"],
  PE: ["mercado_pago"],
  UY: ["mercado_pago"],
  AE: ["tabby", "tamara"],
  SA: ["tabby", "tamara"],
  KW: ["tabby", "tamara"],
  BH: ["tabby"],
  QA: ["tabby"],
};

/** The local ways for a country, its everyday SEPA among them in the euro area; none for one unknown. */
export function localPayments(country: string | null | undefined): readonly string[] {
  const c = (country ?? "").toUpperCase();
  const own = LOCAL_BY_COUNTRY[c] ?? [];
  return EURO.split(" ").includes(c) ? [...own, "sepa"] : own;
}

/**
 * The groups as the tab shows them for a business in `country`: its local ways open, in a "Local" group after "In
 * person and by bank", and taken out of the folded groups they otherwise sit in, where the other countries' local
 * ways are "Elsewhere".
 */
export function paymentGroupsFor(country: string | null | undefined): {
  readonly shown: readonly PaymentGroup[];
  readonly more: readonly PaymentGroup[];
} {
  const local = localPayments(country);
  const shown: PaymentGroup[] = PAYMENT_GROUPS.filter((g) => !g.more);
  if (local.length) shown.push({ id: "local-here", title: "Local", tokens: local });
  const more = PAYMENT_GROUPS.filter((g) => g.more)
    .map((g) => ({
      ...g,
      ...(g.id === "local" && local.length ? { title: "Elsewhere" } : {}),
      tokens: g.tokens.filter((t) => !local.includes(t)),
    }))
    .filter((g) => g.tokens.length > 0);
  return { shown, more };
}

const labels = vocabulary.labels as Readonly<Record<string, string>>;

/** Every token, in the vocabulary's order. */
export const PAYMENT_ORDER: readonly string[] = [...vocabulary.methods, ...vocabulary.wallets, ...vocabulary.agent];

/** A token's English name. */
export function paymentName(token: string): string {
  return labels[token] ?? token;
}

/** `accepted` in the vocabulary's order, each once, with Card when a card brand is in it. */
export function withCard(accepted: readonly string[]): string[] {
  const set = new Set(accepted);
  if (CARD_BRANDS.some((b) => set.has(b))) set.add("card");
  return PAYMENT_ORDER.filter((t) => set.has(t));
}

/**
 * `accepted` with `token` ticked or not, each once, in the vocabulary's order (as the manifest publishes it): a card
 * brand ticked ticks Card, and Card unticked unticks the brands. Anything the tab does not show stays as it was.
 */
export function togglePayment(accepted: readonly string[], token: string, on: boolean): string[] {
  const set = new Set(accepted);
  if (on) set.add(token);
  else set.delete(token);
  if (!on && token === "card") for (const b of CARD_BRANDS) set.delete(b);
  return withCard([...set]);
}

/** Whether two lists hold the same ways, in any order. */
export function samePayments(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}
