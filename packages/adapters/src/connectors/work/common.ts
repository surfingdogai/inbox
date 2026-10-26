import { ConnectorError, type ConnectorHttpResponse, type OutboundRequest, type PostalAddress } from "@surfingdog/core";
import { retryAfterMs } from "../http";

/**
 * What the job-tool connectors share (ADR-034 §5): ids made from the inbox's own mark so a request is
 * written once whatever happens, a multipart body for files, and the few words every tool's answers
 * are read with. Web APIs only.
 */

const encoder = new TextEncoder();

/**
 * A UUID made from what only this inbox can make (`ctx.marker`) and the request's key: the same on
 * every retry and on every inbox restart, so a tool that takes the caller's own ids is never written
 * twice, and nobody else can make it.
 */
export async function uuidFrom(marker: string, key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${marker}\u0000${key}`)));
  const b = digest.slice(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A short tag from the request's key, for tools that find a record only by what it holds. */
export async function tagFrom(marker: string, key: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(`tag\u0000${marker}\u0000${key}`)),
  );
  return [...digest.slice(0, 5)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export interface Part {
  readonly name: string;
  readonly value: string | { readonly filename: string; readonly contentType: string; readonly bytes: Uint8Array };
}

/** A `multipart/form-data` body and its content type: fields and at most a few files. */
export function multipart(parts: readonly Part[]): { body: Uint8Array; contentType: string } {
  const boundary = `----surfingdog${crypto.getRandomValues(new Uint32Array(2)).join("")}`;
  const chunks: Uint8Array[] = [];
  const safe = (s: string) => s.replace(/[\r\n"]/g, "_");
  for (const p of parts) {
    if (typeof p.value === "string") {
      chunks.push(
        encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${safe(p.name)}"\r\n\r\n${p.value}\r\n`),
      );
    } else {
      chunks.push(
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${safe(p.name)}"; filename="${safe(p.value.filename)}"\r\nContent-Type: ${p.value.contentType}\r\n\r\n`,
        ),
        p.value.bytes,
        encoder.encode("\r\n"),
      );
    }
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const body = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** An answer's JSON, or null when it is not JSON. */
export function jsonOf(res: ConnectorHttpResponse): unknown {
  try {
    return res.text ? JSON.parse(res.text) : null;
  } catch {
    return null;
  }
}

/**
 * The failures every tool answers alike, in the owner's words: a key it does not take, a request to
 * slow down (with how long), a tool that is not answering properly. Anything else is the caller's.
 */
export function failOn(tool: string, res: ConnectorHttpResponse, keyField: string): void {
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorError("auth", `${tool} did not take that key. Make a new one and connect again.`, {
      field: keyField,
    });
  }
  if (res.status === 429) {
    throw new ConnectorError("rate_limited", `${tool} asked this inbox to slow down.`, {
      retryAfterMs: retryAfterMs(res.headers),
    });
  }
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      `${tool} is not answering properly; this inbox tries again in a few minutes.`,
    );
  }
}

/** A person's name as two parts, for tools that ask for first and last. */
export function splitName(name: string | null): { first: string; last: string } {
  const n = (name ?? "").trim().replace(/\s+/g, " ");
  if (!n) return { first: "", last: "" };
  const at = n.lastIndexOf(" ");
  return at < 0 ? { first: n, last: "" } : { first: n.slice(0, at), last: n.slice(at + 1) };
}

/** An address on one line, as most tools take it. */
export function addressLine(a: PostalAddress | null): string {
  if (!a) return "";
  return [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

/** What a job's title says in the tool: what it is for, and the request's reference. */
export function jobTitle(r: OutboundRequest): string {
  return `${r.title} (${r.reference})`.slice(0, 200);
}

/** The file's name in the tool, with its extension. */
export function fileName(name: string, contentType: string): string {
  const ext =
    contentType === "image/jpeg"
      ? ".jpg"
      : contentType === "image/png"
        ? ".png"
        : contentType === "image/webp"
          ? ".webp"
          : ".pdf";
  return /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}${ext}`;
}
