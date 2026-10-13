import { DEFAULT_SETTINGS, mergeSettings, type NetworkView, parseStoredSettings } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  agoWords,
  doorPanel,
  emailWords,
  networkStatus,
  parseNetworkOrigin,
  receiptWords,
  rulesWords,
  standingWords,
} from "../client/src/lib/networks";
import { hostsOf, toSettingsDoc, toSettingsForm } from "../client/src/lib/settings";

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
    expect(Object.keys(doc).sort()).toEqual([
      "booking",
      "commerce",
      "customers",
      "email",
      "identity",
      "negotiation",
      "notifications",
      "orders",
      "returns",
      "testMode",
    ]);
    const after = parseStoredSettings(mergeSettings(stored, doc)).settings;
    expect(after.networks["https://network.surfingdog.ai"]?.enabled).toBe(true);
    expect(after.integrations.webhooks.timeoutMs).toBe(5_000);
    expect(after.notifications.ownerEmail).toBe("hello@example.com");
    expect(after.testMode).toBe(true);
    // Nothing the owner did not choose is written: no defaults for sections this form does not show.
    expect(mergeSettings(stored, doc)).not.toHaveProperty("business");
  });

  it("sends the return policy and who the business is, as the owner typed them", () => {
    const loaded = parseStoredSettings({}).settings;
    const form = toSettingsForm(loaded);
    expect(form).toMatchObject({
      returnDays: "14",
      returnPostage: "customer",
      sellsTo: "both",
      aiApprovesReturns: true,
    });
    const doc = toSettingsDoc({
      ...form,
      returnDays: "30",
      returnPostage: "business",
      legalName: " Oficina Maré Lda ",
      legalCountry: "pt",
      vatId: "PT500000000",
      aiApprovesReturns: false,
    });
    expect(doc.returns).toEqual({ days: 30, postage: "business", refundDays: 14, respondHours: 48 });
    expect(doc.commerce).toEqual({
      customers: "both",
      legal: {
        legalName: "Oficina Maré Lda",
        address: "",
        country: "PT",
        email: "",
        phone: "",
        vatId: "PT500000000",
        complaintsUrl: "",
      },
    });
    const after = parseStoredSettings(mergeSettings({}, doc)).settings;
    expect(after.negotiation.ai.mayAuthorizeReturnsInPolicy).toBe(false);
    expect(after.commerce.legal.country).toBe("PT");
  });

  it("sends the limits for the owner's AI as the settings hold them: hours as minutes, an amount in cents", () => {
    const form = toSettingsForm(parseStoredSettings({}).settings);
    expect(form).toMatchObject({
      priceCounters: false,
      aiDiscountPct: "0",
      aiPricesCustom: false,
      aiTimeShiftHours: "168",
      aiDelayDays: "0",
      aiRefundMax: "",
    });
    const doc = toSettingsDoc({
      ...form,
      priceCounters: true,
      aiDiscountPct: "10",
      aiTimeShiftHours: "48",
      aiRefundMax: "25,50",
    });
    expect(doc.negotiation).toMatchObject({
      priceCounters: true,
      ai: { maxDiscountPct: 10, mayPriceCustom: false, maxTimeShiftMin: 2_880, maxDelayDays: 0, maxRefundMinor: 2_550 },
    });
    const after = parseStoredSettings(mergeSettings({}, doc)).settings;
    expect(after.negotiation.ai.maxTimeShiftMin).toBe(2_880);
    expect(toSettingsForm(after)).toMatchObject({ aiTimeShiftHours: "48", aiRefundMax: "25.50" });
    // Not a number: sent as typed, so the API names the field.
    expect((toSettingsDoc({ ...form, aiRefundMax: "lots" }).negotiation as { ai: object }).ai).toMatchObject({
      maxRefundMinor: "lots",
    });
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

  it("shows and sends the one-time code limits and the other hosts, each with its own path", () => {
    const loaded = parseStoredSettings({
      customers: { otp: { ttlMinutes: 15 } },
      identity: { extraAuthorities: ["old.example.com"] },
    }).settings;
    const form = toSettingsForm(loaded);
    expect(form).toMatchObject({
      codeMinutes: "15",
      codeAttempts: "5",
      codesPerHour: "3",
      codesPerDay: "5",
      triesPerDay: "10",
      emailKey: true,
      extraHosts: "old.example.com",
    });
    const doc = toSettingsDoc({
      ...form,
      codeAttempts: "7",
      triesPerDay: "12",
      emailKey: false,
      extraHosts: " https://Old.Example.com/,  shop.example.pt:8443 ",
    });
    expect(doc.customers).toEqual({
      otp: { ttlMinutes: 15, attempts: 7, sendsPerHour: 3, sendsPerDay: 5, guessesPerDay: 12 },
      emailKey: false,
    });
    expect(doc.identity).toEqual({ extraAuthorities: ["old.example.com", "shop.example.pt:8443"] });
    const after = parseStoredSettings(
      mergeSettings({ identity: { extraAuthorities: ["a.example.com"] } }, doc),
    ).settings;
    expect(after.identity.extraAuthorities).toEqual(["old.example.com", "shop.example.pt:8443"]);
    expect(after.customers).toEqual({
      otp: { ttlMinutes: 15, attempts: 7, sendsPerHour: 3, sendsPerDay: 5, guessesPerDay: 12 },
      emailKey: false,
    });
    // Emptied, the list is emptied: an array is replaced whole.
    expect(toSettingsDoc({ ...form, extraHosts: " " }).identity).toEqual({ extraAuthorities: [] });
    expect(hostsOf("a.example.com b.example.com,c.example.com")).toEqual([
      "a.example.com",
      "b.example.com",
      "c.example.com",
    ]);
  });

  it("sends a number field that holds no number as typed, so the API names it", () => {
    const doc = toSettingsDoc({ ...toSettingsForm(DEFAULT_SETTINGS), autoExpireHours: "", approvalLimit: "12,50" });
    expect(doc.booking).toMatchObject({ autoExpireHours: "", cancellationWindowMin: 1440 });
    expect(doc.orders).toEqual({ maxValueWithoutApprovalMinor: 1250, payDays: 14, dueDays: 30 });
  });
});

describe("Settings → Networks", () => {
  const base: NetworkView = {
    origin: "https://network.example.com",
    enabled: true,
    issue: true,
    share: { listing: true, counts: true, receipts: true },
    registration: "registered",
    receives_emails: true,
    registered_at: null,
    last_ping_at: null,
    last_error: null,
    last_error_at: null,
    failing_since: null,
    rules: { version: null, next: null, next_at: null, v2: false, v6: false, checked_at: null },
    level: "full",
    standing: null,
    ping_signature: null,
    doors: null,
    receipts: { published: 0, queued: 0, refused: 0, held: 0, withheld: 0 },
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

  it("says which rules a network applies and what that means it gets", () => {
    const rules = (version: number | null, next: number | null, v2: boolean) => ({
      version,
      next,
      next_at: next ? "2026-10-09T00:00:00.000Z" : null,
      v2,
      v6: Math.max(version ?? 0, next ?? 0) >= 6,
      checked_at: null,
    });
    expect(rulesWords(rules(null, null, false))).toBeNull();
    expect(rulesWords(rules(2, null, false))).toBe(
      "Rules version 2: it gets confirmations and payments, not yet how they ended.",
    );
    expect(rulesWords(rules(2, 3, true), "en-GB")).toBe(
      "Rules version 2, version 3 from 9 Oct: it already gets how each booking and order ended.",
    );
    expect(rulesWords(rules(3, null, true))).toBe("Rules version 3: it gets how each booking and order ended.");
    // Rules version 6 announced: agreed changes and refunds already go; a promise that moved waits.
    expect(rulesWords(rules(5, 6, true), "en-GB")).toBe(
      "Rules version 5, version 6 from 9 Oct: it gets how each booking and order ended, and already takes the changes agreed to them and refunds. A booking or order that changed goes to it once version 6 is in force.",
    );
    // Rules version 5 with nothing announced: what it gets is what it got before agreed changes and refunds.
    expect(rulesWords(rules(5, null, true))).toBe("Rules version 5: it gets how each booking and order ended.");
    expect(rulesWords(rules(6, null, true))).toBe(
      "Rules version 6: it gets how each booking and order ended, the changes agreed to them, and refunds.",
    );
  });

  it("says how agents got on at the doors, each count with what proved it, and the network's own check apart", () => {
    expect(doorPanel(base, now)).toBeNull();
    const doors: NonNullable<NetworkView["doors"]> = {
      at: "2026-09-23T14:27:00Z",
      as_of: "2026-09-22",
      doors: [
        {
          type: "mcp",
          url: "https://demo.example.com/mcp",
          status: "live",
          checked: { result: "good", at: "2026-09-23T09:00:00Z" },
          not_reproduced: 2,
          reports: [
            { op: "book", tool: "create_booking", proof: "none", result: "ok", d7: 12, d30: 40 },
            {
              op: "book",
              tool: "create_booking",
              proof: "none",
              result: "refused",
              class: "slot_taken",
              d7: 2,
              d30: 5,
            },
            { op: "book", proof: "none", result: "fail", class: "tcp.timed_out", d7: 0, d30: 2 },
            {
              op: "book",
              tool: "create_booking",
              proof: "none",
              result: "invalid",
              class: "client.invalid_params",
              d7: 3,
              d30: 14,
            },
          ],
          platforms: ["https://agents.example.net"],
        },
        {
          type: "inbox",
          url: "https://demo.example.com/.well-known/agent-inbox.json",
          status: "live",
          checked: { result: "blocked", at: "2026-09-22T09:00:00Z" },
          reports: [],
          platforms: [],
        },
      ],
      incidents: [
        {
          id: "inc_1",
          type: "mcp",
          url: "https://demo.example.com/mcp",
          class: "protocol.version",
          opened_at: "2026-09-22T10:00:00Z",
          reproduced: false,
          public_from: "2026-09-29",
        },
      ],
      trouble: [
        { type: "inbox", url: "https://demo.example.com/.well-known/agent-inbox.json", since: "2026-09-23T08:00:00Z" },
      ],
      fixes: [{ class: "protocol.version", text: "Your MCP server refuses the protocol version it advertises." }],
    };
    const panel = doorPanel({ ...base, doors }, now, "en-GB");
    expect(panel?.said).toBe("Counts to 22 Sept. Said 3 min ago.");
    // The time is the browser's own; the day the counts run to is UTC's.
    expect(panel?.doors[0]?.check).toEqual({
      line: expect.stringMatching(/^It answered the network's check, \d\d:\d\d\.$/),
      tone: "success",
    });
    expect(panel?.doors[0]).toMatchObject({
      title: "MCP door · demo.example.com/mcp",
      lines: [
        "Agents the network cannot tell apart: 12 done, 2 refused, 3 the agents' own mistakes in the last 7 days; 40 done, 5 refused, 2 failed, 14 the agents' own mistakes in 30.",
        "What failed in the last 30 days: 2 connection timed out.",
        "Agents sent create_booking arguments it cannot take 14 times in 30 days.",
        "Agents from agents.example.net used it.",
        "Agents reported it down; the network checked it 2 times for that in 7 days and found it answering.",
      ],
    });
    expect(panel?.doors[1]?.check.tone).toBe("warning");
    expect(panel?.doors[1]?.check.line).toMatch(/blocked.*never a failure/);
    expect(panel?.doors[1]?.lines).toEqual(["No agent has reported on it in the last 30 days."]);
    expect(panel?.alerts.map((a) => a.tone)).toEqual(["danger", "warning"]);
    expect(panel?.alerts[0]?.line).toContain("If it still holds on 29 Sept, it shows on your listing.");
    // Public from the day it opened, as the network's own reads are: shown already, not a condition.
    const shown = doorPanel(
      { ...base, doors: { ...doors, incidents: [{ ...doors.incidents[0], public_from: "2026-09-22" }] } as never },
      now,
      "en-GB",
    );
    expect(shown?.alerts[0]?.line).toContain("It shows on your listing as failing.");
    expect(shown?.alerts[0]?.line).not.toContain("If it still holds");
    // None: the network shows nothing of it yet.
    const unshown = doorPanel(
      { ...base, doors: { ...doors, incidents: [{ ...doors.incidents[0], public_from: null }] } as never },
      now,
      "en-GB",
    );
    expect(unshown?.alerts[0]?.line).not.toMatch(/listing/);
    expect(panel?.alerts[1]?.line).toContain("that the network's own check does not see");
    expect(panel?.fixes).toEqual(["Your MCP server refuses the protocol version it advertises."]);
    // Nothing in it names an agent's key, a person or an address.
    expect(JSON.stringify(panel)).not.toMatch(/@|sdpass|sdkey/);
    expect(doorPanel({ ...base, enabled: false, doors }, now)).toBeNull();
  });

  it("says your own standing at a network, and why it is not shown when it is not", () => {
    const at = "2026-09-23T14:27:00Z";
    const v2 = { version: 2, next: 3, next_at: "2026-10-09T00:00:00.000Z", v2: true, v6: false, checked_at: null };
    expect(standingWords({ ...base, enabled: false, ping_signature: "verified" }, now)).toBeNull();
    expect(standingWords(base, now)).toBeNull();
    expect(
      standingWords({ ...base, rules: v2, standing: { tier: "new", score: 0, ranked: false, at } }, now, "en-GB"),
    ).toEqual({
      line: "New: no score yet. Scores start with rules version 3, on 9 Oct. Said 3 min ago.",
      tone: "neutral",
    });
    expect(
      standingWords(
        { ...base, rules: { ...v2, version: 3, next: null }, standing: { tier: "new", score: 0, ranked: false, at } },
        now,
      )?.line,
    ).toBe("New: no score yet. Kept bookings and orders build it. Said 3 min ago.");
    expect(standingWords({ ...base, standing: { tier: "trusted", score: 0.8234, ranked: true, at } }, now)).toEqual({
      line: "Trusted: score 0.82, sorted before the newcomers. Said 3 min ago.",
      tone: "success",
    });
    expect(standingWords({ ...base, standing: { tier: "new", score: 0.31, ranked: false, at } }, now)?.line).toBe(
      "New: score 0.31, shuffled with the newcomers until it reaches 0.40. Said 3 min ago.",
    );
    expect(standingWords({ ...base, ping_signature: "unsigned" }, now)?.line).toBe(
      "Your standing shows here once your inbox can sign its ping: it needs INBOX_SECRET_KEY.",
    );
    expect(standingWords({ ...base, ping_signature: "ignored" }, now)?.line).toBe(
      "This network does not tell an inbox its standing.",
    );
    expect(standingWords({ ...base, ping_signature: "invalid: unknown_instance" }, now)).toEqual({
      line: "The network could not check your inbox's signature (unknown instance); it took the ping unsigned.",
      tone: "warning",
    });
  });

  it("counts receipts in plain words", () => {
    expect(receiptWords({ published: 1, queued: 0, refused: 0, held: 0, withheld: 0 })).toEqual([
      "1 receipt published",
    ]);
    expect(receiptWords({ published: 12, queued: 3, refused: 1, held: 0, withheld: 0 })).toEqual([
      "12 receipts published",
      "3 waiting",
      "1 refused",
    ]);
    expect(receiptWords({ published: 12, queued: 5, refused: 0, held: 2, withheld: 0 })).toEqual([
      "12 receipts published",
      "3 waiting",
      "2 held until the network reads them",
    ]);
    expect(agoWords("2026-09-23T14:29:30Z", now)).toBe("just now");
    expect(agoWords("2026-09-23T11:30:00Z", now)).toBe("3 h ago");
    expect(agoWords("2026-09-22T12:00:00Z", now)).toBe("yesterday");
  });
});

describe("the minimum notice and a network's addresses in Settings", () => {
  it("shows the minimum notice and sends it back as a number, with the rest of the booking settings", () => {
    const form = toSettingsForm(DEFAULT_SETTINGS);
    expect(form.minNoticeMin).toBe("60");
    expect(toSettingsDoc({ ...form, minNoticeMin: "120" }).booking).toMatchObject({ minNoticeMin: 120 });
  });

  it("says a network gets customers' addresses only once it has verified the inbox", () => {
    expect(emailWords({ receives_emails: false, registration: "pending" })).toBe(
      "Customers' email addresses go to this network only once it has verified your inbox. Verified: not yet.",
    );
    expect(emailWords({ receives_emails: true, registration: "registered" })).toMatch(/Verified: yes\.$/);
    // The default network always could, so there is nothing to say.
    expect(emailWords({ receives_emails: true, registration: "unregistered" })).toBeNull();
  });
});
