import { describe, expect, it } from "vitest";
import { ownerTime } from "../src/phone";

describe("a time in the owner's emails", () => {
  it("is the business's own day and time, named by its zone's city, with no seconds", () => {
    const at = Date.parse("2026-11-15T13:32:11Z");
    expect(ownerTime(at, "Europe/Lisbon")).toBe("Sunday 15 November at 13:32 (Lisbon time)");
    expect(ownerTime(at, "America/Sao_Paulo")).toBe("Sunday 15 November at 10:32 (Sao Paulo time)");
    expect(ownerTime(at, "Asia/Tokyo")).toBe("Sunday 15 November at 22:32 (Tokyo time)");
    expect(ownerTime(at, "UTC")).toBe("Sunday 15 November at 13:32 (UTC)");
    // A zone that cannot be read: UTC, said so.
    expect(ownerTime(at, "Mars/Olympus")).toBe("Sun, 15 Nov 2026 13:32:11 UTC");
  });
});
