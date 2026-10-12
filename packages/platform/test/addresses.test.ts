import { describe, expect, it } from "vitest";
import { addressOfHost, parseAddressRange, parseIp, refusedAddress, refusedAddressText } from "../src/addresses";

/**
 * What a name may resolve to before an outbound call connects. The rules run wherever a runtime can
 * resolve a name first (Node's `pinnedFetch`); they are web-standard, so they are pinned on both.
 */
describe("the addresses an outbound call never reaches", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.10", "private"],
    ["169.254.169.254", "link-local"],
    ["100.64.0.1", "shared"],
    ["100.127.255.255", "shared"],
    ["192.0.2.10", "reserved"],
    ["198.18.0.1", "reserved"],
    ["224.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "v4-mapped"],
    ["::ffff:8.8.8.8", "v4-mapped"],
    ["::ffff:7f00:1", "v4-mapped"],
    ["fc00::1", "unique-local"],
    ["fd12:3456:789a::1", "unique-local"],
    ["fe80::1", "link-local"],
    ["fe80::1%eth0", "link-local"],
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::a00:1", "private"],
    ["64:ff9b::169.254.169.254", "link-local"],
    ["64:ff9b:1::7f00:1", "reserved"],
    ["::127.0.0.1", "reserved"],
    ["fec0::1", "reserved"],
    ["ff02::1", "reserved"],
    ["2001:db8::1", "reserved"],
    ["2002:7f00:1::1", "reserved"],
    ["2001::1", "reserved"],
  ];
  for (const [address, kind] of cases) {
    it(`${address} is ${kind}`, () => expect(refusedAddress(address)).toBe(kind));
  }

  it("lets public addresses through, IPv4 and IPv6", () => {
    for (const a of [
      "8.8.8.8",
      "1.1.1.1",
      "100.128.0.1",
      "172.32.0.1",
      "2606:4700:4700::1111",
      "2a00:1450:4003::200e",
    ]) {
      expect(refusedAddress(a), a).toBeNull();
    }
  });

  // An IPv6-only server with DNS64 gets 64:ff9b::a.b.c.d for every name with only an IPv4 address:
  // judged as that IPv4 address, a public one is called and a private one still is not.
  it("calls a public IPv4 address reached through NAT64's well-known prefix", () => {
    expect(refusedAddress("64:ff9b::5db8:d822")).toBeNull();
    expect(refusedAddress("64:ff9b::93.184.216.34")).toBeNull();
  });

  it("refuses anything that is not an address", () => {
    for (const a of ["", "localhost", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1::2::3", ":::"]) {
      expect(refusedAddress(a), a).toBe("reserved");
    }
  });

  it("refuses the host's own ranges too, and keeps refusing them for a call allowed private addresses", () => {
    const deny = [parseAddressRange("203.0.114.0/24"), parseAddressRange("2a01:4f8::1")].map((r) => {
      if (!r) throw new Error("a range that should parse");
      return r;
    });
    expect(refusedAddress("203.0.114.9", { deny })).toBe("denied");
    expect(refusedAddress("203.0.115.9", { deny })).toBeNull();
    expect(refusedAddress("2a01:4f8::1", { deny })).toBe("denied");
    expect(refusedAddress("2a01:4f8::2", { deny })).toBeNull();
    // Written as IPv6, the same IPv4 address is still the host's own.
    expect(refusedAddress("::ffff:203.0.114.9", { deny, allowPrivate: true })).toBe("denied");
    expect(refusedAddress("203.0.114.9", { deny, allowPrivate: true })).toBe("denied");
    expect(refusedAddress("192.168.1.10", { deny, allowPrivate: true })).toBeNull();
    expect(refusedAddress("127.0.0.1", { allowPrivate: true })).toBeNull();
    expect(refusedAddress("::1", { allowPrivate: true })).toBeNull();
    // Through NAT64 it is the same address; through a tunnel it cannot be told, so it is not called.
    expect(refusedAddress("64:ff9b::cb00:7209", { deny })).toBe("denied");
    expect(refusedAddress("64:ff9b::203.0.114.9", { deny, allowPrivate: true })).toBe("denied");
    expect(refusedAddress("64:ff9b::c0a8:10a", { deny, allowPrivate: true })).toBeNull();
    for (const tunnelled of ["::203.0.114.9", "2002:cb00:7209::1", "64:ff9b:1::cb00:7209", "2001:0:4136:e378::1"]) {
      expect(refusedAddress(tunnelled, { deny, allowPrivate: true }), tunnelled).toBe("reserved");
    }
  });

  it("says what each refused address is", () => {
    expect(refusedAddressText("loopback")).toBe("a loopback address");
    expect(refusedAddressText("shared")).toBe("a shared (carrier-grade NAT) address");
    expect(refusedAddressText("denied")).toBe("an address this host does not call");
  });
});

describe("address ranges as an operator writes them", () => {
  it("reads CIDR and single addresses, and ignores bits past the prefix", () => {
    expect(parseAddressRange("10.0.0.0/8")).toMatchObject({ bits: 8 });
    expect(parseAddressRange(" 203.0.114.7 ")).toMatchObject({ text: "203.0.114.7", bits: 32 });
    expect(parseAddressRange("2001:db8::/32")).toMatchObject({ bits: 32 });
    expect(parseAddressRange("10.9.9.9/8")).toMatchObject({ bits: 8 });
    expect(refusedAddress("10.200.0.1", { deny: [parseAddressRange("10.9.9.9/8") as never], allowPrivate: true })).toBe(
      "denied",
    );
  });

  it("refuses what is not a range", () => {
    for (const r of ["", "10.0.0.0/33", "::/129", "10.0.0.0/", "10.0.0.0/a", "example.com/8", "10.0.0.0/8/8"]) {
      expect(parseAddressRange(r), r).toBeNull();
    }
  });
});

describe("a URL's host", () => {
  it("is an address when the URL parser wrote one, in any of the ways IPv4 can be written", () => {
    expect(addressOfHost(new URL("http://127.0.0.1:2019/stop").hostname)).toBe("127.0.0.1");
    expect(addressOfHost(new URL("http://2130706433/").hostname)).toBe("127.0.0.1");
    expect(addressOfHost(new URL("http://0x7f.1/").hostname)).toBe("127.0.0.1");
    expect(addressOfHost(new URL("http://[::1]/").hostname)).toBe("::1");
    expect(addressOfHost(new URL("http://[::ffff:169.254.169.254]/").hostname)).toBe("::ffff:a9fe:a9fe");
    expect(addressOfHost("hooks.example.com")).toBeNull();
  });

  it("parses to bytes of the right length", () => {
    expect(parseIp("8.8.8.8")?.length).toBe(4);
    expect(parseIp("2606:4700::1111")?.length).toBe(16);
    expect(Array.from(parseIp("::ffff:1.2.3.4") ?? [])).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 1, 2, 3, 4]);
  });
});
