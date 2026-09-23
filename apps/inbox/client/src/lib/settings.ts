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
  readonly autoExpireHours: string;
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
    autoExpireHours: String(doc.booking.autoExpireHours),
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
  return {
    booking: {
      cancellationWindowMin: num(f.cancellationWindowMin),
      minNoticeMin: num(f.minNoticeMin),
      holdOnPropose: f.holdOnPropose,
      autoExpireHours: num(f.autoExpireHours),
      lateCancellation: f.lateCancellation,
      autoCompleteHours: num(f.autoCompleteHours),
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
