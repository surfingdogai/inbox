import { runMigrations } from "@surfingdog/platform";
import { ATTACHMENT_LIMITS } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import {
  attachStatements,
  CHUNK_BYTES,
  checkFileLink,
  FILE_LINK_TTL_MS,
  FILE_WORDS,
  FileFetchError,
  fetchFile,
  fileHeaders,
  fileLink,
  fileUse,
  isAttachGuard,
  isUnclaimed,
  putFile,
  readFile,
  StripError,
  sniff,
  stripMetadata,
  sweepFiles,
  takeFiles,
  tiffOrientation,
  uploadFile,
} from "../src/attachments/index";
import { createDb, type Db } from "../src/db";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { createSecretBox } from "../src/secrets/box";
import { WriteError } from "../src/write/errors";
import { makeClient, resetTables } from "./harness";
import {
  ascii,
  avif,
  base64,
  concat,
  contains,
  crc32,
  heic,
  metaWebp,
  pdf,
  pdfOf,
  phoneJpeg,
  SECRET_PLACE,
  textPng,
} from "./trades-files";

/**
 * Files on a request (ADR-034 §2): told apart by their first bytes and never by what a sender says;
 * cleaned of where and when a photo was taken (only which way up it is stays); kept in the business's
 * own database in pieces, for the business alone, through links that work for ten minutes; fetched by
 * address only from a public https host. Runs on Node and in workerd.
 */

const T0 = Date.parse("2026-11-03T08:00:00Z");
const box = createSecretBox(["a-test-secret-that-is-long-enough-for-the-box"]);
/**
 * For tests that move megabytes through the database, or clear them out of it after the last one:
 * inside workerd's local D1 each takes seconds, and more on a busy machine.
 */
const MEGABYTES = { timeout: 30_000 };

async function setup(): Promise<Db> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return db;
}

describe("what a file is", () => {
  it("is what its first bytes say, never what it is called", () => {
    expect(sniff(phoneJpeg().bytes)).toBe("image/jpeg");
    expect(sniff(textPng())).toBe("image/png");
    expect(sniff(metaWebp())).toBe("image/webp");
    expect(sniff(pdf())).toBe("application/pdf");
    // A PDF may carry a few bytes before its header.
    expect(sniff(concat([0xef, 0xbb, 0xbf], pdf()))).toBe("application/pdf");
    // What phones send that is not taken, named so the answer can say what to send instead.
    expect(sniff(heic())).toBe("heic");
    expect(sniff(avif())).toBe("heic");
    expect(sniff(ascii("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"))).toBe("unknown");
    expect(sniff(ascii("GIF89a"))).toBe("unknown");
    // A page with a PDF header further in is not a PDF, nor is a header with no end.
    expect(sniff(concat(ascii(`<html><script>alert(1)</script>${" ".repeat(40)}`), pdf()))).toBe("unknown");
    expect(sniff(ascii("%PDF-1.7\n1 0 obj << >> endobj\n"))).toBe("unknown");
    expect(sniff(new Uint8Array(0))).toBe("unknown");
  });
});

describe("cleaning a photo", () => {
  it("takes EXIF, GPS, XMP, the MPF index, comments and the trailer out of a JPEG, and keeps which way up it is", () => {
    const { bytes, entropy, icc } = phoneJpeg(6);
    expect(contains(bytes, SECRET_PLACE)).toBe(true);
    const out = stripMetadata("image/jpeg", bytes);
    expect(contains(out.bytes, SECRET_PLACE)).toBe(false);
    expect(contains(out.bytes, "xmpmeta")).toBe(false);
    expect(contains(out.bytes, "MPF\0")).toBe(false);
    expect(contains(out.bytes, "Shot on a phone")).toBe(false);
    expect(contains(out.bytes, "SEFH")).toBe(false);
    // The colour profile and the image itself stay, byte for byte.
    expect(contains(out.bytes, icc)).toBe(true);
    expect(contains(out.bytes, entropy)).toBe(true);
    expect(out.orientation).toBe(6);
    expect(out.removed).toBe(4);
    expect([...out.bytes.slice(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...out.bytes.slice(-2)]).toEqual([0xff, 0xd9]);
    // The one EXIF block left holds the orientation alone: no GPS pointer, no second IFD.
    const at = out.bytes.findIndex((b, i) => b === 0xff && out.bytes[i + 1] === 0xe1);
    const body = out.bytes.slice(at + 4 + 6, at + 4 + 6 + 26);
    expect(tiffOrientation(body)).toBe(6);
    expect(contains(out.bytes, Uint8Array.from([0x88, 0x25]))).toBe(false);
  });

  it("writes no EXIF back for a photo stored the right way up", () => {
    const out = stripMetadata("image/jpeg", phoneJpeg(1).bytes);
    expect(out.orientation).toBeNull();
    expect(contains(out.bytes, "Exif\0\0")).toBe(false);
  });

  it("takes text, time and eXIf out of a PNG, writes the orientation back with a good checksum", () => {
    const out = stripMetadata("image/png", textPng(3));
    expect(contains(out.bytes, SECRET_PLACE)).toBe(false);
    expect(contains(out.bytes, "tEXt")).toBe(false);
    expect(contains(out.bytes, "tIME")).toBe(false);
    expect(out.orientation).toBe(3);
    const at = out.bytes.findIndex((_, i) => contains(out.bytes.slice(i, i + 4), "eXIf"));
    const len = new DataView(out.bytes.buffer, out.bytes.byteOffset + at - 4, 4).getUint32(0);
    const chunk = out.bytes.slice(at, at + 4 + len);
    const crc = new DataView(out.bytes.buffer, out.bytes.byteOffset + at + 4 + len, 4).getUint32(0);
    expect(crc).toBe(crc32(chunk));
    expect(tiffOrientation(chunk.slice(4))).toBe(3);
    expect(contains(out.bytes, "IDAT")).toBe(true);
    expect(contains(out.bytes, "IEND")).toBe(true);
  });

  it("takes EXIF and XMP out of a WebP, says so in its header, and keeps its size right", () => {
    const out = stripMetadata("image/webp", metaWebp(8));
    expect(contains(out.bytes, SECRET_PLACE)).toBe(false);
    expect(contains(out.bytes, "XMP ")).toBe(false);
    expect(out.orientation).toBe(8);
    const size = new DataView(out.bytes.buffer, out.bytes.byteOffset + 4, 4).getUint32(0, true);
    expect(size).toBe(out.bytes.byteLength - 8);
    const vp8x = out.bytes.findIndex((_, i) => contains(out.bytes.slice(i, i + 4), "VP8X"));
    // XMP's flag off; EXIF's on, for the orientation written back.
    expect((out.bytes[vp8x + 8] ?? 0) & 0x0c).toBe(0x08);
  });

  it("leaves a PDF as it is: a document, shown only as a download", () => {
    const file = pdf();
    expect(stripMetadata("application/pdf", file).bytes).toEqual(file);
    expect(fileHeaders("application/pdf", "plan.pdf", file.byteLength)["Content-Disposition"]).toMatch(/^attachment;/);
    expect(fileHeaders("image/jpeg", "leak.jpg", 10)["Content-Disposition"]).toMatch(/^inline;/);
  });

  it("refuses what is not what its first bytes promised", () => {
    const { bytes } = phoneJpeg();
    expect(() => stripMetadata("image/jpeg", bytes.slice(0, 40))).toThrow(StripError);
    const png = textPng();
    expect(() => stripMetadata("image/png", png.slice(0, png.byteLength - 20))).toThrow(StripError);
  });

  it("serves a file as its own type, sniffed by nobody, run by nothing, kept by no shared cache", () => {
    const h = fileHeaders("image/png", 'roof "north".png', 2048);
    expect(h["Content-Type"]).toBe("image/png");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Content-Security-Policy"]).toContain("sandbox");
    expect(h["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(h["Cache-Control"]).toMatch(/^private/);
    expect(h["Content-Disposition"]).not.toContain('"north"');
  });
});

describe("keeping files", () => {
  it("keeps a file in pieces and reads it back whole", MEGABYTES, async () => {
    const db = await setup();
    const bytes = new Uint8Array(CHUNK_BYTES * 2 + 1234).map((_, i) => i % 251);
    const ref = await putFile(
      db,
      {
        id: "att_aaaaaaaaaaaaaaaaaaaaaaaa",
        name: "plan.pdf",
        contentType: "application/pdf",
        bytes,
        sha256: "0".repeat(64),
      },
      T0,
    );
    expect(ref.size).toBe(bytes.byteLength);
    const got = await readFile(db, ref.id);
    // Compared in a plain loop: a deep equal over a megabyte takes seconds.
    expect(got?.bytes.byteLength).toBe(bytes.byteLength);
    expect(got?.bytes.findIndex((b, i) => b !== bytes[i])).toBe(-1);
    expect(await fileUse(db, T0)).toEqual({ kept: bytes.byteLength, waiting: bytes.byteLength, waitingFrom: 0 });
  });

  it("keeps an unclaimed file an hour, and the sweep takes it and its bytes after", MEGABYTES, async () => {
    const db = await setup();
    const id = "att_bbbbbbbbbbbbbbbbbbbbbbbb";
    await putFile(
      db,
      { id, name: "tap.jpg", contentType: "image/jpeg", bytes: new Uint8Array(10), sha256: "1".repeat(64) },
      T0,
    );
    expect(await isUnclaimed(db, id, T0 + 59 * 60_000)).toBe(true);
    expect(await isUnclaimed(db, id, T0 + ATTACHMENT_LIMITS.uploadTtlMs + 1)).toBe(false);
    const swept = await sweepFiles(db, T0 + ATTACHMENT_LIMITS.uploadTtlMs + 1);
    expect(swept.expired).toBe(1);
    expect(await readFile(db, id)).toBeNull();
    const { rows } = await db.client.query({
      sql: "SELECT COUNT(*) FROM attachment_chunks WHERE key = ?",
      params: [id],
    });
    expect(Number(rows[0]?.[0])).toBe(0);
  });

  it("links a file for ten minutes, under the instance's own key, to that file only", async () => {
    if (!box) throw new Error("no box");
    const id = "att_cccccccccccccccccccccccc";
    const link = await fileLink(box, id, T0);
    const url = new URL(link.path, "https://inbox.example.com");
    const e = url.searchParams.get("e");
    const s = url.searchParams.get("s");
    expect(await checkFileLink(box, id, e, s, T0 + 60_000)).toBe(true);
    expect(await checkFileLink(box, id, e, s, T0 + FILE_LINK_TTL_MS + 1)).toBe(false);
    expect(await checkFileLink(box, "att_dddddddddddddddddddddddd", e, s, T0)).toBe(false);
    expect(await checkFileLink(box, id, String(Number(e) + 1), s, T0)).toBe(false);
    expect(await checkFileLink(box, id, e, `${s?.slice(0, -1)}A`, T0)).toBe(false);
    // A link from another instance's key is nobody's here.
    const other = createSecretBox(["another-instance-with-its-own-long-secret"]);
    if (!other) throw new Error("no box");
    const foreign = new URL((await fileLink(other, id, T0)).path, "https://x.example");
    expect(await checkFileLink(box, id, foreign.searchParams.get("e"), foreign.searchParams.get("s"), T0)).toBe(false);
    // An expiry further out than any link this inbox makes is refused too.
    expect(await checkFileLink(box, id, String(T0 + 86_400_000), s, T0)).toBe(false);
  });
});

describe("taking a request's files", () => {
  const intake = (db: Db, over: Partial<Parameters<typeof takeFiles>[0]> = {}) => ({
    db,
    quotaBytes: null,
    enabled: true,
    now: T0,
    ...over,
  });

  it("takes a photo inline, cleaned, and names it by what it is", async () => {
    const db = await setup();
    const [ref] = await takeFiles(intake(db), [{ data_base64: base64(phoneJpeg().bytes), name: "../../etc/leak.png" }]);
    expect(ref?.content_type).toBe("image/jpeg");
    expect(ref?.name).toBe("leak.jpg");
    const got = await readFile(db, ref?.id ?? "");
    expect(contains(got?.bytes ?? new Uint8Array(), SECRET_PLACE)).toBe(false);
  });

  it("refuses a HEIC photo with what to send instead, and what is not a picture or a PDF", async () => {
    const db = await setup();
    const heicTry = takeFiles(intake(db), [{ data_base64: base64(heic()) }]);
    await expect(heicTry).rejects.toMatchObject({ code: "invalid_input", message: FILE_WORDS.heic });
    await expect(heicTry).rejects.toMatchObject({ fields: [{ path: "attachments.0" }] });
    await expect(takeFiles(intake(db), [{ data_base64: base64(ascii("<svg/>")) }])).rejects.toMatchObject({
      message: FILE_WORDS.type,
    });
  });

  it("takes at most six files, 4 MB each inline and 8 MB in one call", MEGABYTES, async () => {
    const db = await setup();
    const one = { data_base64: base64(pdf()) };
    await expect(
      takeFiles(
        intake(db),
        Array.from({ length: 7 }, () => one),
      ),
    ).rejects.toMatchObject({
      message: FILE_WORDS.tooMany,
    });
    const big = pdfOf(ATTACHMENT_LIMITS.inlineBytes + 32);
    await expect(takeFiles(intake(db), [{ data_base64: base64(big) }])).rejects.toMatchObject({
      message: FILE_WORDS.inlineTooLarge,
    });
    const three = pdfOf(3 * 1024 * 1024);
    await expect(
      takeFiles(intake(db), [
        { data_base64: base64(three) },
        { data_base64: base64(three) },
        { data_base64: base64(three) },
      ]),
    ).rejects.toMatchObject({ message: FILE_WORDS.inlineCall });
  });

  it("names an upload once, within its hour", async () => {
    const db = await setup();
    const up = await uploadFile(intake(db), textPng(), "roof.png");
    expect(up.upload_id).toMatch(/^upl_/);
    const [ref] = await takeFiles(intake(db), [{ upload_id: up.upload_id }]);
    expect(ref?.id).toBe(up.attachment.id);
    // Taken by an item now: nobody can name it again.
    await db.client.query({
      sql: "UPDATE blobs SET item_id = 'i1', expires_at = NULL WHERE key = ?",
      params: [ref?.id ?? ""],
    });
    await expect(takeFiles(intake(db), [{ upload_id: up.upload_id }])).rejects.toMatchObject({
      message: FILE_WORDS.upload,
    });
    const late = await uploadFile(intake(db), pdf(), "plan.pdf");
    await expect(
      takeFiles(intake(db, { now: T0 + ATTACHMENT_LIMITS.uploadTtlMs + 1 }), [{ upload_id: late.upload_id }]),
    ).rejects.toMatchObject({ message: FILE_WORDS.upload });
  });

  it("holds what waits for a request to its own allowance, each sender to a share of it", MEGABYTES, async () => {
    const db = await setup();
    const nine = pdfOf(9 * 1024 * 1024);
    const from = (sentBy: string) => intake(db, { sentBy });
    // One sender: three uploads of 9 MB, and the fourth is past its 30 MB.
    for (let i = 0; i < 3; i++) await uploadFile(from("ip:203.0.113.9"), nine, "plan.pdf");
    await expect(uploadFile(from("ip:203.0.113.9"), nine, "plan.pdf")).rejects.toMatchObject({
      code: "not_allowed",
      details: { reason: "files_waiting" },
    });
    // Others still may, up to what the inbox keeps waiting at all (60 MB).
    for (let i = 0; i < 3; i++) await uploadFile(from("ip:198.51.100.20"), nine, "plan.pdf");
    await expect(uploadFile(from("ip:192.0.2.44"), nine, "plan.pdf")).rejects.toMatchObject({
      details: { reason: "files_waiting" },
    });
    // A request's own photos sent with it are taken all the same once the waiting ones' hour is over.
    const later = T0 + ATTACHMENT_LIMITS.uploadTtlMs + 1;
    expect((await fileUse(db, later)).waiting).toBe(0);
    const [ref] = await takeFiles(intake(db, { now: later }), [{ data_base64: base64(pdf()) }]);
    expect(ref?.content_type).toBe("application/pdf");
  });

  it("hands files to an item only in a batch that fails when one of them was not there to take", async () => {
    const db = await setup();
    const up = await uploadFile(intake(db), pdf(), "plan.pdf");
    const id = up.attachment.id;
    // Taken by another request first: the batch naming it again fails, whole.
    await db.batch(attachStatements([id], "item_a", null, T0));
    const second = db.batch(attachStatements([id], "item_b", null, T0));
    const failure = await second.then(
      () => null,
      (error: unknown) => error,
    );
    expect(isAttachGuard(failure)).toBe(true);
    // Its hour over before the batch: the same.
    const late = await uploadFile(intake(db), pdf(), "late.pdf");
    const lateFailure = await db
      .batch(attachStatements([late.attachment.id], "item_c", null, T0 + ATTACHMENT_LIMITS.uploadTtlMs + 1))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isAttachGuard(lateFailure)).toBe(true);
  });

  it("keeps the business to its quota, and takes no file where none could be shown", async () => {
    const db = await setup();
    await expect(takeFiles(intake(db, { quotaBytes: 50 }), [{ data_base64: base64(textPng()) }])).rejects.toMatchObject(
      {
        code: "not_allowed",
        details: { reason: "files_quota" },
      },
    );
    await expect(takeFiles(intake(db, { enabled: false }), [{ data_base64: base64(pdf()) }])).rejects.toBeInstanceOf(
      WriteError,
    );
    expect(await takeFiles(intake(db, { enabled: false }), [])).toEqual([]);
  });
});

describe("a file named by its address", () => {
  /** A fake web: answers by URL, and keeps what was asked. */
  function web(routes: Record<string, () => Response>) {
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      const r = routes[url];
      return r ? r() : new Response("nope", { status: 404 });
    }) as typeof fetch;
    return { asked, fetchImpl };
  }

  it("is fetched from a public https host, following a redirect that stays public", async () => {
    const w = web({
      "https://files.example.org/a.jpg": () =>
        new Response(null, { status: 302, headers: { location: "https://cdn.example.net/a.jpg" } }),
      "https://cdn.example.net/a.jpg": () => new Response(phoneJpeg().bytes as BodyInit, { status: 200 }),
    });
    const bytes = await fetchFile("https://files.example.org/a.jpg", { fetchImpl: w.fetchImpl, maxBytes: 1_000_000 });
    expect(sniff(bytes)).toBe("image/jpeg");
  });

  it("is never fetched from a private, local or plain-http address, nor with a password in it", async () => {
    for (const [url, reason] of [
      ["http://files.example.org/a.jpg", "not_https"],
      ["https://127.0.0.1/a.jpg", "not_public"],
      ["https://[::1]/a.jpg", "not_public"],
      ["https://localhost/a.jpg", "not_public"],
      ["https://10.0.0.7/a.jpg", "not_public"],
      ["https://169.254.169.254/latest/meta-data", "not_public"],
      ["https://intranet/a.jpg", "not_public"],
      ["https://user:pass@files.example.org/a.jpg", "credentials"],
    ] as const) {
      const w = web({});
      const err = await fetchFile(url, { fetchImpl: w.fetchImpl, maxBytes: 1_000 }).catch((e: unknown) => e);
      expect(err, url).toBeInstanceOf(FileFetchError);
      expect((err as FileFetchError).reason, url).toBe(reason);
      expect(w.asked, url).toEqual([]);
    }
  });

  it("stops at a redirect to a private address, too many redirects, and a body larger than a file", async () => {
    const w = web({
      "https://a.example.org/x": () =>
        new Response(null, { status: 301, headers: { location: "https://192.168.1.5/x" } }),
      "https://b.example.org/x": () =>
        new Response(null, { status: 302, headers: { location: "https://b.example.org/x" } }),
      "https://c.example.org/x": () => new Response("x", { status: 200, headers: { "content-length": "999999" } }),
      "https://d.example.org/x": () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(800));
              c.enqueue(new Uint8Array(800));
              c.close();
            },
          }),
          { status: 200 },
        ),
    });
    const reason = async (url: string) =>
      ((await fetchFile(url, { fetchImpl: w.fetchImpl, maxBytes: 1_000 }).catch((e: unknown) => e)) as FileFetchError)
        .reason;
    expect(await reason("https://a.example.org/x")).toBe("not_public");
    expect(w.asked).not.toContain("https://192.168.1.5/x");
    expect(await reason("https://b.example.org/x")).toBe("redirects");
    expect(await reason("https://c.example.org/x")).toBe("too_large");
    expect(await reason("https://d.example.org/x")).toBe("too_large");
    expect(await reason("https://e.example.org/x")).toBe("status");
  });

  it("is refused with the business's words when its address fails, through the intake", async () => {
    const db = await setup();
    const w = web({});
    await expect(
      takeFiles({ db, quotaBytes: null, enabled: true, now: T0, fetchImpl: w.fetchImpl }, [
        { url: "https://10.1.2.3/roof.jpg" },
      ]),
    ).rejects.toMatchObject({ code: "invalid_input", fields: [{ path: "attachments.0" }] });
  });
});
