import type { MailOut, OutboundMail } from "./index";

/**
 * Amazon SES (API v2) as a mail transport, for sending from a business's own domain (ADR-026 §3).
 * Cloudflare Email Sending signs only for domains onboarded on the sending account, which a
 * business's own domain never is; SES signs for any domain whose owner adds its three DKIM CNAMEs,
 * and runs in EU regions. Requests are signed with AWS Signature Version 4 here, on Web Crypto, so it
 * runs on Node and on Workers with no SDK. The message is built here (raw MIME), so the headers that
 * keep a conversation together (In-Reply-To, References) and the inbox's own go out as written.
 */

const enc = new TextEncoder();

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return hex(new Uint8Array(digest));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** `20150830T123600Z` for an instant. */
export function amzDate(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * The headers that sign a request (AWS SigV4): `x-amz-date` and `authorization`, over the method, the
 * path and query, `host`, `x-amz-date` and every header given, and the body's hash.
 */
export async function signV4(o: {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly now: number;
}): Promise<Record<string, string>> {
  const url = new URL(o.url);
  const date = amzDate(o.now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = { host: url.host, "x-amz-date": date };
  for (const [k, v] of Object.entries(o.headers ?? {})) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  const names = Object.keys(headers).sort();
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    o.method.toUpperCase(),
    url.pathname
      .split("/")
      .map((s) => encodeURIComponent(decodeURIComponent(s)))
      .join("/") || "/",
    query,
    ...names.map((n) => `${n}:${headers[n]}`),
    "",
    names.join(";"),
    await sha256Hex(o.body ?? ""),
  ].join("\n");
  const scope = `${day}/${o.region}/${o.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, await sha256Hex(canonical)].join("\n");
  let key = await hmac(enc.encode(`AWS4${o.credentials.secretAccessKey}`), day);
  key = await hmac(key, o.region);
  key = await hmac(key, o.service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, toSign));
  return {
    "x-amz-date": date,
    authorization: `AWS4-HMAC-SHA256 Credential=${o.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

// ---- the message ---------------------------------------------------------------------------------

/** One line, control characters out. */
function oneLine(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A header value as RFC 2047 writes words that are not ASCII: `=?UTF-8?B?…?=`, in pieces under the line limit. */
export function encodeWord(text: string): string {
  const clean = oneLine(text);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const parts: string[] = [];
  let chunk = "";
  for (const ch of clean) {
    if (enc.encode(chunk + ch).byteLength > 45) {
      parts.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) parts.push(chunk);
  return parts.map((p) => `=?UTF-8?B?${base64(enc.encode(p))}?=`).join(" ");
}

/** `Name <address>`, the name quoted or encoded as it needs to be. */
function mailbox(address: string, name?: string | undefined): string {
  const n = name ? oneLine(name).replace(/[<>]/g, "") : "";
  if (!n) return `<${address}>`;
  const word = /^[\x20-\x7e]*$/.test(n) ? `"${n.replace(/["\\]/g, "\\$&")}"` : encodeWord(n);
  return `${word} <${address}>`;
}

/** Headers a message may not set itself: who it is from and to, and what the MIME says. */
const OWN_HEADERS =
  /^(from|sender|reply-to|return-path|to|cc|bcc|subject|date|mime-version|content-type|content-transfer-encoding|message-id|resent-[a-z-]+)$/i;

/** The raw message, text only, UTF-8 in base64 lines of 76. */
export function buildMime(mail: OutboundMail, o: { readonly now: number }): string {
  const lines = [
    `From: ${mailbox(mail.from.address, mail.from.name)}`,
    `To: ${mail.to.map((t) => `<${oneLine(t)}>`).join(", ")}`,
    ...(mail.replyTo ? [`Reply-To: <${oneLine(mail.replyTo)}>`] : []),
    `Subject: ${encodeWord(mail.subject)}`,
    `Date: ${new Date(o.now).toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
    ...Object.entries(mail.headers ?? {})
      .filter(([k]) => /^[!-9;-~]+$/.test(k) && !OWN_HEADERS.test(k))
      .map(([k, v]) => `${k}: ${oneLine(v)}`),
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    ...(base64(enc.encode(mail.text)).match(/.{1,76}/g) ?? []),
    "",
  ];
  return lines.join("\r\n");
}

/**
 * Sends through SES v2 (`SendEmail` with raw content). Every message goes out from `from` (the
 * business's own address, whose domain SES verified), whatever the message names: one transport per
 * sender, as the other REST transports.
 */
export function sesMailOut(
  o: {
    readonly region: string;
    readonly credentials: AwsCredentials;
    readonly from: { readonly address: string; readonly name?: string | undefined };
    /** A configuration set for the account's own tracking of what bounced, when it has one. */
    readonly configurationSet?: string | undefined;
  },
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): MailOut {
  return {
    sender: o.from,
    async send(mail) {
      const at = now();
      const name = mail.from.name ?? o.from.name;
      const raw = buildMime({ ...mail, from: { address: o.from.address, ...(name ? { name } : {}) } }, { now: at });
      const url = `https://email.${o.region}.amazonaws.com/v2/email/outbound-emails`;
      const body = JSON.stringify({
        FromEmailAddress: mailbox(o.from.address, name),
        Destination: { ToAddresses: [...mail.to] },
        ...(mail.replyTo ? { ReplyToAddresses: [mail.replyTo] } : {}),
        Content: { Raw: { Data: base64(enc.encode(raw)) } },
        ...(o.configurationSet ? { ConfigurationSetName: o.configurationSet } : {}),
      });
      const headers = { "content-type": "application/json" };
      const signed = await signV4({
        method: "POST",
        url,
        headers,
        body,
        region: o.region,
        service: "ses",
        credentials: o.credentials,
        now: at,
      });
      const res = await fetchImpl(url, { method: "POST", headers: { ...headers, ...signed }, body });
      const answer = (await res.json().catch(() => ({}))) as { MessageId?: string; message?: string; Message?: string };
      if (!res.ok) throw new Error(`ses: ${answer.message ?? answer.Message ?? `HTTP ${res.status}`}`);
      return { messageId: answer.MessageId ?? "" };
    },
  };
}
