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
  send(mail: OutboundMail): Promise<{ messageId: string }>;
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
