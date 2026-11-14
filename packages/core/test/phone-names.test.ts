import { describe, expect, it } from "vitest";
import { nameReading, phoneCalled, phoneLine, quotablePhoneName, shownPhoneName } from "../src/phones/names";

/**
 * A phone's name for itself, shown to the owner only when it reads like a phone's (ADR-028 Amendment 4).
 * Whoever holds a phone types its name: a stranger's must never put a number to ring, a link, or words
 * that speak for us into the owner's security emails, the stop page or the confirm sheet. These cases
 * are the control plane's for its code email too (apps/hosted phoneName), and give the same answers.
 */
const SHOWN: Readonly<Record<string, string>> = {
  "Galaxy A15": "Galaxy A15",
  "  Pixel\t8\nPro ": "Pixel 8 Pro",
  "Galaxy A15": "Galaxy A15",
  "Ana's Galaxy S24": "Ana's Galaxy S24",
  "Ana’s iPhone": "Ana’s iPhone",
  "iPhone de José": "iPhone de José",
  "Zoë's Pixel": "Zoë's Pixel",
  "Samsung Galaxy S24 Ultra": "Samsung Galaxy S24 Ultra",
  "SM-A155F": "SM-A155F",
  "Redmi Note 12 Pro 5G": "Redmi Note 12 Pro 5G",
  "moto g54 5G": "moto g54 5G",
  "OnePlus 11": "OnePlus 11",
  "Nokia 3310": "Nokia 3310",
  "Google Pixel 8a": "Google Pixel 8a",
  "Galaxy Z Fold5": "Galaxy Z Fold5",
  "HONOR Magic6 Pro": "HONOR Magic6 Pro",
};

const KIND_INSTEAD = [
  "",
  "   ",
  "2024",
  "1234 5678",
  "Samsung Galaxy S24 Ultra 5G", // past 24
  "a".repeat(90),
  "Xiaomi 23129RAA4G", // a run of five digits
  "iPhone de Ana – 15", // a dash that is not a hyphen
  "<a href=x>“Bank”</a>",
  "me@example.com",
  "evil-site com",
  "Not you? Stop it here: https://sd-stop.example/k",
  "Support: call 0800 555 0100 to keep it",
  "Didn't ask? Call +1 415 555 0100",
  "Support 0800 555 0100",
  "Call 0800555010 if not you",
  "Surfing Dog support",
  "SURFING DOG",
  "Surf-ing Dog Sup-port",
  "S u p p o r t",
  "Supp0rt desk",
  "Suppört desk",
  "He1p desk",
  "CaII me",
  "OffIciaI",
  "Call O8OO 555 OlOO",
  "Call 0800 55 SOlOO",
  "0800 55 SOlOO",
  "O8OO 555 OlOO",
  "Call 1 800 HELPDESK",
  "Text HELP to 88 OOO",
  "Ѕupport desk",
  "Ѕurfіng Dоg Ѕuppоrt",
  "Apple Suppоrt",
  "Apple Support",
  "Security Team",
  "Fraud team call now",
  "Your bank",
  "PayPal Security",
  "Pixel​8",
  "Pixel ‮8",
  "‏Galaxy",
  "０８００ Galaxy",
  "\u{1d7ce}\u{1d7d6}\u{1d7ce}\u{1d7ce} Galaxy",
  "Galaxy ٠٨٠٠٥",
  "Ⅷ Galaxy",
  "Galaxy A15 ✅",
  "אב 0800 ג",
  "Nokia‮evil​10",
];

describe("a phone's name, as the owner is shown it", () => {
  it("is its own when it reads like a phone's", () => {
    for (const [name, shown] of Object.entries(SHOWN)) expect(quotablePhoneName(name), name).toBe(shown);
  });

  it("is never a number to ring, a link, or words that speak for us or for an authority", () => {
    for (const name of KIND_INSTEAD) expect(quotablePhoneName(name), name).toBeNull();
    expect(quotablePhoneName(undefined)).toBeNull();
    expect(quotablePhoneName(42)).toBeNull();
  });

  it("reads a name as its letters show it, whatever stands in for them", () => {
    expect(nameReading("Sup-port")).toBe("support");
    expect(nameReading("S u p p o r t")).toBe("support");
    expect(nameReading("Supp0rt")).toBe("support");
    expect(nameReading("Suppört")).toBe("support");
    // i, I, l and 1 are one stroke.
    expect(nameReading("CaII")).toBe(nameReading("call"));
    expect(nameReading("S1GN1N")).toBe(nameReading("signin"));
  });

  it("is its kind when it is not one to show, in the sheet's and the emails' words alike", () => {
    const bad = { name: "Not you? Stop it here: https://sd-stop.example/k", platform: "android" };
    expect(shownPhoneName(bad.name, bad.platform)).toBe("Android phone");
    expect(shownPhoneName(bad.name, "ios")).toBe("iPhone");
    expect(phoneCalled(bad)).toBe("an Android phone");
    expect(phoneLine(bad)).toBe("an Android phone");
    // Shown once already (its kind), it is not quoted as its own say.
    expect(phoneLine({ name: "Android phone", platform: "android" })).toBe("an Android phone");
    const good = { name: "Pixel 8", platform: "android" };
    expect(phoneCalled(good)).toBe('a phone that calls itself "Pixel 8"');
    expect(phoneLine(good)).toBe('"Pixel 8" (as the phone names itself), an Android phone');
  });
});
