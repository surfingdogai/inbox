import { shortRef } from "../customer/format";
import type { Db } from "../db";
import type { Item, PayloadOf } from "../domain/types";
import { nightsOf } from "./nights";
import { readSetup } from "./store";
import { datesWords } from "./terms";

/**
 * A stay's moments in its owner's emails (ADR-037 S16), in the owner's own words: who, which dates,
 * how many nights and guests, which rooms, what the guest wrote, and by when the owner answers —
 * "you", never "the business", and the short reference the guest's own emails carry. Dates as English
 * writes them where the property is.
 */

type StayPayload = PayloadOf<"stay">;

/** Who did what, in the owner's words: "accepted your quote". */
const WORDS: Readonly<Record<string, string>> = {
  provide_info: "answered your question for",
  counter: "asks for something else instead of",
  accept: "accepted your quote: confirmed,",
  accept_pay: "accepted your quote and is paying what is due now for",
  book: "booked",
  book_pay: "booked and is paying what is due now for",
  written: "booked, written to your system:",
  written_pay: "booked in your system and is paying what is due now for",
  record_payment: "paid for",
  late_payment: "paid after the time ran out, and the nights were still yours to give: confirmed,",
  decline: "is not going ahead with",
  cancel: "cancelled",
  propose_change: "asks to change",
  accept_change: "accepted the change to",
  change_written: "has the change you agreed, written to your system:",
  change_refused: "keeps the dates: your system did not take the change to",
  decline_change: "keeps it as agreed:",
  retract_change: "withdrew their change to",
};

/** Guests in a few words: "2 adults", "2 adults and 1 child". */
function guestsOf(p: StayPayload): string {
  const adults = p.rooms.reduce((a, r) => a + r.adults, 0);
  const children = p.rooms.reduce((a, r) => a + r.childrenAges.length, 0);
  const a = `${adults} adult${adults === 1 ? "" : "s"}`;
  return children > 0 ? `${a} and ${children} child${children === 1 ? "" : "ren"}` : a;
}

/** What the guest wrote with the request: their special requests, else the message they sent with it. */
async function guestWords(db: Db, item: Item, p: StayPayload): Promise<string | null> {
  if (p.requests?.trim()) return p.requests.trim();
  const { rows } = await db.client.query({
    sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND direction = 'in' ORDER BY created_at, id LIMIT 1",
    params: [item.id],
    method: "all",
  });
  const text = rows[0]?.[0];
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

const oneLine = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/** The subject and body of the owner's email about a stay's event (`create` for a new request). */
export async function ownerStayMail(
  db: Db,
  item: Item,
  event: string,
  who: string,
): Promise<{ readonly subject: string; readonly lines: readonly string[] } | null> {
  if (item.type !== "stay") return null;
  const p = item.payload as StayPayload;
  const setup = await readSetup(db, p.propertyId);
  const dates = datesWords(p.checkIn, p.checkOut, "en", setup?.property);
  const n = nightsOf(p.checkIn, p.checkOut).length;
  const nights = `${n} night${n === 1 ? "" : "s"}`;
  const rooms = p.rooms.map((r) => r.roomTypeName).filter(Boolean);
  const roomWords = rooms.length > 0 ? [...new Set(rooms)].join(", ") : "a room you choose";
  const ref = shortRef(item.id);
  if (event === "create") {
    const wrote = await guestWords(db, item, p);
    const hours = setup?.property.answerHours;
    return {
      subject: `Stay request: ${who}, ${dates}, ${nights}`,
      lines: [
        `${who} asks for ${dates} (${nights}), ${guestsOf(p)}, ${roomWords}.`,
        ...(wrote ? [`They wrote: “${oneLine(wrote, 600)}”`] : []),
        `${hours ? `You answer within ${hours} hour${hours === 1 ? "" : "s"}.` : "It waits for your answer."} Reference ${ref}.`,
      ],
    };
  }
  const words = WORDS[event];
  if (!words) return null;
  return {
    subject: `${who} ${words} ${dates}, ${nights}`,
    lines: [`${who} ${words} ${roomWords}, ${dates} (${nights}), ${guestsOf(p)}. Reference ${ref}.`],
  };
}
