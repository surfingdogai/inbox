import { describe, expect, it } from "vitest";
import {
  choiceForLink,
  elsewhereDoc,
  elsewhereLine,
  linkProblem,
  ownDomains,
  pickedPlatformNote,
  placeOf,
  platformChoices,
  prefillFor,
  prefillFrom,
  shortLink,
  stillHereWords,
} from "../client/src/lib/doors";

/**
 * The owner app's "Booked or ordered elsewhere" (ADR-031), as Settings → General shows it: the chooser for each kind,
 * the link it starts from, what it says of a link before saving, and the settings write it makes. The same rules as
 * the server's, from the spec's own module. Fixtures in each platform's public page format; nothing is fetched.
 */
const FRESHA = "https://www.fresha.com/a/studio-lumiere-toronto-queen-street-west-k3f8q2";
const CLOUDBEDS = "https://hotels.cloudbeds.com/reservation/Xk29Qa";

describe("the chooser", () => {
  it("offers, for each kind, only the platforms that take it, the likeliest groups first", () => {
    const booking = platformChoices("booking");
    const order = platformChoices("order");
    expect(booking[0]?.group.id).toBe("beauty");
    expect(booking.flatMap((g) => g.platforms.map((p) => p.id))).toContain("tablecheck");
    expect(booking.flatMap((g) => g.platforms.map((p) => p.id))).not.toContain("toast");
    expect(order.map((g) => g.group.id).slice(0, 2)).toEqual(["ordering", "shops"]);
    expect(order.flatMap((g) => g.platforms.map((p) => p.id))).not.toContain("fresha");
    // Wix takes both.
    for (const list of [booking, order]) expect(list.flatMap((g) => g.platforms.map((p) => p.id))).toContain("wix");
    // A group with nothing for the kind is not shown.
    expect(order.some((g) => g.platforms.length === 0)).toBe(false);
  });
});

describe("the link it starts from", () => {
  const detected = [
    { type: "mcp", url: "https://mkatematamu.co.ke/mcp" },
    { type: "platform:cloudbeds", url: `${CLOUDBEDS}?utm_source=google` },
  ];

  it("is the one saved, else a page a network found on that platform, else the business's own website", () => {
    const current = { itemType: "booking" as const, url: FRESHA, platform: "fresha" };
    expect(prefillFor("fresha", "booking", { current, detected })).toBe(FRESHA);
    // A network's door, tracking taken off.
    expect(prefillFor("cloudbeds", "booking", { current, detected })).toBe(CLOUDBEDS);
    // Found by its address, whatever type the network gave it.
    expect(
      prefillFor("booksy", "booking", { detected: [{ type: "other", url: "https://booksy.com/en-us/4821_ritmo" }] }),
    ).toBe("https://booksy.com/en-us/4821_ritmo");
    expect(prefillFor("shopify", "order", { detected, domain: "www.mkatematamu.co.ke" })).toBe(
      "https://mkatematamu.co.ke/",
    );
    expect(prefillFor("opentable", "booking", { detected, domain: "mkatematamu.co.ke" })).toBe("");
    // Another page starts from a saved link that is on no platform of the list.
    const own = { itemType: "order" as const, url: "https://shop.mkatematamu.co.ke/" };
    expect(prefillFor("", "order", { current: own })).toBe("https://shop.mkatematamu.co.ke/");
    // Where it came from: a page a network found on a marketplace asks for the platform's direct link.
    expect(prefillFrom("cloudbeds", "booking", { detected }).from).toBe("found");
    expect(prefillFrom("shopify", "order", { domain: "Mkatematamu.co.ke." })).toEqual({
      url: "https://mkatematamu.co.ke/",
      from: "website",
    });
    expect(prefillFrom("fresha", "booking", {}).from).toBe("none");
    expect(ownDomains("WWW.Kissahoshi.jp", "https://kissahoshi.jp/", null)).toEqual(["kissahoshi.jp"]);
  });
});

describe("what it says of a link", () => {
  it("in the owner's words, before saving", () => {
    expect(linkProblem("", "fresha", "booking")).toBe("Paste the link.");
    expect(linkProblem("fresha.com/a/x", "fresha", "booking")).toBe("Paste the whole link, starting with https://");
    expect(linkProblem("http://www.fresha.com/a/x", "fresha", "booking")).toBe("The link must start with https://");
    expect(linkProblem("https://studiolumiere.ca/book", "fresha", "booking")).toBe(
      "That link isn't on Fresha. If it's yours, choose Another page.",
    );
    expect(linkProblem("https://www.fresha.com/for-business", "fresha", "booking")).toBe(
      "That's Fresha's own page. Paste the link to yours.",
    );
    expect(linkProblem("https://www.fresha.com/", "fresha", "booking")).toBe(
      "That's Fresha's own page. Paste the link to yours.",
    );
    expect(linkProblem(FRESHA, "fresha", "booking")).toBeNull();
    expect(linkProblem("https://studiolumiere.ca/book", "", "booking")).toBeNull();
    expect(linkProblem("https://203.0.113.9/book", "", "booking")).toBe("That doesn't look like a web page's link.");
    expect(linkProblem("https://another.example.com/", "shopify", "order", "mkatematamu.co.ke")).toBe(
      "That link isn't on your website (mkatematamu.co.ke) or on Shopify.",
    );
    expect(linkProblem("https://forms.example.org/", "tradify", "booking", "plumbing.co.za")).toBe(
      "That link isn't on your website (plumbing.co.za).",
    );
    expect(linkProblem("https://shop.mkatematamu.co.ke/", "shopify", "order", "mkatematamu.co.ke")).toBeNull();
    // The domain as the server compares it: capitals, www and a trailing dot are the same domain.
    expect(linkProblem("https://shop.mkatematamu.co.ke/", "shopify", "order", "WWW.Mkatematamu.co.ke.")).toBeNull();
    expect(
      linkProblem("https://shop.mkatematamu.co.ke/", "shopify", "order", ["", "https://mkatematamu.co.ke/"]),
    ).toBeNull();
    // No website yet: a shop there waits for one; its own name on Shopify does not.
    expect(linkProblem("https://shop.mkatematamu.co.ke/", "shopify", "order", null)).toBe(
      "Add your website in General first, so agents know this shop is yours.",
    );
    expect(linkProblem("https://lotus-spa.in/book", "simplybook", "booking", [])).toBe(
      "Add your website in General first, so agents know this page is yours.",
    );
    expect(linkProblem("https://mkate-matamu.myshopify.com/", "shopify", "order", null)).toBeNull();
  });
});

describe("where a pasted link puts the chooser", () => {
  it("on the listed platform it is plainly on, else Another page, said once", () => {
    expect(choiceForLink(FRESHA, "", "booking", "other")).toEqual({ choice: "fresha", moved: false });
    expect(choiceForLink(FRESHA, "other", "booking", "other")).toEqual({ choice: "fresha", moved: false });
    // A TableCheck link with OpenTable picked picks TableCheck.
    const tc = "https://www.tablecheck.com/ja/shops/kissa-hoshi-osaka/reserve";
    expect(choiceForLink(tc, "opentable", "booking", "other")).toEqual({ choice: "tablecheck", moved: false });
    // On no listed platform: Another page, for nothing picked and for a platform it is not on.
    expect(choiceForLink("https://kissahoshi.jp/yoyaku", "", "booking", "other")).toEqual({
      choice: "other",
      moved: true,
    });
    expect(choiceForLink("https://kissahoshi.jp/yoyaku", "treatwell", "booking", "other")).toEqual({
      choice: "other",
      moved: true,
    });
    // A shop on the business's own website stays where the owner picked it.
    expect(choiceForLink("https://kissahoshi.jp/shop", "shopify", "order", "other")).toEqual({
      choice: "shopify",
      moved: false,
    });
    // One of the platform's own pages picks the platform, which then says it isn't the owner's page.
    expect(choiceForLink("https://www.fresha.com/for-business", "", "booking", "other")).toEqual({
      choice: "fresha",
      moved: false,
    });
    // Not a link yet: nothing moves.
    expect(choiceForLink("kissahoshi", "", "booking", "other")).toEqual({ choice: "", moved: false });
  });
});

describe("what the editor says still comes here", () => {
  it("only the doors that are open", () => {
    expect(stillHereWords({ message: true, quoteRequest: true })).toBe("Messages and price requests still come here.");
    expect(stillHereWords({ message: true, quoteRequest: false })).toBe("Messages still come here.");
    expect(stillHereWords({ message: false, quoteRequest: true })).toBe("Price requests still come here.");
    expect(stillHereWords({ message: false, quoteRequest: false })).toBe("");
  });
});

describe("the settings write", () => {
  it("sets one kind, keeps the other, takes tracking off, and brings a kind back with null", () => {
    const now = [
      { itemType: "order" as const, url: "https://order.toasttab.com/online/casa-di-nonna-sp", platform: "toast" },
    ];
    expect(elsewhereDoc(now, "booking", { url: ` ${FRESHA}?fbclid=IwAR0x `, platform: "fresha" })).toEqual({
      doorsElsewhere: [{ itemType: "booking", url: FRESHA, platform: "fresha" }, ...now],
    });
    expect(elsewhereDoc(now, "order", { url: "https://casadinonna.com.br/pedido" })).toEqual({
      doorsElsewhere: [{ itemType: "order", url: "https://casadinonna.com.br/pedido" }],
    });
    expect(elsewhereDoc(now, "order", null)).toEqual({ doorsElsewhere: null });
  });

  it("names each door as agents read it", () => {
    expect(placeOf({ itemType: "booking", url: FRESHA })).toBe("Fresha");
    expect(elsewhereLine({ itemType: "booking", url: CLOUDBEDS, platform: "cloudbeds" })).toBe("Bookings at Cloudbeds");
    expect(elsewhereLine({ itemType: "order", url: "https://shop.mkatematamu.co.ke/", platform: "shopify" })).toBe(
      "Orders at shop.mkatematamu.co.ke",
    );
    // The owner's own line keeps the platform they picked when agents name the shop by its address.
    expect(pickedPlatformNote({ itemType: "order", url: "https://kissahoshi.jp/shop", platform: "shopify" })).toBe(
      "Shopify",
    );
    expect(pickedPlatformNote({ itemType: "booking", url: FRESHA, platform: "fresha" })).toBeNull();
    expect(pickedPlatformNote({ itemType: "order", url: "https://kissahoshi.jp/shop" })).toBeNull();
    expect(shortLink(FRESHA)).toBe("fresha.com/a/studio-lumiere-toronto-queen-street-west-k3f8q2");
    expect(shortLink("https://shop.mkatematamu.co.ke/")).toBe("shop.mkatematamu.co.ke");
  });
});
