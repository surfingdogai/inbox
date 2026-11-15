import type { Contact, ItemType } from "../domain/types";
import { normalisePhone } from "../identity/contacts";
import { normaliseEmail } from "../protocol/email";
import { type Caller, isCustomer } from "./caller";
import { type FieldProblem, WriteError } from "./errors";

/**
 * Who a new request is from (ADR-048): an assistant's, or any other client's of the public doors, new
 * booking, order, request for a price, message or stay carries its person's name and a way to reach
 * them, an email address or a phone number. Without them nothing is written, and the answer says
 * exactly what to add, so the assistant asks its person and sends the request again. A person who
 * writes by email or on a form, the business itself and every follow-up on an item are never asked.
 *
 * Each detail is judged twice over: by its shape (`clientName`, `clientEmail`, `clientPhone`), which every
 * door holds it to, and, on a request that is not a test, by whether it is what an assistant writes when it
 * has none (`fillerName`, `fillerEmail`, `fillerPhone`): "N/A", "{{customer_name}}", an address at .invalid,
 * "000000". A test item (sandbox) may name a made-up client: it emails nobody.
 */

/** Code points that draw nothing: a name made of them alone (the Hangul filler U+3164 among them) shows none. */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\s]/gu;

/** A client's name as a business writes it on a booking (ADR-048): trimmed, 1 to 200 characters, a letter you can see in it, no "@". Null when it is none. */
export function clientName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length < 1 || name.length > 200 || name.includes("@")) return null;
  return /\p{L}/u.test(name.replace(INVISIBLE, "")) ? name : null;
}

/** An email address a business can write to (ADR-048): one the networks' normalisation takes, with a dot in its domain, at most 254 characters. Trimmed; null when it is none. */
export function clientEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim();
  if (!email || email.length > 254) return null;
  const normal = normaliseEmail(email);
  return normal?.slice(normal.lastIndexOf("@") + 1).includes(".") ? email : null;
}

/** The characters a phone number is written with besides its digits: spaces, +, dashes, brackets, dots and slashes. */
const PHONE_MARKS = /^[\d\s+()./\p{Pd}]+$/u;

/** A phone number a business can call (ADR-048): at most 40 characters, 6 to 20 digits, nothing else but spaces, +, -, (, ), . and /. Trimmed; null when it is none. */
export function clientPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const phone = raw.trim();
  if (!phone || phone.length > 40 || !PHONE_MARKS.test(phone)) return null;
  return normalisePhone(phone) ? phone : null;
}

/**
 * What an assistant writes for a name when it has none, compared in lower case, letters and digits alone: a word
 * for nobody, a form's own label, a test's filler. A person's own name is never one of these.
 */
const NO_NAMES: ReadonlySet<string> = new Set([
  "na",
  "n a",
  "none",
  "null",
  "nil",
  "nan",
  "undefined",
  "unknown",
  "unspecified",
  "not provided",
  "not given",
  "not available",
  "not applicable",
  "not specified",
  "no name",
  "noname",
  "nobody",
  "anonymous",
  "anon",
  "tbd",
  "tbc",
  "redacted",
  "name",
  "your name",
  "full name",
  "fullname",
  "first name",
  "last name",
  "firstname",
  "lastname",
  "first last",
  "firstname lastname",
  "first name last name",
  "customer name",
  "client name",
  "guest name",
  "user name",
  "username",
  "customer",
  "client",
  "guest",
  "user",
  "visitor",
  "buyer",
  "person",
  "your person",
  "my person",
  "the person",
  "the customer",
  "the client",
  "assistant",
  "the assistant",
  "your assistant",
  "ai assistant",
  "bot",
  "agent",
  "test",
  "testing",
  "tester",
  "test test",
  "test user",
  "test customer",
  "test client",
  "test guest",
  "test name",
  "test person",
  "sample",
  "sample name",
  "example",
  "example name",
  "demo",
  "demo user",
  "dummy",
  "fake",
  "fake name",
  "foo",
  "bar",
  "baz",
  "foo bar",
  "foobar",
  "john doe",
  "jane doe",
]);

/** Words only a test's filler has, anywhere in a name: "audit-fixturex". */
const FILLER_WORDS = /fixture|placeholder|loremipsum|asdf|qwerty/;

/** A template's marks, a link: what a name never holds. */
const TEMPLATE = /[{}<>[\]$%`|\\]|:\/\/|^www\./i;

/** Whether a name, as `clientName` takes it, is what an assistant writes when it has none (ADR-048): "N/A", "Test", "{{customer_name}}", a link. */
export function fillerName(name: string): boolean {
  if (TEMPLATE.test(name)) return true;
  const words = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const joined = words.replace(/ /g, "");
  return NO_NAMES.has(words) || NO_NAMES.has(joined) || FILLER_WORDS.test(joined) || /^(.)\1{2,}$/u.test(joined);
}

/**
 * The top-level domains no mail is ever delivered to: reserved for tests, for documents' made-up hosts that are
 * not addresses (RFC 2606, RFC 6761), and for networks of one's own (.local, .internal, .home.arpa). The
 * documentation names example.com, example.net, example.org and .example are taken: they are how a guide or a
 * test names a client.
 */
const NO_MAIL_TLDS: ReadonlySet<string> = new Set([
  "invalid",
  "test",
  "localhost",
  "local",
  "localdomain",
  "internal",
  "lan",
  "home",
  "corp",
  "alt",
  "onion",
  "arpa",
]);

/** A mailbox nobody reads: "noreply@", "do-not-reply@". */
const NO_REPLY = /^(no-?reply|do-?not-?reply|donotreply)([+.].*)?$/;

/** Whether an address, as `clientEmail` takes it, is one no answer reaches (ADR-048): a domain that receives no mail, or a no-reply mailbox. */
export function fillerEmail(email: string): boolean {
  const normal = normaliseEmail(email);
  if (!normal) return false;
  const at = normal.lastIndexOf("@");
  const tld = normal.slice(normal.lastIndexOf(".") + 1);
  return NO_MAIL_TLDS.has(tld) || NO_REPLY.test(normal.slice(0, at));
}

/** Whether a number, as `clientPhone` takes it, is a placeholder (ADR-048): one digit over and over, or the digits counted up or down. */
export function fillerPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  if (/^(\d)\1+$/.test(digits)) return true;
  return "01234567890123456789".includes(digits) || "98765432109876543210".includes(digits);
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

/** Why a detail was refused, in a sentence, and what each one needs, by field: every rule it is held to. */
const WRONG = {
  name: {
    shape: "contact.name is not a name: it has a letter in it, no @, and at most 200 characters",
    filler: "contact.name is a placeholder, not your person's name",
  },
  email: {
    shape: "contact.email is not an email address we can write to",
    filler: "contact.email receives no mail: it is at a domain no mail reaches, or a no-reply mailbox",
  },
  phone: {
    shape:
      "contact.phone is not a phone number: it has 6 to 20 digits, no letters (no extension), and only spaces, +, -, (, ), . or / between them",
    filler: "contact.phone is a placeholder, not a number your person answers",
  },
} as const;

const NEEDS = {
  name: {
    shape: "a name: a letter in it, no @, at most 200 characters",
    filler: "your person's own name, not a placeholder (N/A, Test, {{name}}) or a link",
  },
  email: {
    shape: "an email address we can write to (name@domain), at most 254 characters",
    filler: "an address that receives mail: not at .invalid, .test or localhost, and not a no-reply one",
  },
  phone: {
    shape: "a phone number: 6 to 20 digits, no letters (no extension), only spaces, +, -, (, ), . or / between them",
    filler: "the number your person answers, not 000000 or 123456",
  },
} as const;

const ASK =
  "Ask your person, and send only what they agree to give us, in contact: name, and email or phone. Never make them up. Then send the request again with the same idempotency_key. Nothing was written.";

/** Whether a value was sent at all: a string that is not empty once trimmed. */
const sent = (raw: unknown): boolean => typeof raw === "string" && raw.trim() !== "";

/** What is wrong with each detail that was sent, if anything: its shape, or (on a live request) a placeholder. */
function judged(c: Record<string, unknown>, live: boolean) {
  const name = sent(c.name) ? clientName(c.name) : null;
  const email = sent(c.email) ? clientEmail(c.email) : null;
  const phone = sent(c.phone) ? clientPhone(c.phone) : null;
  const why = (ok: string | null, filler: (v: string) => boolean): "shape" | "filler" | null =>
    ok === null ? "shape" : live && filler(ok) ? "filler" : null;
  return {
    name: sent(c.name) ? why(name, fillerName) : null,
    email: sent(c.email) ? why(email, fillerEmail) : null,
    phone: sent(c.phone) ? why(phone, fillerPhone) : null,
  };
}

/**
 * The refusal of a new request without its client's name and a way to reach them, or null when it has
 * them (ADR-048): `422 invalid_input`, `details.reason` `client_details`, naming what is missing and
 * what is wrong, field by field, in the business's words. `live`: a request that is not a test, whose
 * details are also refused when they are placeholders.
 */
export function clientDetailsError(
  contact: Contact | undefined,
  type: ItemType,
  o: { readonly live?: boolean } = {},
): WriteError | null {
  const c = (contact ?? {}) as Record<string, unknown>;
  const live = o.live !== false;
  const missing: ("name" | "email_or_phone")[] = [];
  const invalid: ("name" | "email" | "phone")[] = [];
  const fields: FieldProblem[] = [];
  const wrong: string[] = [];
  const bad = judged(c, live);
  if (!sent(c.name)) {
    missing.push("name");
    fields.push({ path: "contact.name", problem: "missing", message: "your person's name, as they give it" });
  }
  for (const key of ["name", "email", "phone"] as const) {
    const why = bad[key];
    if (!why) continue;
    invalid.push(key);
    wrong.push(WRONG[key][why]);
    fields.push({ path: `contact.${key}`, problem: "invalid", message: NEEDS[key][why] });
  }
  if (!sent(c.email) && !sent(c.phone)) {
    missing.push("email_or_phone");
    fields.push({
      path: "contact.email",
      problem: "missing",
      message: "an email address, or a phone number in contact.phone",
    });
  }
  // The fields in the order of the contact: name, then the ways to reach them.
  fields.sort((a, b) => order(a.path) - order(b.path));
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
  const why = wrong.length ? ` ${wrong.join("; ")}.` : "";
  return new WriteError("invalid_input", `${first}${why} ${ASK}`, {
    fields,
    details: { reason: "client_details", item_type: type, missing, invalid },
  });
}

const order = (path: string) => ["contact.name", "contact.email", "contact.phone"].indexOf(path);

/**
 * What the business's own keys and AI are held to when they write a client down (ADR-048): nothing is asked of
 * them, but what they send is a name of at most 200 characters, an email address we can write to and a phone of
 * at most 40 characters, as the doors held them to before the client rule. Null when it is.
 */
function contactShapeError(contact: Contact | undefined, type: ItemType): WriteError | null {
  const c = (contact ?? {}) as Record<string, unknown>;
  const fields: FieldProblem[] = [];
  const wrong: string[] = [];
  if (typeof c.name === "string" && c.name.trim().length > 200) {
    fields.push({ path: "contact.name", problem: "invalid", message: "at most 200 characters" });
    wrong.push("contact.name is longer than 200 characters");
  }
  if (sent(c.email) && !clientEmail(c.email)) {
    fields.push({ path: "contact.email", problem: "invalid", message: NEEDS.email.shape });
    wrong.push(WRONG.email.shape);
  }
  if (typeof c.phone === "string" && c.phone.trim().length > 40) {
    fields.push({ path: "contact.phone", problem: "invalid", message: "at most 40 characters" });
    wrong.push("contact.phone is longer than 40 characters");
  }
  if (!fields.length) return null;
  return new WriteError("invalid_input", `${wrong.join("; ")}. Nothing was written.`, {
    fields,
    details: {
      reason: "client_details",
      item_type: type,
      missing: [],
      invalid: fields.map((f) => f.path.slice("contact.".length)),
    },
  });
}

/**
 * Throws `clientDetailsError` for a caller that must carry its client (`clientRequired`); the business's own
 * callers are held only to `contactShapeError`, and a person writing by email or on a form to nothing. The
 * details are judged trimmed; a test item (the caller's sandbox, or `test`) may name a made-up client.
 */
export function requireClient(
  caller: Caller,
  contact: Contact | undefined,
  type: ItemType,
  o: { readonly test?: boolean } = {},
): void {
  const error = clientRequired(caller)
    ? clientDetailsError(contact, type, { live: !(caller.sandbox || o.test === true) })
    : // A person by email, on a form or on the business's own page is never refused for their details.
      isCustomer(caller)
      ? null
      : contactShapeError(contact, type);
  if (error) throw error;
}
