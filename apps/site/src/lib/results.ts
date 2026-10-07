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
  askable: "Askable",
  readable: "Readable",
  listed: "Listed",
};

/** Door types as people write them. */
const DOORS: Record<string, string> = {
  inbox: "Inbox",
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

  const kinds = new Set<string>();
  for (const k of [...strs(b.item_types), ...strs(obj(b.accepts)?.kinds)]) {
    const w = TAKES[k];
    if (w) kinds.add(w);
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
    if (type && (status === "" || status === "live")) doors.add(DOORS[type.toLowerCase()] ?? type.toUpperCase());
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
  return { name, href, where, takes, found, tags };
}
