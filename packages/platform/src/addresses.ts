/**
 * Which IP addresses an outbound connection may reach. The host rule in `@surfingdog/core`
 * (`util/hosts.ts`) judges a name; this judges what a name resolves to, which is the half a check
 * on the name alone cannot see: anyone with a domain can point a public name at 127.0.0.1, at a
 * cloud's metadata service or at the machine next door. A runtime that resolves a name before it
 * connects asks this about every address it got, and connects only to one that passed (Node:
 * `pinnedFetch` in `@surfingdog/platform/node`). Web-standard on purpose, so both runtimes test it.
 */

/** Why an address is not connected to. */
export type RefusedAddress =
  | "unspecified"
  | "loopback"
  | "private"
  | "link-local"
  | "shared"
  | "unique-local"
  | "v4-mapped"
  | "reserved"
  | "denied";

/** A range of addresses: `10.0.0.0/8`, `2001:db8::/32`, or one address. */
export interface AddressRange {
  /** As it was written. */
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly bits: number;
}

/**
 * The ranges no outbound call reaches, with what each is. Loopback and "this network" reach the
 * machine itself (a connection to 0.0.0.0 lands on localhost); the private, shared (carrier-grade
 * NAT, which is also what some clouds number their internal hosts from) and link-local ranges reach
 * the network around it, the cloud's metadata service at 169.254.169.254 among them; the rest is
 * documentation, benchmarking, multicast and the reserved blocks, where nobody's endpoint lives.
 */
const RANGES: readonly (readonly [string, RefusedAddress])[] = [
  ["0.0.0.0/8", "unspecified"],
  ["10.0.0.0/8", "private"],
  ["100.64.0.0/10", "shared"],
  ["127.0.0.0/8", "loopback"],
  ["169.254.0.0/16", "link-local"],
  ["172.16.0.0/12", "private"],
  ["192.0.0.0/24", "reserved"],
  ["192.0.2.0/24", "reserved"],
  ["192.88.99.0/24", "reserved"],
  ["192.168.0.0/16", "private"],
  ["198.18.0.0/15", "reserved"],
  ["198.51.100.0/24", "reserved"],
  ["203.0.113.0/24", "reserved"],
  ["224.0.0.0/4", "reserved"],
  ["240.0.0.0/4", "reserved"],
  ["::/128", "unspecified"],
  ["::1/128", "loopback"],
  // An IPv4 address written as IPv6 reaches the IPv4 address, private or not, so none is called.
  ["::ffff:0:0/96", "v4-mapped"],
  ["fc00::/7", "unique-local"],
  ["fe80::/10", "link-local"],
];

const BUILT_IN: readonly (readonly [AddressRange, RefusedAddress])[] = RANGES.map(([text, kind]) => [
  parseAddressRange(text) as AddressRange,
  kind,
]);

/**
 * IPv6 outside 2000::/3 is not global unicast: the old IPv4-compatible form, NAT64's local-use
 * prefix, site-local and multicast among it. Inside it, the protocol assignments (Teredo with them),
 * documentation and 6to4.
 */
const GLOBAL_V6 = parseAddressRange("2000::/3") as AddressRange;
const RESERVED_IN_GLOBAL_V6: readonly AddressRange[] = ["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"].map(
  (r) => parseAddressRange(r) as AddressRange,
);

/**
 * NAT64's well-known prefix: 64:ff9b::a.b.c.d reaches the IPv4 address a.b.c.d through the network's
 * translator. On a server with only IPv6 and DNS64, every name with only an IPv4 address resolves to
 * one, so it is judged as the IPv4 address it carries: a public one is called, 64:ff9b::7f00:1
 * (127.0.0.1) is not.
 */
const NAT64 = parseAddressRange("64:ff9b::/96") as AddressRange;

/**
 * The other ways an IPv6 address carries an IPv4 one, to reach it through a tunnel or a translator:
 * IPv4-compatible (::a.b.c.d), NAT64's local-use prefix, Teredo and 6to4. None is called even for a
 * call allowed private addresses, since the host's own IPv4 ranges cannot be read off all of them.
 */
const CARRIES_V4: readonly AddressRange[] = ["::/96", "64:ff9b:1::/48", "2001::/32", "2002::/16"].map(
  (r) => parseAddressRange(r) as AddressRange,
);
const THIS_MACHINE = parseAddressRange("::/127") as AddressRange;

/**
 * Why `address` is not connected to, or null when it may be. `deny` adds ranges of the host's own
 * (its own public addresses, a neighbour's), and an IPv4 range there holds for the same address
 * written as IPv6 (IPv4-mapped, NAT64) too; `allowPrivate` lifts the built-in ranges for a call the
 * owner pointed at a machine of their own, and the host's `deny` still holds then, so an address
 * that reaches IPv4 through a tunnel is still refused. Anything that is not an address is refused.
 */
export function refusedAddress(
  address: string,
  opts: { readonly deny?: readonly AddressRange[] | undefined; readonly allowPrivate?: boolean | undefined } = {},
): RefusedAddress | null {
  const bytes = parseIp(address);
  if (!bytes) return "reserved";
  const nat64 = bytes.length === 16 && inRange(bytes, NAT64);
  const v4 = mappedV4(bytes) ?? (nat64 ? bytes.slice(12) : null);
  for (const range of opts.deny ?? []) {
    if (inRange(bytes, range) || (v4 && inRange(v4, range))) return "denied";
  }
  if (nat64 && v4) return refusedAddress(v4.join("."), opts);
  if (opts.allowPrivate) {
    const tunnelled = CARRIES_V4.some((r) => inRange(bytes, r)) && !inRange(bytes, THIS_MACHINE);
    return tunnelled ? "reserved" : null;
  }
  for (const [range, kind] of BUILT_IN) if (inRange(bytes, range)) return kind;
  if (bytes.length === 16) {
    if (!inRange(bytes, GLOBAL_V6)) return "reserved";
    if (RESERVED_IN_GLOBAL_V6.some((r) => inRange(bytes, r))) return "reserved";
  }
  return null;
}

/** What a refused address is, in words for an error a person reads: "a loopback address". */
export function refusedAddressText(kind: RefusedAddress): string {
  switch (kind) {
    case "unspecified":
      return "an address that means this machine";
    case "loopback":
      return "a loopback address";
    case "private":
      return "a private address";
    case "link-local":
      return "a link-local address";
    case "shared":
      return "a shared (carrier-grade NAT) address";
    case "unique-local":
      return "a unique local address";
    case "v4-mapped":
      return "an IPv4-mapped address";
    case "reserved":
      return "a reserved address";
    case "denied":
      return "an address this host does not call";
  }
}

/**
 * A range as an operator writes one (`10.0.0.0/8`, `2001:db8::/32`), or a single address, which is
 * a range of one. Null when it is neither. Bits past the prefix are ignored, as a router would.
 */
export function parseAddressRange(text: string): AddressRange | null {
  const trimmed = text.trim();
  const slash = trimmed.indexOf("/");
  const bytes = parseIp(slash < 0 ? trimmed : trimmed.slice(0, slash));
  if (!bytes) return null;
  const max = bytes.length * 8;
  if (slash < 0) return { text: trimmed, bytes, bits: max };
  const suffix = trimmed.slice(slash + 1);
  if (!/^\d{1,3}$/.test(suffix)) return null;
  const bits = Number(suffix);
  return bits <= max ? { text: trimmed, bytes, bits } : null;
}

/**
 * An address as the host part of a URL writes it: IPv6 inside brackets, IPv4 as it is. Null for a
 * name. The WHATWG URL parser has already turned every other way of writing an IPv4 address
 * (`2130706433`, `0x7f.1`) into the dotted form, so a hostname is either this or a name.
 */
export function addressOfHost(hostname: string): string | null {
  const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return parseIp(h) ? h : null;
}

/** An address as bytes: four for IPv4, sixteen for IPv6; null when the text is not one. */
export function parseIp(text: string): Uint8Array | null {
  return text.includes(":") ? parseV6(text) : parseV4(text);
}

/** Dotted decimal, four parts, no leading zeros: the one way a resolver writes an IPv4 address. */
function parseV4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i] ?? "";
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseV6(text: string): Uint8Array | null {
  // A zone (`fe80::1%eth0`) says which interface, not which address.
  let s = text.includes("%") ? text.slice(0, text.indexOf("%")) : text;
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  if (s.includes(".")) {
    const at = s.lastIndexOf(":");
    const v4 = parseV4(s.slice(at + 1));
    if (!v4) return null;
    const hi = (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16);
    const lo = (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16);
    s = `${s.slice(0, at + 1)}${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const all = [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = all[i] ?? "";
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = Number.parseInt(g, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

/** The IPv4 address inside an IPv4-mapped one (`::ffff:10.0.0.1`), else null. */
function mappedV4(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length !== 16) return null;
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return null;
  return bytes[10] === 0xff && bytes[11] === 0xff ? bytes.slice(12) : null;
}

function inRange(bytes: Uint8Array, range: AddressRange): boolean {
  if (bytes.length !== range.bytes.length) return false;
  let left = range.bits;
  for (let i = 0; i < bytes.length && left > 0; i++, left -= 8) {
    const mask = left >= 8 ? 0xff : (0xff << (8 - left)) & 0xff;
    if (((bytes[i] ?? 0) & mask) !== ((range.bytes[i] ?? 0) & mask)) return false;
  }
  return true;
}
