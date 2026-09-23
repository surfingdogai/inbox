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
  readonly holdOnPropose: boolean;
  readonly autoExpireHours: string;
  readonly approvalLimit: string;
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
  readonly testMode: boolean;
}

export function toSettingsForm(doc: Settings, redacted: readonly string[] = []): SettingsForm {
  return {
    cancellationWindowMin: String(doc.booking.cancellationWindowMin),
    holdOnPropose: doc.booking.holdOnPropose,
    autoExpireHours: String(doc.booking.autoExpireHours),
    approvalLimit: doc.orders.maxValueWithoutApprovalMinor
      ? (doc.orders.maxValueWithoutApprovalMinor / 100).toFixed(2)
      : "",
    ownerEmail: doc.notifications.ownerEmail ?? "",
    appUrl: doc.notifications.appUrl ?? "",
    fromAddress: doc.email.fromAddress ?? "",
    fromName: doc.email.fromName ?? "",
    replyTo: doc.email.replyTo ?? "",
    // A read never returns the secret; the field is for a new one.
    inboundSecret: "",
    inboundSecretSet: redacted.includes("email.inboundSecret") || !!doc.email.inboundSecret,
    removeInboundSecret: false,
    testMode: doc.testMode,
  };
}

export function toSettingsDoc(f: SettingsForm): Record<string, unknown> {
  // A number field that does not hold a number goes as typed, so the API names the field; an
  // empty one is not a reset to the default.
  const num = (s: string): number | string => {
    const t = s.trim();
    return t !== "" && Number.isFinite(Number(t)) ? Number(t) : t;
  };
  const opt = (s: string): string | null => (s.trim() ? s.trim() : null);
  const limit = f.approvalLimit.trim() ? Math.round(Number(f.approvalLimit.replace(",", ".")) * 100) : 0;
  return {
    booking: {
      cancellationWindowMin: num(f.cancellationWindowMin),
      holdOnPropose: f.holdOnPropose,
      autoExpireHours: num(f.autoExpireHours),
    },
    orders: { maxValueWithoutApprovalMinor: Number.isFinite(limit) ? limit : f.approvalLimit.trim() },
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
    testMode: f.testMode,
  };
}
