import { parseMajor } from "./actions";
import type { Settings } from "./types";

/**
 * The General settings form and the change it sends. Pure functions, no DOM, so they run in tests
 * on both runtimes.
 *
 * A save sends only the keys this form shows, never the whole document it was loaded from: a
 * settings write is a merge (ADR-017 §8.1), so everything else — networks, integrations, keys a
 * newer version added — keeps its value, and no default is written back as if the owner had
 * chosen it. A field the owner emptied is sent as `null`, which removes it; leaving it out would
 * keep the old value and still say "saved".
 *
 * The inbound email secret is the exception: a read never returns it (it is `redacted`), so the
 * field starts empty and means "a new one". Empty keeps the stored secret; only the owner asking
 * for it to be removed sends `null`.
 */
export interface SettingsForm {
  readonly cancellationWindowMin: string;
  /** Minutes before a start time after which customers can no longer book it online. */
  readonly minNoticeMin: string;
  readonly holdOnPropose: boolean;
  /** Times held at once for one customer, at most. */
  readonly maxHolds: string;
  readonly autoExpireHours: string;
  /** Offers (ADR-018 §10): how long a quote or changes without a date hold, and what automation offers at most. */
  readonly offerValidHours: string;
  /** How long an order or quote request nobody answered stays open. */
  readonly counterValidHours: string;
  /** Rounds of back-and-forth before a person answers. */
  readonly maxRounds: string;
  /** What the business proposes binds it until it lapses; off, it may withdraw it first. */
  readonly binding: boolean;
  /** Changes a booking or an order may have once agreed (ADR-018 §10). */
  readonly maxChanges: string;
  /** Minutes before a booking after which only a person accepts a customer's change; empty is the cancellation window. */
  readonly changeCutoffMin: string;
  /** The owner's AI and rules may accept a customer's change, and may ask for one. */
  readonly aiAcceptsChanges: boolean;
  readonly aiProposesChanges: boolean;
  /** The owner's AI and rules may approve a return inside the return policy, the goods coming back. */
  readonly aiApprovesReturns: boolean;
  /** Customers may suggest a price of their own (ADR-018 Q1: off out of the box). */
  readonly priceCounters: boolean;
  /** What the owner's AI and rules may agree to on their own (ADR-018 §4, Q2: time yes, money no). */
  readonly aiDiscountPct: string;
  readonly aiPricesCustom: boolean;
  /** Hours from the time asked for that automation may propose instead (the setting holds minutes). */
  readonly aiTimeShiftHours: string;
  readonly aiDelayDays: string;
  /** Up to this amount (major units), a refund with nothing sent back; empty is never. */
  readonly aiRefundMax: string;
  /** Returns (ADR-018 §7): the days a customer has, who pays to send back, how soon we refund and answer. */
  readonly returnDays: string;
  readonly returnPostage: "customer" | "business";
  readonly refundDays: string;
  readonly respondHours: string;
  /** Who the business sells to, and who it is, as every confirmation says (ADR-018 §5). */
  readonly sellsTo: "consumers" | "businesses" | "both";
  readonly legalName: string;
  readonly legalAddress: string;
  readonly legalCountry: string;
  readonly legalEmail: string;
  readonly legalPhone: string;
  readonly vatId: string;
  readonly complaintsUrl: string;
  /** After the window: record the cancellation as late, or refuse it (ADR-017 §3.1). */
  readonly lateCancellation: "record" | "refuse";
  readonly autoCompleteHours: string;
  readonly approvalLimit: string;
  readonly payDays: string;
  readonly dueDays: string;
  readonly ownerEmail: string;
  readonly appUrl: string;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly replyTo: string;
  /** A new inbound secret; empty keeps the one stored. */
  readonly inboundSecret: string;
  /** Whether a secret is stored now (the read says so in `redacted`; it never returns the value). */
  readonly inboundSecretSet: boolean;
  /** The owner asked for the stored secret to be removed. */
  readonly removeInboundSecret: boolean;
  /** One-time codes for customers the business already knows (ADR-017 §8.2). */
  readonly codeMinutes: string;
  readonly codeAttempts: string;
  readonly codesPerHour: string;
  readonly codesPerDay: string;
  readonly triesPerDay: string;
  /** The one line at the end of a new customer's first email: a code their assistant can show next time. */
  readonly emailKey: boolean;
  /** Other hosts this inbox answers on, which an agent's signature may name (§2.4): comma-separated. */
  readonly extraHosts: string;
  readonly testMode: boolean;
}

export function toSettingsForm(doc: Settings, redacted: readonly string[] = []): SettingsForm {
  return {
    cancellationWindowMin: String(doc.booking.cancellationWindowMin),
    minNoticeMin: String(doc.booking.minNoticeMin),
    holdOnPropose: doc.booking.holdOnPropose,
    maxHolds: String(doc.booking.maxHolds),
    autoExpireHours: String(doc.booking.autoExpireHours),
    offerValidHours: String(doc.negotiation.offerValidHours),
    counterValidHours: String(doc.negotiation.counterValidHours),
    maxRounds: String(doc.negotiation.maxRounds),
    binding: doc.negotiation.binding,
    maxChanges: String(doc.negotiation.changes.maxPerItem),
    changeCutoffMin:
      doc.negotiation.changes.customerCutoffMin === null ? "" : String(doc.negotiation.changes.customerCutoffMin),
    aiAcceptsChanges: doc.negotiation.ai.mayAcceptChanges,
    aiProposesChanges: doc.negotiation.ai.mayProposeChanges,
    aiApprovesReturns: doc.negotiation.ai.mayAuthorizeReturnsInPolicy,
    priceCounters: doc.negotiation.priceCounters,
    aiDiscountPct: String(doc.negotiation.ai.maxDiscountPct),
    aiPricesCustom: doc.negotiation.ai.mayPriceCustom,
    aiTimeShiftHours: String(Math.round((doc.negotiation.ai.maxTimeShiftMin / 60) * 100) / 100),
    aiDelayDays: String(doc.negotiation.ai.maxDelayDays),
    aiRefundMax: doc.negotiation.ai.maxRefundMinor ? (doc.negotiation.ai.maxRefundMinor / 100).toFixed(2) : "",
    returnDays: String(doc.returns.days),
    returnPostage: doc.returns.postage,
    refundDays: String(doc.returns.refundDays),
    respondHours: String(doc.returns.respondHours),
    sellsTo: doc.commerce.customers,
    legalName: doc.commerce.legal.legalName,
    legalAddress: doc.commerce.legal.address,
    legalCountry: doc.commerce.legal.country,
    legalEmail: doc.commerce.legal.email,
    legalPhone: doc.commerce.legal.phone,
    vatId: doc.commerce.legal.vatId,
    complaintsUrl: doc.commerce.legal.complaintsUrl,
    lateCancellation: doc.booking.lateCancellation,
    autoCompleteHours: String(doc.booking.autoCompleteHours),
    approvalLimit: doc.orders.maxValueWithoutApprovalMinor
      ? (doc.orders.maxValueWithoutApprovalMinor / 100).toFixed(2)
      : "",
    payDays: String(doc.orders.payDays),
    dueDays: String(doc.orders.dueDays),
    ownerEmail: doc.notifications.ownerEmail ?? "",
    appUrl: doc.notifications.appUrl ?? "",
    fromAddress: doc.email.fromAddress ?? "",
    fromName: doc.email.fromName ?? "",
    replyTo: doc.email.replyTo ?? "",
    // A read never returns the secret; the field is for a new one.
    inboundSecret: "",
    inboundSecretSet: redacted.includes("email.inboundSecret") || !!doc.email.inboundSecret,
    removeInboundSecret: false,
    codeMinutes: String(doc.customers.otp.ttlMinutes),
    codeAttempts: String(doc.customers.otp.attempts),
    codesPerHour: String(doc.customers.otp.sendsPerHour),
    codesPerDay: String(doc.customers.otp.sendsPerDay),
    triesPerDay: String(doc.customers.otp.guessesPerDay),
    emailKey: doc.customers.emailKey,
    extraHosts: doc.identity.extraAuthorities.join(", "),
    testMode: doc.testMode,
  };
}

/**
 * The hosts typed into "Other addresses of this inbox", as the setting holds them: lowercase, one
 * per comma or space, an `https://` or a trailing slash forgiven; anything else is sent as typed so
 * the API names it.
 */
export function hostsOf(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((h) =>
      h
        .trim()
        .toLowerCase()
        .replace(/^https:\/\//, "")
        .replace(/\/+$/, ""),
    )
    .filter((h) => h !== "");
}

export function toSettingsDoc(f: SettingsForm): Record<string, unknown> {
  // A number field that does not hold a number goes as typed, so the API names the field; an
  // empty one is not a reset to the default.
  const num = (s: string): number | string => {
    const t = s.trim();
    return t !== "" && Number.isFinite(Number(t)) ? Number(t) : t;
  };
  const opt = (s: string): string | null => (s.trim() ? s.trim() : null);
  const limit = f.approvalLimit.trim() ? parseMajor(f.approvalLimit) : 0;
  const refundMax = f.aiRefundMax.trim() ? parseMajor(f.aiRefundMax) : 0;
  const shift = num(f.aiTimeShiftHours);
  return {
    booking: {
      cancellationWindowMin: num(f.cancellationWindowMin),
      minNoticeMin: num(f.minNoticeMin),
      holdOnPropose: f.holdOnPropose,
      maxHolds: num(f.maxHolds),
      autoExpireHours: num(f.autoExpireHours),
      lateCancellation: f.lateCancellation,
      autoCompleteHours: num(f.autoCompleteHours),
    },
    negotiation: {
      offerValidHours: num(f.offerValidHours),
      counterValidHours: num(f.counterValidHours),
      maxRounds: num(f.maxRounds),
      binding: f.binding,
      priceCounters: f.priceCounters,
      changes: {
        maxPerItem: num(f.maxChanges),
        // Empty is the cancellation window: sent as null, which the setting takes to mean that.
        customerCutoffMin: f.changeCutoffMin.trim() ? num(f.changeCutoffMin) : null,
      },
      ai: {
        maxDiscountPct: num(f.aiDiscountPct),
        mayPriceCustom: f.aiPricesCustom,
        // Hours as typed, minutes as the setting holds them; anything else goes as typed, for the API to name.
        maxTimeShiftMin: typeof shift === "number" ? Math.round(shift * 60) : shift,
        maxDelayDays: num(f.aiDelayDays),
        maxRefundMinor: refundMax ?? f.aiRefundMax.trim(),
        mayAcceptChanges: f.aiAcceptsChanges,
        mayProposeChanges: f.aiProposesChanges,
        mayAuthorizeReturnsInPolicy: f.aiApprovesReturns,
      },
    },
    returns: {
      days: num(f.returnDays),
      postage: f.returnPostage,
      refundDays: num(f.refundDays),
      respondHours: num(f.respondHours),
    },
    // Empty is empty: who the business is, as far as the owner has said.
    commerce: {
      customers: f.sellsTo,
      legal: {
        legalName: f.legalName.trim(),
        address: f.legalAddress.trim(),
        country: f.legalCountry.trim().toUpperCase(),
        email: f.legalEmail.trim(),
        phone: f.legalPhone.trim(),
        vatId: f.vatId.trim(),
        complaintsUrl: f.complaintsUrl.trim(),
      },
    },
    orders: {
      maxValueWithoutApprovalMinor: limit ?? f.approvalLimit.trim(),
      payDays: num(f.payDays),
      dueDays: num(f.dueDays),
    },
    notifications: { ownerEmail: opt(f.ownerEmail), appUrl: opt(f.appUrl) },
    email: {
      fromAddress: opt(f.fromAddress),
      fromName: opt(f.fromName),
      replyTo: opt(f.replyTo),
      // Left out keeps the stored secret: a merge never touches a key it is not sent.
      ...(f.inboundSecret.trim()
        ? { inboundSecret: f.inboundSecret.trim() }
        : f.removeInboundSecret
          ? { inboundSecret: null }
          : {}),
    },
    customers: {
      otp: {
        ttlMinutes: num(f.codeMinutes),
        attempts: num(f.codeAttempts),
        sendsPerHour: num(f.codesPerHour),
        sendsPerDay: num(f.codesPerDay),
        guessesPerDay: num(f.triesPerDay),
      },
      emailKey: f.emailKey,
    },
    // An array is replaced whole by a merge: the list typed is the list kept.
    identity: { extraAuthorities: hostsOf(f.extraHosts) },
    testMode: f.testMode,
  };
}
