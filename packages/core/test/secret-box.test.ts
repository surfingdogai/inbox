import { describe, expect, it } from "vitest";
import { createSecretBox, parseSecretKeys, requireSecretBox } from "../src/secrets/box";
import { WriteError } from "../src/write/errors";

/**
 * Runs on Node and inside workerd: the box is WebCrypto only, so a secret sealed on one runtime
 * must open on the other.
 */
const NEWER = "2f8c1d0a6b4e37925c8f01ad6e3b47f0";
const OLDER = "9a15b7c3e8d240fb5617c9a2d0e4f836";
const ROW = "01JB8Z3M5Q7R9T0V2X4Y6A8C0E";

describe("secret box", () => {
  it("seals and opens a round trip, and never in the clear", async () => {
    const box = createSecretBox([NEWER]);
    if (!box) throw new Error("expected a box");
    const sealed = await box.seal("connector-config", ROW, '{"token":"shpat_secret"}');
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed.split(".")).toHaveLength(3);
    expect(sealed).not.toContain("shpat_secret");
    expect(await box.open("connector-config", ROW, sealed)).toBe('{"token":"shpat_secret"}');
  });

  it("gives a different ciphertext every time, because the iv is random", async () => {
    const box = createSecretBox([NEWER]);
    if (!box) throw new Error("expected a box");
    const a = await box.seal("webhook-secret", ROW, "whsec_abc");
    const b = await box.seal("webhook-secret", ROW, "whsec_abc");
    expect(a).not.toBe(b);
    expect(await box.open("webhook-secret", ROW, b)).toBe("whsec_abc");
  });

  it("refuses a ciphertext moved to another row", async () => {
    const box = createSecretBox([NEWER]);
    if (!box) throw new Error("expected a box");
    const sealed = await box.seal("connector-config", ROW, "secret");
    await expect(box.open("connector-config", "01JB8Z3M5Q7R9T0V2X4Y6A8C0F", sealed)).rejects.toThrow(/could not open/);
  });

  it("refuses a ciphertext read under another purpose", async () => {
    const box = createSecretBox([NEWER]);
    if (!box) throw new Error("expected a box");
    const sealed = await box.seal("connector-config", ROW, "secret");
    await expect(box.open("webhook-secret", ROW, sealed)).rejects.toThrow(/could not open/);
  });

  it("refuses tampered bytes rather than returning rubbish", async () => {
    const box = createSecretBox([NEWER]);
    if (!box) throw new Error("expected a box");
    const sealed = await box.seal("connector-config", ROW, "secret");
    await expect(box.open("connector-config", ROW, flipFirstCipherByte(sealed))).rejects.toThrow(/could not open/);
    await expect(box.open("connector-config", ROW, "v2.aaaa.bbbb")).rejects.toThrow(/not a sealed value/);
    await expect(box.open("connector-config", ROW, "nonsense")).rejects.toThrow(/not a sealed value/);
  });

  it("opens under an older key after a rotation, and seals under the newest", async () => {
    const old = createSecretBox([OLDER]);
    if (!old) throw new Error("expected a box");
    const sealedBefore = await old.seal("connector-config", ROW, "before the rotation");

    const rotated = createSecretBox([NEWER, OLDER]);
    if (!rotated) throw new Error("expected a box");
    expect(await rotated.open("connector-config", ROW, sealedBefore)).toBe("before the rotation");

    // Anything it seals now is under the newest key, so the old one can be retired.
    const sealedAfter = await rotated.seal("connector-config", ROW, "after the rotation");
    await expect(old.open("connector-config", ROW, sealedAfter)).rejects.toThrow(/could not open/);
    const newOnly = createSecretBox([NEWER]);
    if (!newOnly) throw new Error("expected a box");
    expect(await newOnly.open("connector-config", ROW, sealedAfter)).toBe("after the rotation");
    await expect(newOnly.open("connector-config", ROW, sealedBefore)).rejects.toThrow(/could not open/);
  });

  it("is null without a usable key, and the caller then names the variable", () => {
    expect(createSecretBox([])).toBeNull();
    expect(createSecretBox(["", "   "])).toBeNull();
    expect(parseSecretKeys(undefined)).toEqual([]);
    expect(parseSecretKeys("")).toEqual([]);
    expect(parseSecretKeys(` ${NEWER} , ,${OLDER} `)).toEqual([NEWER, OLDER]);

    expect(() => requireSecretBox(null)).toThrow(WriteError);
    expect(() => requireSecretBox(null)).toThrow(/INBOX_SECRET_KEY/);
    const box = createSecretBox([NEWER]);
    expect(requireSecretBox(box)).toBe(box);
  });
});

/** Flips one byte of the ciphertext, leaving the format intact, so only the GCM tag catches it. */
function flipFirstCipherByte(sealed: string): string {
  const [version, iv, cipher] = sealed.split(".");
  if (!version || !iv || !cipher) throw new Error("not a sealed value");
  const binary = atob(cipher.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return `${version}.${iv}.${btoa(out).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}
