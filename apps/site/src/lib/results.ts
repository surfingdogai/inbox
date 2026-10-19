/**
 * One entry of GET /v1/businesses, as the search page shows it: a name that links to the business's
 * own site, where it is, what an agent can do there and through which doors, and, for a business
 * the crawler found rather than a member, that it was found on its own website and when. Every word
 * comes from the entry; nothing is filled in when a field is missing.
 */
export interface ResultView {
  name: string;
  href: string;
  where: string;
  takes: string;
  found: string;
  tags: { text: string; on: boolean }[];
  /**
   * How it is paid (accepts.pay_with): the ways the business declared, then the ones only seen (on its site, or in
   * its shop platform's standard profile), each card brand inside Card ("Card (Visa)"), and how many more the line
   * leaves out; null when it names none.
   */
  pays: PayView | null;
}

export interface PayView {
  declared: string[];
  seen: string[];
  /** Ways left out of the line, which its listing holds. */
  more: number;
}

/** The most ways to pay a result names; the rest are counted, and in its listing. */
const PAYS_SHOWN = 6;

/** The card brands: each shown inside Card when Card is in the same group. */
const CARD_BRANDS = new Set(["visa", "mastercard", "amex"]);

/** Never a way a person pays: the UCP protocol itself, whose handlers are listed apart. */
const PAY_HIDDEN = new Set(["ucp_handlers"]);

/** One group's ways as a line names them, each card brand inside Card when Card is in it. */
function payNames(ways: { token: string; label: string }[]): string[] {
  const card = ways.find((w) => w.token === "card");
  const brands = ways.filter((w) => CARD_BRANDS.has(w.token)).map((w) => w.label);
  return ways
    .filter((w) => !(card && CARD_BRANDS.has(w.token)))
    .map((w) => (w === card && brands.length ? `${w.label} (${brands.join(", ")})` : w.label));
}

/** accepts.pay_with as the line shows it; anything malformed is left out. */
function payView(payWith: unknown): PayView | null {
  const declared: { token: string; label: string }[] = [];
  const seen: { token: string; label: string }[] = [];
  for (const p of Array.isArray(payWith) ? (payWith as unknown[]) : []) {
    const pay = obj(p);
    const token = str(pay?.token);
    const label = str(pay?.label);
    const src = str(pay?.src);
    if (PAY_HIDDEN.has(token) || !/^[\p{L}\p{N} .&'-]{1,40}$/u.test(label)) continue;
    if (src === "declared") declared.push({ token, label });
    else if (src === "seen") seen.push({ token, label });
  }
  const all = [
    ...payNames(declared).map((n) => ({ n, seen: false })),
    ...payNames(seen).map((n) => ({ n, seen: true })),
  ];
  if (!all.length) return null;
  const shown = all.slice(0, PAYS_SHOWN);
  return {
    declared: shown.filter((x) => !x.seen).map((x) => x.n),
    seen: shown.filter((x) => x.seen).map((x) => x.n),
    more: all.length - shown.length,
  };
}

/** What a member's inbox takes and what a door accepts, in plain words. */
const TAKES: Record<string, string> = {
  booking: "bookings",
  book: "bookings",
  order: "orders",
  quote_request: "quote requests",
  quote: "quote requests",
  message: "messages",
  ask: "messages",
  pay: "payment",
  refund: "refunds",
  cancel: "cancellations",
};

const LEVELS: Record<string, string> = {
  payable: "Payable",
  bookable: "Bookable",
  orderable: "Orderable",
  askable: "Askable",
  readable: "Readable",
  listed: "Listed",
};

/** Door types as people write them. */
const DOORS: Record<string, string> = {
  inbox: "Inbox",
  agent_inbox: "Inbox",
  mcp: "MCP",
  a2a: "A2A",
  openapi: "OpenAPI",
  ucp: "UCP",
  acp: "ACP",
  webmcp: "WebMCP",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

/**
 * A door's name for a tag: a known type as people write it; a platform's door by the platform's
 * name ("platform:shopify" is "Shopify"); an "other" door by the protocol it names, or nothing; any
 * other short type in capitals; anything else, nothing.
 */
function doorName(type: string, protocol: string): string {
  const t = type.toLowerCase();
  const known = DOORS[t];
  if (known) return known;
  if (t.startsWith("platform:")) {
    const slug = t.slice("platform:".length).replace(/[-_]+/g, " ").trim();
    return /^[a-z0-9 ]{1,24}$/.test(slug) ? slug.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : "";
  }
  if (t === "other") return /^[\p{L}\p{N} .-]{1,24}$/u.test(protocol) ? protocol : "";
  return /^[a-z0-9]{2,8}$/.test(t) ? t.toUpperCase() : "";
}

/** A link to the business's own site: its http(s) url, else its domain, else nothing to link. */
function siteOf(url: string, domain: string): string {
  if (/^https?:\/\/[^\s]+$/i.test(url)) return url;
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return `https://${domain}`;
  return "";
}

export function resultView(raw: unknown): ResultView | null {
  const b = obj(raw);
  if (!b) return null;
  const domain = str(b.domain);
  const name = str(b.name) || domain;
  if (!name) return null;
  const href = siteOf(str(b.url), domain);
  if (!href) return null;

  const place = obj(b.place);
  const category = obj(obj(b.category)?.primary);
  const where = [
    str(category?.label),
    [str(place?.locality) || str(b.city), str(place?.country) || str(b.country)].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join(" · ");

  const pays = payView(obj(b.accepts)?.pay_with);
  const kinds = new Set<string>();
  for (const k of [...strs(b.item_types), ...strs(obj(b.accepts)?.kinds)]) {
    const w = TAKES[k];
    // Payment is said once: by the line of how it is paid, when there is one.
    if (w && !(pays && w === "payment")) kinds.add(w);
  }
  const takes = kinds.size ? `Takes ${[...kinds].join(", ")}` : "";

  const tags: { text: string; on: boolean }[] = [];
  if (b.answering === true || b.online === true) tags.push({ text: "Answering", on: true });
  const level = LEVELS[str(b.level).toLowerCase()];
  if (level) tags.push({ text: level, on: false });
  const doors = new Set<string>();
  for (const d of Array.isArray(b.doors) ? b.doors : []) {
    const door = obj(d);
    const type = str(door?.type);
    const status = str(door?.status).toLowerCase();
    const name = type && (status === "" || status === "live") ? doorName(type, str(door?.protocol)) : "";
    if (name) doors.add(name);
  }
  for (const d of doors) tags.push({ text: d, on: false });

  let found = "";
  const f = obj(b.found);
  if (f) {
    const at = Date.parse(str(f.checked_at));
    const when = Number.isNaN(at)
      ? ""
      : `, checked ${new Date(at).getUTCDate()} ${MONTHS[new Date(at).getUTCMonth()]} ${new Date(at).getUTCFullYear()}`;
    found = `Found on its own website${when}.`;
  }
  return { name, href, where, takes, found, tags, pays };
}
