import { describe, expect, it } from "vitest";
import {
  appLinkUri,
  itemUri,
  pairingUri,
  readItemLink,
  readPhoneLink,
  signInLinkUri,
} from "../../../packages/core/src/phones/links";
import { qrMatrix } from "../../inbox/client/src/lib/phones";
import { readFrame } from "../src/lib/scan";

/**
 * What the phone reads (ADR-026): the QR code the owner app draws, read back by the phone's own
 * scanner; the links an email or a notification hands the app; and nothing that is not ours.
 */
const SECRET = "sdi_pp_7Qm3kXc9vA2bN5rT8yZ1wE4uI6oP0sD3fG7hJ9kL2mN";
const ORIGIN = "https://inbox.atelierlumen.com";

/** The owner app's QR code as a camera frame: RGBA, four pixels a module, dark on white. */
function frameOf(text: string, scale = 4): { data: Uint8ClampedArray; size: number } {
  const m = qrMatrix(text);
  const size = m.length * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dark = m[Math.floor(y / scale)]?.[Math.floor(x / scale)] ?? false;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = dark ? 20 : 255;
      data[i + 3] = 255;
    }
  return { data, size };
}

describe("the QR code, end to end", () => {
  it("is read by the phone's scanner as the owner app drew it", () => {
    const qr = pairingUri(ORIGIN, SECRET);
    const frame = frameOf(qr);
    expect(readFrame(frame.data, frame.size, frame.size)).toEqual({ kind: "pair", origin: ORIGIN, secret: SECRET });
  });

  it("ignores a code that is not one of ours", () => {
    const frame = frameOf("https://example.com/menu");
    expect(readFrame(frame.data, frame.size, frame.size)).toBeNull();
  });
});

describe("links", () => {
  it("reads a QR code's address, an emailed link and the app's own link", () => {
    expect(readPhoneLink(pairingUri(ORIGIN, SECRET))).toEqual({ kind: "pair", origin: ORIGIN, secret: SECRET });
    expect(readPhoneLink(signInLinkUri(ORIGIN, SECRET))).toEqual({ kind: "link", origin: ORIGIN, secret: SECRET });
    expect(readPhoneLink(appLinkUri(ORIGIN, SECRET))).toEqual({ kind: "link", origin: ORIGIN, secret: SECRET });
    // The page a QR code opens on an Android phone hands the code to the app itself.
    expect(readPhoneLink(`ai.surfingdog.inbox://pair?o=${encodeURIComponent(ORIGIN)}&s=${SECRET}`)).toEqual({
      kind: "pair",
      origin: ORIGIN,
      secret: SECRET,
    });
    expect(readPhoneLink(`ai.surfingdog.inbox://other?o=${encodeURIComponent(ORIGIN)}&s=${SECRET}`)).toBeNull();
  });

  it("refuses plain http, other paths, other versions, odd secrets and passwords in the address", () => {
    expect(readPhoneLink(`http://inbox.atelierlumen.com/phone#v=1&pair=${SECRET}`)).toBeNull();
    expect(readPhoneLink(`${ORIGIN}/elsewhere#v=1&pair=${SECRET}`)).toBeNull();
    expect(readPhoneLink(`${ORIGIN}/phone#v=2&pair=${SECRET}`)).toBeNull();
    expect(readPhoneLink(`${ORIGIN}/phone#v=1&pair=sdi_pp_short`)).toBeNull();
    expect(readPhoneLink(`https://user:pw@inbox.atelierlumen.com/phone#v=1&pair=${SECRET}`)).toBeNull();
    expect(readPhoneLink(`ai.surfingdog.inbox://link?o=http%3A%2F%2Fevil.example&s=${SECRET}`)).toBeNull();
    // Development builds may reach an inbox on the developer's own computer, and nothing else in plain http.
    expect(readPhoneLink(`http://10.0.2.2:8787/phone#v=1&pair=${SECRET}`, true)?.origin).toBe("http://10.0.2.2:8787");
    expect(readPhoneLink(`http://192.168.1.4/phone#v=1&pair=${SECRET}`, true)).toBeNull();
  });

  it("opens an item from a notification's link, and an item's own address", () => {
    const fromNotification = `ai.surfingdog.inbox://i/01JABC?o=${encodeURIComponent(ORIGIN)}&a=confirm`;
    expect(readItemLink(fromNotification)).toEqual({ origin: ORIGIN, item: "01JABC" });
    expect(readItemLink(itemUri(ORIGIN, "01JABC"))).toEqual({ origin: ORIGIN, item: "01JABC" });
    expect(readItemLink(`ai.surfingdog.inbox://open?o=${encodeURIComponent(ORIGIN)}`)).toBeNull();
    expect(readItemLink("https://inbox.example.com/i/../../etc")).toBeNull();
  });
});
