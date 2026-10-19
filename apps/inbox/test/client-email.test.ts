import { describe, expect, it } from "vitest";
import {
  breakAtDots,
  checkedWords,
  FIRST_STEP,
  forwardWords,
  linkHost,
  PROVIDER_STEPS,
  rowsText,
  senderWords,
  shortName,
  stepsFor,
  webPersonMailto,
} from "../client/src/lib/email";
import type { ForwardView } from "../client/src/lib/types";

/** Settings → Email's words (ADR-026): every provider's steps name the inbox's address, and nothing else is left to fill. */
describe("Settings → Email", () => {
  it("gives every provider steps with the inbox's address in them, and the ones that confirm say so", () => {
    for (const [provider, s] of Object.entries(PROVIDER_STEPS)) {
      const filled = stepsFor(
        provider as keyof typeof PROVIDER_STEPS,
        "misty-stork-z4if@in.surfingdog.ai",
        "support@shop.example",
      );
      expect(filled.steps.length, provider).toBeGreaterThanOrEqual(4);
      // Every list starts by saying to forward only the address customers write to.
      expect(filled.steps[0], provider).toBe(FIRST_STEP);
      expect(filled.steps.join(" "), provider).toContain("misty-stork-z4if@in.surfingdog.ai");
      expect(JSON.stringify(filled), provider).not.toContain("{to}");
      expect(JSON.stringify(filled), provider).not.toContain("{address}");
      if (s.confirms) expect(filled.steps.join(" "), provider).toMatch(/shows on this page/);
    }
    expect(PROVIDER_STEPS.microsoft_365.note).toMatch(/shared mailbox/);
    // A mailbox shared with the owner's own mail forwards only this address's mail.
    expect(stepsFor("gmail", "x@in.example", "support@shop.example").note).toContain("to:support@shop.example");
    expect(stepsFor("outlook", "x@in.example", "support@shop.example").note).toContain("Sent to support@shop.example");
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
    // Named by the provider that sent it, not by what the owner picked.
    expect(
      forwardWords(
        f({
          state: "confirm",
          provider: "other",
          provider_name: "Another provider",
          confirmation: { from: "x@zoho.com", provider: "Zoho Mail", code: "1", url: null, at: "" },
        }),
      ).text,
    ).toBe("Confirm in Zoho Mail");
    expect(forwardWords(f({ state: "not_yet" })).text).toBe("Not arriving yet");
  });

  it("shows where a link opens, and DNS names as panels want them", () => {
    expect(linkHost("https://mail-settings.google.com/mail/vf-x")).toBe("mail-settings.google.com");
    expect(linkHost("not a link")).toBe("");
    expect(shortName("abc._domainkey.shop.example", "shop.example")).toBe("abc._domainkey");
    expect(shortName("shop.example.", "shop.example")).toBe("@");
    expect(shortName("other.example", "shop.example")).toBe("other.example");
    expect(senderWords({ address: "a@shop.example", state: "verified", records: [], checkedAt: null })).toBe(
      "Your own address, signed for your domain.",
    );
  });

  it("copies all the rows, writes them to the web person, says when they were checked, and breaks values at dots", () => {
    const rows = [
      { type: "CNAME" as const, name: "abc._domainkey.shop.example", value: "abc.dkim.amazonses.com" },
      {
        type: "MX" as const,
        name: "sdmail.shop.example",
        value: "feedback-smtp.eu-west-1.amazonses.com",
        priority: 10,
      },
    ];
    expect(rowsText(rows, "shop.example")).toBe(
      "CNAME  abc._domainkey  abc.dkim.amazonses.com\nMX  sdmail  10  feedback-smtp.eu-west-1.amazonses.com",
    );
    const mail = webPersonMailto("shop.example", rows);
    expect(mail.startsWith("mailto:?subject=DNS%20records%20for%20shop.example&body=")).toBe(true);
    expect(decodeURIComponent(mail)).toContain("None of them changes where our email goes.");
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(checkedWords("2026-10-19T11:59:40Z", now)).toBe("Checked just now");
    expect(checkedWords("2026-10-19T11:55:00Z", now)).toBe("Checked 5 minutes ago");
    expect(checkedWords("2026-10-19T09:00:00Z", now)).toBe("Checked 3 hours ago");
    expect(breakAtDots("feedback-smtp.eu-west-1.amazonses.com")).toEqual([
      "feedback-smtp.",
      "eu-west-1.",
      "amazonses.",
      "com",
    ]);
  });
});
