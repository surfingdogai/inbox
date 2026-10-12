/**
 * @surfingdog/platform — the five seams between the core and a runtime.
 * Cloudflare: D1 or Durable Object SQLite · R2 · Queues + Cron · Email Workers · Email Service.
 * Node/Bun:   node:sqlite / bun:sqlite · S3-compatible or a directory · SQLite job table · provider webhook · Resend/Postmark/SMTP.
 * The seams between the core and each runtime.
 */

import type { SqliteClient } from "./db";

export * from "./db";
export * from "./mail";
export * from "./migrate";

export interface Blob {
  put(key: string, body: ReadableStream | ArrayBuffer | string, meta?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream; contentType?: string } | null>;
  delete(key: string): Promise<void>;
}

export interface JobSpec {
  kind: string;
  payload: unknown;
  idempotencyKey?: string;
}

export interface Jobs {
  enqueue(job: JobSpec, opts?: { delaySeconds?: number }): Promise<void>;
}

export interface OutboundMail {
  from: { address: string; name?: string };
  to: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
}

export interface MailOut {
  /**
   * Sends one message. `messageId` is the id the service gave it, or empty when it gave none; the
   * service may use it as the local part of the Message-ID it writes, so a reply that names it can
   * be matched.
   */
  send(mail: OutboundMail): Promise<{ messageId: string }>;
  /**
   * The transport's own address (MAIL_FROM), when it has one: a message with no sender of its own,
   * such as the owner's sign-in link, goes out from it. The REST sender sends every message from it.
   */
  readonly sender?: { readonly address: string; readonly name?: string | undefined } | undefined;
  /**
   * False for a transport that delivers nothing — the log or the console an instance falls back to
   * when no mail service is set up. What it takes is shown there, and never recorded as sent.
   */
  readonly delivers?: boolean | undefined;
  /**
   * True when every message goes out from `sender`, whatever the message names (`pinnedMailOut`):
   * Send from, Sender name and Customers reply to in Settings then change nothing that is sent.
   */
  readonly pinned?: boolean | undefined;
  /**
   * Whether this kind of email to a customer may go at all. Asked before each one is written and
   * again before it is sent; one that may not is kept on its item as not sent (`host_policy`).
   * Absent, every kind goes.
   */
  readonly allowCustomerMail?: ((kind: CustomerMailKind) => boolean | Promise<boolean>) | undefined;
  /**
   * Asked just before each logged email is handed to `send`, with who it is for: null lets it go;
   * a reason holds it back, and the email is kept as not sent for that reason, never retried as an
   * error. Where a host keeps what one inbox cannot see alone: caps shared by several inboxes, a cap
   * per recipient, a suppression list. A hook that throws is an email not sent yet: it is tried again.
   */
  readonly beforeSend?:
    | ((mail: OutboundMail, about: MailAbout) => MailHold | null | Promise<MailHold | null>)
    | undefined;
}

/**
 * What an email to a customer is, for a transport that decides which kinds go:
 *
 * - `acknowledgement`: the "we have your request" a request gets unasked, at the address it gave;
 * - `code`: a one-time code, or a first-time customer's code for their assistant;
 * - `payment_request`: an order's request for payment, or the email saying a payment failed, each
 *   with the link to pay;
 * - `person`: anything else a person at the business caused, in the app or with their own key;
 * - `automatic`: anything else — a rule, the owner's AI, another system, the customer's own answer,
 *   the inbox itself.
 */
export type CustomerMailKind = "acknowledgement" | "code" | "payment_request" | "person" | "automatic";

/** Who an email is for, as `beforeSend` is told. */
export interface MailAbout {
  readonly recipient: "customer" | "owner";
  /** For an email to a customer, its kind. */
  readonly kind?: CustomerMailKind | undefined;
  /** Which email it is, as the mail log names it: `ack.booking`, `owner.create`, `owner.digest`, … */
  readonly template: string;
}

/**
 * Why `beforeSend` holds an email back: the address is on a suppression list (`suppressed`), it had
 * all the email it may have today (`recipient_limit`), the inbox sent all it may send today
 * (`daily_limit`), or sending from the inbox is paused (`paused`).
 */
export type MailHold = "suppressed" | "recipient_limit" | "daily_limit" | "paused";

/** Raw inbound MIME, however it arrived (Email Worker, provider webhook, forward). */
export interface RawMail {
  envelopeFrom: string;
  envelopeTo: string;
  raw: ReadableStream | ArrayBuffer;
  receivedAt: Date;
}

export interface MailIn {
  onMessage(handler: (mail: RawMail) => Promise<void>): void;
}

export interface Platform {
  db: SqliteClient;
  blob: Blob;
  jobs: Jobs;
  mailOut: MailOut;
  now(): Date;
}
