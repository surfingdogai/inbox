import type { Contact, ItemType } from "../domain/types";
import { normalisePhone } from "../identity/contacts";
import { normaliseEmail } from "../protocol/email";
import type { Caller } from "./caller";
import { type FieldProblem, WriteError } from "./errors";

/**
 * Who a new request is from (ADR-048): an assistant's, or any other client's of the public doors, new
 * booking, order, request for a price, message or stay carries its person's name and a way to reach
 * them, an email address or a phone number. Without them nothing is written, and the answer says
 * exactly what to add, so the assistant asks its person and sends the request again. A person who
 * writes by email or on a form, the business itself and every follow-up on an item are never asked.
 */

/** A client's name as a business writes it on a booking (ADR-048): trimmed, 1 to 200 characters, a letter in it, no email address. Null when it is none. */
export function clientName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length < 1 || name.length > 200) return null;
  return /\p{L}/u.test(name) && !name.includes("@") ? name : null;
}

/** An email address a business can write to (ADR-048): one the networks' normalisation takes, with a dot in its domain, at most 254 characters. Trimmed; null when it is none. */
export function clientEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim();
  if (!email || email.length > 254) return null;
  const normal = normaliseEmail(email);
  return normal?.slice(normal.lastIndexOf("@") + 1).includes(".") ? email : null;
}

/** A phone number a business can call (ADR-048): at most 40 characters, no letters, 6 to 20 digits. Trimmed; null when it is none. */
export function clientPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const phone = raw.trim();
  if (!phone || phone.length > 40 || /\p{L}/u.test(phone)) return null;
  return normalisePhone(phone) ? phone : null;
}

/** Whether a caller's new request must carry its client (ADR-048): an assistant's, or any other client's of the public doors. */
export function clientRequired(caller: Caller): boolean {
  return caller.actor.kind === "customer_agent";
}

const WHAT: Partial<Record<ItemType, string>> = {
  booking: "this booking",
  order: "this order",
  quote_request: "this request for a price",
  message: "this message",
  stay: "this stay",
};

const WRONG = {
  name: "contact.name is not a name",
  email: "contact.email is not an email address we can write to",
  phone: "contact.phone is not a phone number",
} as const;

const ASK =
  "Ask your person, and send only what they agree to give us, in contact: name, and email or phone. Never make them up. Then send the request again with the same idempotency_key. Nothing was written.";

/** Whether a value was sent at all: a string that is not empty once trimmed. */
const sent = (raw: unknown): boolean => typeof raw === "string" && raw.trim() !== "";

/**
 * The refusal of a new request without its client's name and a way to reach them, or null when it has
 * them (ADR-048): `422 invalid_input`, `details.reason` `client_details`, naming what is missing and
 * what is wrong, field by field, in the business's words.
 */
export function clientDetailsError(contact: Contact | undefined, type: ItemType): WriteError | null {
  const c = (contact ?? {}) as Record<string, unknown>;
  const missing: ("name" | "email_or_phone")[] = [];
  const invalid: ("name" | "email" | "phone")[] = [];
  const fields: FieldProblem[] = [];
  if (!sent(c.name)) {
    missing.push("name");
    fields.push({ path: "contact.name", problem: "missing", message: "your person's name, as they give it" });
  } else if (!clientName(c.name)) {
    invalid.push("name");
    fields.push({
      path: "contact.name",
      problem: "invalid",
      message: "a name, with a letter in it and no email address",
    });
  }
  const email = sent(c.email);
  const phone = sent(c.phone);
  if (email && !clientEmail(c.email)) {
    invalid.push("email");
    fields.push({ path: "contact.email", problem: "invalid", message: "an email address we can write to" });
  }
  if (phone && !clientPhone(c.phone)) {
    invalid.push("phone");
    fields.push({ path: "contact.phone", problem: "invalid", message: "a phone number with 6 to 20 digits" });
  }
  if (!email && !phone) {
    missing.push("email_or_phone");
    fields.push({
      path: "contact.email",
      problem: "missing",
      message: "an email address, or a phone number in contact.phone",
    });
  }
  if (!missing.length && !invalid.length) return null;
  const what = WHAT[type] ?? "this request";
  const noName = missing.includes("name");
  const noReach = missing.includes("email_or_phone");
  const first =
    noName && noReach
      ? `To take ${what} we need your person's name, and an email address or a phone number to answer them.`
      : noName
        ? `To take ${what} we need your person's name.`
        : noReach
          ? `To take ${what} we need an email address or a phone number to answer your person.`
          : `To take ${what} we need your person's details as they give them.`;
  const wrong = invalid.length ? ` ${invalid.map((k) => WRONG[k]).join("; ")}.` : "";
  return new WriteError("invalid_input", `${first}${wrong} ${ASK}`, {
    fields,
    details: { reason: "client_details", item_type: type, missing, invalid },
  });
}

/** Throws `clientDetailsError` for a caller that must carry its client (`clientRequired`). The details are judged trimmed and stored as sent. */
export function requireClient(caller: Caller, contact: Contact | undefined, type: ItemType): void {
  if (!clientRequired(caller)) return;
  const error = clientDetailsError(contact, type);
  if (error) throw error;
}
