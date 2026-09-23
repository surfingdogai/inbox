import { DEFAULT_SETTINGS, mergeSettings, type NetworkView, parseStoredSettings } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { agoWords, networkStatus, parseNetworkOrigin, receiptWords } from "../client/src/lib/networks";
import { toSettingsDoc, toSettingsForm } from "../client/src/lib/settings";

// What the owner app sends when it saves, and the words Settings → Networks shows.
describe("the General settings save", () => {
  it("sends only its own sections, so networks and everything else keep their values", () => {
    const stored = {
      networks: { "https://network.surfingdog.ai": { enabled: true } },
      integrations: { webhooks: { timeoutMs: 5_000 } },
      notifications: { ownerEmail: "hello@example.com" },
    };
    const loaded = parseStoredSettings(stored).settings;
    const doc = toSettingsDoc({ ...toSettingsForm(loaded), testMode: true });
    expect(Object.keys(doc).sort()).toEqual(["booking", "email", "notifications", "orders", "testMode"]);
    const after = parseStoredSettings(mergeSettings(stored, doc)).settings;
    expect(after.networks["https://network.surfingdog.ai"]?.enabled).toBe(true);
    expect(after.integrations.webhooks.timeoutMs).toBe(5_000);
    expect(after.notifications.ownerEmail).toBe("hello@example.com");
    expect(after.testMode).toBe(true);
    // Nothing the owner did not choose is written: no defaults for sections this form does not show.
    expect(mergeSettings(stored, doc)).not.toHaveProperty("business");
  });

  it("clears an emptied field with null instead of leaving it as it was", () => {
    const loaded = parseStoredSettings({
      notifications: { ownerEmail: "hello@example.com", appUrl: "https://inbox.example.com" },
      email: { fromName: "Shop" },
    }).settings;
    const doc = toSettingsDoc({ ...toSettingsForm(loaded), ownerEmail: "  ", fromName: "" });
    expect(doc.notifications).toEqual({ ownerEmail: null, appUrl: "https://inbox.example.com" });
    expect(doc.email).toMatchObject({ fromName: null });
    const after = parseStoredSettings(
      mergeSettings({ notifications: { ownerEmail: "hello@example.com", appUrl: "https://inbox.example.com" } }, doc),
    ).settings;
    expect(after.notifications).toEqual({ appUrl: "https://inbox.example.com" });
  });

  it("keeps the inbound secret a read left out, and removes it only when asked", () => {
    // A current server never returns the secret; it names it in `redacted`.
    const loaded = parseStoredSettings({ email: { fromName: "Shop" } }).settings;
    const form = toSettingsForm(loaded, ["email.inboundSecret"]);
    expect(form.inboundSecretSet).toBe(true);
    expect(form.inboundSecret).toBe("");
    const kept = toSettingsDoc(form).email as Record<string, unknown>;
    expect(kept).not.toHaveProperty("inboundSecret");
    const stored = { email: { inboundSecret: "old-secret-0123456789" } };
    expect(parseStoredSettings(mergeSettings(stored, toSettingsDoc(form))).settings.email.inboundSecret).toBe(
      "old-secret-0123456789",
    );
    // A current server masks it in place and names it in `redacted`: the form treats that the same.
    const masked = toSettingsForm({ ...loaded, email: { ...loaded.email, inboundSecret: "(redacted)" } }, [
      "email.inboundSecret",
    ]);
    expect(masked).toMatchObject({ inboundSecret: "", inboundSecretSet: true });
    expect(toSettingsDoc(masked).email).not.toHaveProperty("inboundSecret");
    const replaced = toSettingsDoc({ ...form, inboundSecret: " new-secret-0123456789 " }).email;
    expect(replaced).toMatchObject({ inboundSecret: "new-secret-0123456789" });
    const removed = toSettingsDoc({ ...form, removeInboundSecret: true }).email;
    expect(removed).toMatchObject({ inboundSecret: null });
  });

  it("sends a number field that holds no number as typed, so the API names it", () => {
    const doc = toSettingsDoc({ ...toSettingsForm(DEFAULT_SETTINGS), autoExpireHours: "", approvalLimit: "12,50" });
    expect(doc.booking).toMatchObject({ autoExpireHours: "", cancellationWindowMin: 1440 });
    expect(doc.orders).toEqual({ maxValueWithoutApprovalMinor: 1250 });
  });
});

describe("Settings → Networks", () => {
  const base: NetworkView = {
    origin: "https://network.example.com",
    enabled: true,
    issue: true,
    share: { listing: true, counts: true, receipts: true },
    registration: "registered",
    registered_at: null,
    last_ping_at: null,
    last_error: null,
    last_error_at: null,
    failing_since: null,
    receipts: { published: 0, queued: 0, refused: 0 },
  };
  const now = Date.parse("2026-09-23T14:30:00Z");

  it("checks an address before it is sent", () => {
    expect(parseNetworkOrigin("https://Network.Example.com/")).toEqual({ origin: "https://network.example.com" });
    expect(parseNetworkOrigin("network.example.com")).toEqual({ origin: "https://network.example.com" });
    for (const bad of [
      "",
      "http://network.example.com",
      "https://network.example.com/v1",
      "https://network.example.com:8443",
      "https://localhost",
      "https://192.168.1.4",
      "https://printer.local",
    ]) {
      expect(parseNetworkOrigin(bad), bad).toHaveProperty("problem");
    }
  });

  it("says in one line how each network is doing", () => {
    expect(networkStatus({ ...base, enabled: false }, now).line).toBe("Off");
    expect(networkStatus({ ...base, last_ping_at: "2026-09-23T14:27:00Z" }, now)).toMatchObject({
      line: "Reporting, last ping 3 min ago",
      tone: "success",
    });
    const down = networkStatus(
      {
        ...base,
        last_ping_at: "2026-09-23T13:00:00Z",
        failing_since: "2026-09-22T09:05:00Z",
        last_error: "ping: HTTP 503",
      },
      now,
      "en-GB",
    );
    expect(down).toMatchObject({ tone: "danger", detail: "ping: HTTP 503" });
    // Another day, so the date is in it; the hour depends on the machine's time zone.
    expect(down.line).toMatch(/^Not reachable since 22 \S+, \d\d:\d\d$/);
    expect(networkStatus({ ...base, registration: "pending" }, now).line).toBe(
      "Waiting for network.example.com to verify your domain",
    );
    expect(
      networkStatus({ ...base, last_error: "no public address: set the Inbox address in Settings" }, now).line,
    ).toBe("Not reporting: no public address: set the Inbox address in Settings");
    expect(networkStatus(base, now).line).toBe("Starting: the first report goes out in a moment");
  });

  it("counts receipts in plain words", () => {
    expect(receiptWords({ published: 1, queued: 0, refused: 0 })).toEqual(["1 receipt published"]);
    expect(receiptWords({ published: 12, queued: 3, refused: 1 })).toEqual([
      "12 receipts published",
      "3 waiting",
      "1 refused",
    ]);
    expect(agoWords("2026-09-23T14:29:30Z", now)).toBe("just now");
    expect(agoWords("2026-09-23T11:30:00Z", now)).toBe("3 h ago");
    expect(agoWords("2026-09-22T12:00:00Z", now)).toBe("yesterday");
  });
});
