/**
 * A member's track record, as a listing of GET /v1/businesses carries it (`track_record`, from the
 * network's nightly count, docs/protocol/network.md §4.3), in words for the directory and search
 * pages. Every number is the network's: nothing is counted here, the kept share for the meter is
 * the one sum, and a listing without the field says nothing about a record, except a member with
 * no receipts at all, which gets one calm line. Entries the network found (not members) get nothing.
 *
 * The states: `held` (a new member's 30 days, R31, until `held_until`), `none` (no receipts),
 * `pending` (receipts the nightly count has not reached), `gathering` (counted, under the listing's
 * `threshold`: `closed`, and `customers` unless self-reported), `shown` (the record). From rules
 * version 9 a record that fewer than 3 different customers confirmed kept promises of (version 8:
 * less than a fifth of it confirmed by the customer's side) is `self_reported`: the business's own
 * word, said as its counts (kept, broken, still open) with no meter, no score and no customers, and
 * labelled so. The network says which, so this file follows whatever version is in force. How many the customer's side confirmed is said
 * as a count of the closed promises, never as a share; whatever it did not confirm is the business's
 * own word, and a list says so once, under it (`recordNote`).
 */
export interface RecordView {
  /** One line in plain words. */
  text: string;
  /**
   * Kept as a share of closed promises, 0 to 1, when the record is shown and does not rest on the
   * business's own word; the meter's width. A self-reported record has none: no meter, nothing that
   * reads as a score.
   */
  kept?: number;
  /** The record rests on the business's own word (`self_reported`), and its line says so. */
  selfReported?: boolean;
  /** Where to read more: the member's page on the network's site, or how receipts work. */
  href: string;
  /** The link's words. */
  link: string;
  /** Whether the network can confirm any count by the customer's side; false while it cannot check one. */
  confirmable: boolean;
  /**
   * What a list that shows this record must say once under it: `UNCONFIRMED_NOTE` when nothing in it
   * is confirmed and nothing can be yet, `OWN_WORD_NOTE` when some counts are the business's own word
   * the customer's side could have confirmed, nothing when the customer's side confirmed every count
   * or no record is shown.
   */
  note?: string;
}

/** Said once under a list that shows a record, while the network cannot check a customer's side. */
export const UNCONFIRMED_NOTE =
  "Every count is the business's own word: the network stores a customer's counter-signature, but cannot check one until it recognises an assistant platform's key or a customer's record is established.";

/** Said once under a list that shows a record some of whose counts the customer's side did not confirm. */
export const OWN_WORD_NOTE = "Counts not confirmed by the customer's side are the business's own word.";

/** What a self-reported record's line begins with, as its page on the network's site labels it. */
export const SELF_REPORTED = "Self-reported";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
/** A count the network sent: a whole number at least 0, or null when it sent none. */
const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const fmt = new Intl.NumberFormat("en");
const n = (v: number) => fmt.format(v);
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

function day(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "3 Aug 2026 – 10 Oct 2026", one date when both are the same day, or nothing without dates. */
function span(from: string, to: string): string {
  const a = day(from);
  const b = day(to);
  if (!a || !b) return "";
  return a === b ? a : `${a} – ${b}`;
}

function isMember(b: Record<string, unknown>): boolean {
  const source = str(b.source);
  if (source) return source === "member";
  return str(b.manifest_url) !== "" && !b.found;
}

export function recordView(raw: unknown): RecordView | null {
  const b = obj(raw);
  if (!b || !isMember(b)) return null;
  const domain = str(b.domain).toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  const href = `/b/${domain}`;
  const link = "Track record";
  const issued = count(obj(b.receipts)?.issued) ?? 0;
  const none: RecordView = {
    text: "A track record appears once its inbox sends signed receipts.",
    href: "/docs/receipts/",
    link: "How receipts work",
    confirmable: false,
  };

  const r = obj(b.track_record);
  if (!r) return issued === 0 ? none : null;
  const own = r.self_reported === true;
  const at = (text: string): RecordView => ({ text, href, link, confirmable: false });
  switch (str(r.state)) {
    case "none":
      return none;
    case "held": {
      const until = day(str(r.held_until));
      return at(
        until
          ? `A new member's receipts are held for 30 days; its track record is counted from ${until}.`
          : "A new member's receipts are held for 30 days.",
      );
    }
    case "pending":
      return at("Its receipts are counted for a track record at the next nightly count.");
    case "gathering": {
      const closed = count(r.closed);
      const customers = count(r.customers);
      // A self-reported record has no count of customers: the business chooses who they are.
      if (closed === null || (!own && customers === null)) return null;
      const so =
        own || customers === null ? "on the business's own word" : `from ${plural(customers, "customer", "customers")}`;
      return at(
        closed === 0
          ? "Not enough receipts yet for a track record (none closed so far)."
          : `Not enough receipts yet for a track record (${n(closed)} closed so far, ${so}).`,
      );
    }
    case "shown":
      break;
    default:
      return null;
  }

  const kept = count(r.kept);
  const broken = count(r.broken);
  const customers = count(r.customers);
  if (kept === null || broken === null || (!own && customers === null) || kept + broken === 0) return null;
  const parts = [`${n(kept)} kept`, `${n(broken)} broken`];
  const unclosed = count(r.unclosed) ?? 0;
  const late = count(r.refunds_late) ?? 0;
  const why = [
    unclosed > 0 ? `${n(unclosed)} left open 9 days past due` : "",
    late > 0 ? plural(late, "refund paid late", "refunds paid late") : "",
  ].filter(Boolean);
  if (why.length > 0) parts[1] = `${parts[1]} (${why.join(", ")})`;
  // From rules version 8: its promises still open, as the network counts them.
  const open = count(r.open);
  if (open !== null) parts.push(`${n(open)} still open`);
  if (own) parts.unshift(SELF_REPORTED);
  else if (customers !== null) parts.push(`from ${plural(customers, "customer", "customers")}`);
  const when = span(str(r.from), str(r.to));
  if (when) parts.push(when);
  // What the customer's side confirmed stays said even when nothing more can be (customer scoring
  // paused); the rest is the business's own word, which the note under the list says.
  const confirmable = r.confirmable === true;
  const closed = kept + broken;
  const confirmed = Math.min(count(r.confirmed) ?? 0, closed);
  if (confirmed > 0) {
    parts.push(
      confirmed === closed
        ? `all ${n(closed)} confirmed by the customer's side`
        : `${n(confirmed)} of ${n(closed)} confirmed by the customer's side`,
    );
  }
  const view: RecordView = own
    ? { text: parts.join(" · "), selfReported: true, href, link, confirmable }
    : { text: parts.join(" · "), kept: kept / closed, href, link, confirmable };
  if (confirmed < closed) view.note = !confirmable && confirmed === 0 ? UNCONFIRMED_NOTE : OWN_WORD_NOTE;
  return view;
}

/** The one note under a list of records: the strongest any of them needs, or "" when none does. */
export function recordNote(views: readonly (RecordView | null | undefined)[]): string {
  const notes = views.map((v) => v?.note);
  if (notes.includes(UNCONFIRMED_NOTE)) return UNCONFIRMED_NOTE;
  return notes.includes(OWN_WORD_NOTE) ? OWN_WORD_NOTE : "";
}
