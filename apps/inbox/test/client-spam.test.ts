import { describe, expect, it } from "vitest";
import { countFor, countsFrom, paramsFor, parseFilter, showHeld } from "../client/src/lib/filters";
import {
  actsFor,
  basicMonth,
  byWords,
  CONNECT_MODEL,
  defaultModel,
  deskChip,
  filterMonth,
  followDone,
  HELD_TOP,
  heldOrder,
  heldWhat,
  heldWho,
  KEEP_BOTS,
  KEEP_CHOICES,
  keepLine,
  learningLine,
  MAY_BE_CUSTOMER,
  priceLine,
  quoteLine,
  readerLine,
  rowTag,
  SETTINGS_INTRO,
  showsModelUse,
  testFailed,
  testLine,
  timePassed,
  toastFor,
  turnOnSheet,
  UNDO_MS,
  warnSentence,
} from "../client/src/lib/spam";
import type { ItemSpamSummary, ItemView, SpamStatus } from "../client/src/lib/types";

/**
 * The owner app's spam filter screens (ADR-029 §11), their pure parts: the rail's Held, the rows and
 * chips, the order under Held, what each press says and offers, and Settings → Spam in every state.
 */

const sender = (address: string | null, company: string | null = null, app = false) => ({
  address,
  company_domain: company,
  app,
});

function view(o: {
  id?: string;
  type?: "booking" | "message" | "quote_request" | "order";
  state?: string;
  name?: string | null;
  email?: string | null;
  kind?: string;
  spam?: Partial<ItemSpamSummary> | null;
  transitions?: string[];
  start?: string;
}): ItemView {
  const type = o.type ?? "booking";
  const payload =
    type === "booking"
      ? {
          reservationFor: { serviceId: "s", name: "Haircut" },
          startTime: o.start ?? "2026-10-30T15:00:00Z",
          endTime: "2026-10-30T16:00:00Z",
        }
      : type === "message"
        ? { text: "Hello" }
        : type === "quote_request"
          ? { itemOffered: { name: "Wedding hair" }, description: "Price?" }
          : {
              orderedItem: [{ name: "Comb", quantity: 1, price: { value: 900, currency: "EUR" } }],
              totalPrice: { value: 900, currency: "EUR" },
            };
  return {
    item: {
      id: o.id ?? "i1",
      type,
      state: o.state ?? (type === "booking" ? "requested" : "open"),
      version: 3,
      partyId: "p",
      locationId: null,
      channel: "form",
      subject: null,
      flags: { needsHuman: false, sandbox: false, priority: 0 },
      linkedItemId: null,
      createdAt: "2026-10-26T09:00:00Z",
      updatedAt: "2026-10-26T09:00:00Z",
      closedAt: null,
      payload,
    } as never,
    transitions: (o.transitions ?? []).map((event) => ({ event, label: event })),
    human: "",
    party:
      o.name === undefined && o.email === undefined
        ? undefined
        : {
            id: "p",
            name: o.name ?? null,
            kind: o.kind ?? "person",
            verified: false,
            ...(o.email ? { email: o.email } : {}),
          },
    ...(o.spam === null
      ? {}
      : {
          spam: {
            screen: "held",
            chip: "Sales pitch",
            cause: "pitches",
            may_be_customer: false,
            certain: false,
            sender: sender(o.email ?? null),
            ...o.spam,
          },
        }),
  };
}

const page = (n: number, more = false) => ({
  items: Array.from({ length: n }, (_, i) => view({ id: `h${i}` })),
  next_cursor: more ? "c" : null,
});

describe("the rail", () => {
  it("shows Held only while something is held, with its count, and asks the API for it", () => {
    const empty = countsFrom(page(0), page(0), page(0));
    expect(showHeld(empty, "all")).toBe(false);
    expect(countFor(empty, "held")).toBe("");
    // Looking at it, it stays, even when it empties under the owner's eyes.
    expect(showHeld(empty, "held")).toBe(true);
    const two = countsFrom(page(0), page(0), page(2));
    expect(showHeld(two, "needs")).toBe(true);
    expect(countFor(two, "held")).toBe("2");
    expect(countFor(countsFrom(page(0), page(0), page(100, true)), "held")).toBe("100+");
    // Spam shouts nothing.
    expect(countFor(two, "spam")).toBe("");
    expect(parseFilter("held")).toBe("held");
    expect(paramsFor("held", undefined, false)).toMatchObject({ screen: "held", open_only: false });
    expect(paramsFor("spam", undefined, false)).toMatchObject({ state: "spam", open_only: false });
  });
});

describe("rows and chips", () => {
  it("lists what may be a customer first under Held, the rest as they came", () => {
    const rows = [
      view({ id: "a", spam: { may_be_customer: false } }),
      view({ id: "b", spam: { may_be_customer: true, chip: "Many new requests" } }),
      view({ id: "c", spam: { may_be_customer: false } }),
      view({ id: "d", spam: { may_be_customer: true } }),
    ];
    expect(heldOrder(rows).map((v) => v.item.id)).toEqual(["b", "d", "a", "c"]);
    expect(rowTag(rows[1]?.spam)).toBe(MAY_BE_CUSTOMER);
    expect(rowTag(rows[0]?.spam)).toBe("Sales pitch");
    expect(rowTag(view({ spam: { screen: "aside", may_be_customer: true, chip: "Junk" } }).spam)).toBe("Junk");
  });

  it("names a held row by the name given, else the email's domain", () => {
    expect(heldWho(view({ name: "Ngozi Adeyemi", email: "ngozi@example.org" }))).toBe("Ngozi Adeyemi");
    expect(heldWho(view({ name: null, email: "orders@bulk.example.com" }))).toBe("bulk.example.com");
    expect(heldWhat(view({}), "Asia/Tokyo", "en-GB")).toBe("Booking request for Sat 31 Oct, 00:00");
    expect(heldWhat(view({ type: "quote_request" }))).toBe("Quote request");
    expect(heldWhat(view({ type: "order" }))).toBe("Order");
  });

  it("says at the top of Held what waited, without saying nobody was told: the sender got their acknowledgement", () => {
    expect(HELD_TOP).toBe(
      "Held until the sender confirms or you let them in. You weren't alerted and nothing ran. Bookings here hold no time.",
    );
    expect(HELD_TOP).not.toMatch(/nobody was told/i);
  });

  it("puts a small chip before a labelled request's subject on the desk, and nothing on the rest", () => {
    expect(deskChip(view({ spam: { screen: "warned", chip: "May be a sales pitch" } }))).toBe("May be a sales pitch");
    expect(deskChip(view({ spam: { screen: "delivered", chip: "" } }))).toBe("");
    expect(deskChip(view({ spam: null }))).toBe("");
  });

  it("says why in our own words, the sender's only between quotes", () => {
    expect(warnSentence("pitches")).toBe("This may be a sales pitch. It came to you because the filter wasn't sure.");
    expect(warnSentence("scams")).toBe("This may be a scam. It came to you because the filter wasn't sure.");
    expect(warnSentence("junk")).toBe("This may be junk. It came to you because the filter wasn't sure.");
    expect(warnSentence("learning")).toBe("");
    expect(byWords("spam_filter")).toBe("by the spam filter");
    expect(byWords("ai_check")).toBe("by the AI check");
    expect(byWords("you")).toBe("by you");
    expect(byWords("mail_server")).toBe("by a mail server");
    expect(quoteLine("top 3   rankings\nin 30 days")).toBe("It says: “top 3 rankings in 30 days”");
  });
});

describe("one press, and Undo", () => {
  it("offers Let it in · Spam when held, Not spam when put aside, Looks fine · Spam when labelled", () => {
    expect(actsFor(view({ spam: { screen: "held" } }))).toEqual(["let_in", "spam"]);
    expect(actsFor(view({ type: "message", state: "spam", spam: { screen: "aside" } }))).toEqual(["not_spam"]);
    expect(actsFor(view({ type: "message", state: "spam", spam: null }))).toEqual(["not_spam"]);
    expect(
      actsFor(view({ type: "message", spam: { screen: "warned" }, transitions: ["answer", "mark_spam"] })),
    ).toEqual(["looks_fine", "spam"]);
    // A labelled booking has no Mark as spam of its own: Looks fine only.
    expect(actsFor(view({ spam: { screen: "warned" }, transitions: ["confirm"] }))).toEqual(["looks_fine"]);
    expect(actsFor(view({ spam: { screen: "delivered" } }))).toEqual([]);
    expect(UNDO_MS).toBe(6_000);
  });

  it("says what each press did, with its one follow-up", () => {
    const now = Date.parse("2026-10-26T10:00:00Z");
    const kemal = view({
      name: "Kemal Yıldız",
      email: "kemal@atolye.example",
      spam: { sender: sender("kemal@atolye.example", "atolye.example") },
    });
    expect(toastFor("let_in", kemal, now)).toEqual({ text: "Let in. Kemal Yıldız comes straight to you from now on." });
    // No name: the full address it lets through, never the whole domain.
    const nameless = view({
      email: "orders@bulk-supply.example",
      spam: { sender: sender("orders@bulk-supply.example", "bulk-supply.example") },
    });
    expect(toastFor("let_in", nameless, now)).toEqual({
      text: "Let in. Messages from orders@bulk-supply.example come straight to you from now on.",
    });
    const late = view({ name: "Kemal Yıldız", start: "2026-10-26T08:00:00Z" });
    expect(timePassed(late, now)).toBe(true);
    expect(toastFor("let_in", late, now)).toEqual({
      text: "Let in. The time asked for has passed: suggest another.",
      follow: { kind: "suggest_time", label: "Suggest another time" },
    });
    expect(toastFor("not_spam", kemal, now)).toEqual({
      text: "Back in your inbox. Messages from kemal@atolye.example won't be put aside again.",
      follow: { kind: "let_domain", label: "Let everyone at atolye.example through" },
    });
    // A provider many share is never offered as a company's domain (the server leaves it out).
    const shared = view({ email: "kemal@gmail.com", spam: { sender: sender("kemal@gmail.com", null) } });
    expect(toastFor("looks_fine", shared, now).follow).toBeUndefined();
    expect(toastFor("spam", kemal, now)).toEqual({
      text: "Put aside.",
      follow: { kind: "block", label: "Always put aside messages from kemal@atolye.example" },
    });
    const app = view({ name: null, kind: "agent", spam: { sender: sender(null, null, true) } });
    expect(toastFor("spam", app, now).follow?.label).toBe("Always put aside messages from this app");
    expect(followDone("block", kemal)).toBe("Messages from kemal@atolye.example will always be put aside.");
    expect(followDone("let_domain", kemal)).toBe("Everyone at atolye.example comes straight in now.");
  });
});

function status(o: Partial<SpamStatus> & { reader?: SpamStatus["reader"] } = {}): SpamStatus {
  return {
    basic: { learning_until: null },
    filters: [
      {
        filter: "pitches",
        on: true,
        choice: "aside",
        learning_until: null,
        allowed: true,
        this_month: { aside: 12, brought_back: 1 },
      },
      {
        filter: "scams",
        on: false,
        choice: "aside",
        learning_until: null,
        allowed: true,
        this_month: { aside: 0, brought_back: 0 },
      },
      {
        filter: "junk",
        on: false,
        choice: "label",
        learning_until: null,
        allowed: true,
        this_month: { aside: 0, brought_back: 0 },
      },
    ],
    reader: "no_model",
    model: null,
    reader_name: null,
    checks: {
      today: 3,
      this_month: 41,
      day_cap: null,
      month_cap: 2000,
      resting_until: null,
      tokens_this_month: 20_000,
    },
    billing: { state: "self_hosted", price: null },
    this_month: { aside: 20, held: 4, brought_back: 2 },
    held_now: 1,
    this_week: { aside: 6 },
    lists: { allow: [], block: [] },
    can_change: true,
    ...o,
  } as SpamStatus;
}

describe("Settings → Spam, in every state", () => {
  it("says who reads: hosted with our AI, hosted on phrases, own model, no model, resting", () => {
    expect(readerLine(status({ reader: "hosted_ai" }))).toBe(
      "Read by an AI service we pay for, only for new senders, with email addresses, phone numbers and bank details taken out. It keeps nothing.",
    );
    expect(readerLine(status({ reader: "hosted_ai", reader_name: "Example Models Co" }))).toContain(
      "Read by Example Models Co, an AI service we pay for",
    );
    expect(readerLine(status({ reader: "hosted_phrases" }))).toBe(
      "For now the filters look for known phrases only. Reading by AI comes later, and you'll be told first.",
    );
    expect(
      readerLine(
        status({
          reader: "own_model",
          model: { provider: "Google Gemini", model: "a small model", set_by_server: false },
        }),
      ),
    ).toBe("Read by a small model from Google Gemini, set up for this inbox.");
    // Without a model, the line says so once, and the page puts the one link to connect one after it.
    expect(readerLine(status())).toBe("Without an AI model, the filters look for known phrases only.");
    expect(CONNECT_MODEL).toBe("Connect one in Settings → Integrations");
    const resting = status({
      reader: "hosted_ai",
      checks: {
        today: 150,
        this_month: 600,
        day_cap: 150,
        month_cap: 1500,
        resting_until: "2026-10-27T00:00:00Z",
        tokens_this_month: 0,
      },
    });
    expect(readerLine(resting, "UTC", "en-GB")).toBe(
      "The AI check is resting until Tue 27 Oct: more new messages than usual. Until then the filters look for known phrases only.",
    );
  });

  it("says what it costs: free while hosted is free, the price once billing is on, model time on one's own server", () => {
    expect(priceLine(status({ billing: { state: "off", price: null } }))).toBe(
      "Free while hosted inboxes are free. If that changes, you'll be told 30 days ahead and asked first.",
    );
    expect(priceLine(status({ billing: { state: "shadow", price: null } }))).toContain(
      "Free while hosted inboxes are free",
    );
    expect(
      priceLine(status({ billing: { state: "on", price: { currency: "eur", per_filter_month_minor: 100 } } })),
    ).toBe("€1.00 a month for each filter that's on, counted by the day.");
    expect(priceLine(status())).toBe("41 checked by your model this month · 15,000 words of model time.");
  });

  it("speaks of the model's checks, its cap and its charges only where one's own server has a model", () => {
    // No model: nothing is checked, capped or charged, so none of those lines shows.
    expect(showsModelUse(status())).toBe(false);
    expect(
      showsModelUse(status({ reader: "own_model", model: { provider: "OpenAI", model: "m", set_by_server: true } })),
    ).toBe(true);
    expect(showsModelUse(status({ reader: "hosted_ai", billing: { state: "off", price: null } }))).toBe(false);
  });

  it("starts the model chooser on a small model, or on none: the owner pays for each check", () => {
    expect(defaultModel([{ id: "large-2" }, { id: "large-2-mini" }, { id: "large-1-flash" }])).toBe("large-2-mini");
    expect(defaultModel([{ id: "large-2" }, { id: "large-1" }])).toBe("");
    expect(defaultModel([])).toBe("");
  });

  it("asks before switching a filter on, on a hosted inbox, and never asks for money while it is free", () => {
    const sheet = turnOnSheet("pitches", status({ reader: "hosted_phrases", billing: { state: "off", price: null } }));
    expect(sheet.title).toBe("Turn on Sales pitches?");
    expect(sheet.text).toBe(
      "It reads new messages from people you haven't dealt with before. For now the filters look for known phrases only. Reading by AI comes later, and you'll be told first. Free while hosted inboxes are free; we'll ask before charging anything.",
    );
  });

  it("counts the month, the learning week, and how long what is put aside is kept", () => {
    expect(basicMonth(status())).toBe("This month: 20 put aside · 4 held · 2 brought back");
    expect(filterMonth(status().filters[0] as SpamStatus["filters"][number])).toBe(
      "This month: 12 put aside · 1 brought back",
    );
    expect(learningLine("2026-11-02T09:00:00Z", "UTC", "en-GB")).toBe(
      "Learning until Mon 2 Nov: it labels what it would put aside, and puts nothing aside yet.",
    );
    // There is no "clear" to press: the default keeps them, and the time is chosen in Settings.
    expect(keepLine(0)).toBe("Put-aside messages are kept until you choose a time in Settings → Spam.");
    expect(keepLine(90)).toBe("Put-aside messages are kept 90 days.");
    expect(KEEP_CHOICES.map((c) => c.label)).toEqual(["Keep them", "90 days", "30 days"]);
    // What goes whatever the choice is said where the choice is made, and the intro promises no less.
    expect(KEEP_BOTS).toBe("A bot's form messages go after seven days.");
    expect(SETTINGS_INTRO).not.toMatch(/nothing is deleted/i);
  });

  it("says what the model's Test found, or why it could not", () => {
    expect(testLine({ pitch: true, customer: true })).toBe(
      "Checked two samples: a sales pitch was spotted; a customer asking a price in Japanese came through.",
    );
    expect(testLine({ pitch: false, customer: false })).toBe(
      "Checked two samples: the sales pitch wasn't spotted; a customer asking a price in Japanese wasn't let through.",
    );
    expect(testFailed("auth")).toBe("The provider didn't accept the key. Paste it again.");
    expect(testFailed("timeout")).toContain("took too long");
  });
});
