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
}

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
