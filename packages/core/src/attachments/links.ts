import type { AttachmentType } from "@surfingdog/spec";
import { b64u, unb64u } from "../receipts/sign";
import type { SecretBox } from "../secrets/box";

/**
 * How the business sees a file (ADR-034 §2): through a link that names the file, when it stops
 * working, and a MAC over both under the instance's own key. Nobody else can make one, it works for
 * ten minutes, and rotating `INBOX_SECRET_KEY` retires every link out there. Files are never public.
 */

/** How long a link to a file works. */
export const FILE_LINK_TTL_MS = 10 * 60_000;
/** Where files are served: `/v1/files/<id>?e=<expiry>&s=<mac>`. */
export const FILE_PATH = "/v1/files/";

async function macOf(box: SecretBox, id: string, expires: number): Promise<Uint8Array> {
  const key = await box.mac("attachment-link");
  const data = new TextEncoder().encode(`${id}.${expires}`);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data as BufferSource));
}

/** A link to a file for the business, from `now` for `FILE_LINK_TTL_MS`: a path, to put on the inbox's own address. */
export async function fileLink(box: SecretBox, id: string, now: number): Promise<{ path: string; expires: number }> {
  const expires = now + FILE_LINK_TTL_MS;
  const mac = await macOf(box, id, expires);
  return { path: `${FILE_PATH}${encodeURIComponent(id)}?e=${expires}&s=${b64u(mac)}`, expires };
}

/**
 * Whether a link is one this inbox made for this file and still works: the MAC made again and
 * compared in constant time, the expiry after it.
 */
export async function checkFileLink(
  box: SecretBox,
  id: string,
  e: string | null | undefined,
  s: string | null | undefined,
  now: number,
): Promise<boolean> {
  if (!e || !s || !/^\d{1,16}$/.test(e) || !/^[A-Za-z0-9_-]{43}$/.test(s)) return false;
  const expires = Number(e);
  let given: Uint8Array;
  try {
    given = unb64u(s);
  } catch {
    return false;
  }
  // The MAC made again and compared in constant time: the key only signs.
  const want = await macOf(box, id, expires);
  let diff = given.byteLength ^ want.byteLength;
  for (let i = 0; i < want.byteLength; i++) diff |= (given[i] ?? 0) ^ (want[i] ?? 0);
  const ok = diff === 0;
  return ok && expires > now && expires <= now + FILE_LINK_TTL_MS + 60_000;
}

/**
 * The headers a file is served with: its real type, never sniffed again by the browser; a PDF as a
 * download, an image inline; a sandbox that runs nothing whatever the file holds; kept by no cache but
 * the owner's own browser, for as long as the link works; sent nowhere else.
 */
export function fileHeaders(type: AttachmentType, name: string, size: number): Record<string, string> {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const disposition = type === "application/pdf" ? "attachment" : "inline";
  return {
    "Content-Type": type,
    "Content-Length": String(size),
    "Content-Disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, max-age=600",
  };
}
