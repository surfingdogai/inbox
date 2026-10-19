import { describe, expect, it } from "vitest";
import { forwardWords, linkHost, PROVIDER_STEPS, senderWords, shortName, stepsFor } from "../client/src/lib/email";
import type { ForwardView } from "../client/src/lib/types";

/** Settings → Email's words (ADR-026): every provider's steps name the inbox's address, and nothing else is left to fill. */
describe("Settings → Email", () => {
  it("gives every provider steps with the inbox's address in them, and the ones that confirm say so", () => {
    for (const [provider, s] of Object.entries(PROVIDER_STEPS)) {
      const filled = stepsFor(provider as keyof typeof PROVIDER_STEPS, "misty-stork-z4if@in.surfingdog.ai");
      expect(filled.steps.length, provider).toBeGreaterThanOrEqual(3);
      expect(filled.steps.join(" "), provider).toContain("misty-stork-z4if@in.surfingdog.ai");
      expect(JSON.stringify(filled), provider).not.toContain("{to}");
      if (s.confirms) expect(filled.steps.join(" "), provider).toMatch(/shows on this page/);
    }
    expect(PROVIDER_STEPS.microsoft_365.note).toMatch(/admin/);
  });

  it("says where a forward stands in a few words", () => {
    const f = (o: Partial<ForwardView>): ForwardView => ({
      id: "f",
      address: "support@shop.example",
      provider: "gmail",
      provider_name: "Gmail",
      state: "setup",
      checking: false,
      plus_ok: false,
      confirmation: null,
      check_sent_at: null,
      check_seen_at: null,
      last_seen_at: null,
      created_at: "2026-10-19T09:00:00.000Z",
      ...o,
    });
    expect(forwardWords(f({ checking: true })).text).toBe("Checking…");
    expect(forwardWords(f({ state: "working" }))).toEqual({ text: "Forwarding works", tone: "ok" });
    expect(forwardWords(f({ state: "confirm" })).text).toBe("Confirm in Gmail");
    expect(forwardWords(f({ state: "not_yet" })).text).toBe("Not arriving yet");
  });

  it("shows where a link opens, and DNS names as panels want them", () => {
    expect(linkHost("https://mail-settings.google.com/mail/vf-x")).toBe("mail-settings.google.com");
    expect(linkHost("not a link")).toBe("");
    expect(shortName("abc._domainkey.shop.example", "shop.example")).toBe("abc._domainkey");
    expect(shortName("shop.example.", "shop.example")).toBe("@");
    expect(shortName("other.example", "shop.example")).toBe("other.example");
    expect(senderWords({ address: "a@shop.example", state: "verified", records: [], checkedAt: null })).toBe(
      "Email goes from a@shop.example.",
    );
  });
});
