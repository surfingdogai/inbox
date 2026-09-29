import { copyFor } from "../customer/copy";
import { dayText, localDate, moneyIn, timeText, zoneName } from "../customer/format";
import { frontCopy } from "../customer/front-copy";
import type { CustomerLang } from "../customer/lang";
import type { CustomerPage, LinkActResult, PageField, PageLink } from "../customer/page";
import { ulid } from "../ids";
import type { Caller } from "../write/caller";
import { WriteError } from "../write/errors";
import type { Capabilities } from "./service";

/**
 * The business's own page (the web form door, ADR-010): what a person reads at the inbox's address.
 * Its services with how long they take and what they cost, a time to book, a quote to ask for, a
 * message to send, in the business's name and the visitor's language. Built as data here, written
 * out as HTML by the adapter, as the pages behind the links in its emails are.
 *
 * Every request goes through the same doors an agent uses (`createBooking`, `requestQuote`,
 * `sendMessage`), as an anonymous person on the `form` channel: the same rules, limits and confirm
 * step (a priced booking binds nobody until they confirmed its summary, CRD art. 8(2)), and the same
 * acknowledgement by email a minute later. Nothing here writes anywhere else.
 */

/** Where the page lives: the inbox's root for visitors, and these under `/p`. */
export const FRONT_PATHS = {
  home: "/",
  book: "/p/book",
  quote: "/p/quote",
  message: "/p/message",
  sent: "/p/sent",
} as const;

export type FrontKind = "booking" | "quote" | "message";

type Service = Awaited<ReturnType<Capabilities["listServices"]>>["items"][number];

const NAME_MAX = 200;
const EMAIL_MAX = 254;
const TEXT_MAX = 5_000;
const WEEK = 7 * 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The services a visitor can book, as the business lists them (at most fifty). */
async function servicesOf(caps: Capabilities): Promise<readonly Service[]> {
  return (await caps.listServices({ limit: 50 })).items;
}

function priceText(s: Service, lang: CustomerLang): string {
  const f = frontCopy(lang);
  const p = s.price;
  if (!p || p.model === "quote" || p.value === undefined) return p?.model === "quote" ? f.onRequest : "";
  const money = moneyIn({ value: p.value, currency: p.currency ?? "EUR" }, lang);
  return p.model === "from" ? f.from(money) : money;
}

function factsOf(s: Service, lang: CustomerLang): string {
  return [frontCopy(lang).minutes(s.durationMin), priceText(s, lang)].filter(Boolean).join(" · ");
}

/** The page every other one is built on: the business's name, its footer, the way back. */
async function base(caps: Capabilities, lang: CustomerLang, status: CustomerPage["status"] = 200) {
  const business = (await caps.getBusinessProfile()).name;
  return { status, lang, business, footer: business, help: "" } as const;
}

/** The front page: what can be booked, and the other ways to ask. */
export async function frontHome(caps: Capabilities, lang: CustomerLang): Promise<CustomerPage> {
  const f = frontCopy(lang);
  const services = await servicesOf(caps);
  const bookable = services.filter((s) => s.price?.model !== "quote");
  const ask: PageLink[] = [
    { label: f.quoteLink, href: FRONT_PATHS.quote },
    { label: f.messageLink, href: FRONT_PATHS.message },
  ];
  return {
    ...(await base(caps, lang)),
    heading: f.heading,
    sections: bookable.length
      ? [
          {
            heading: f.bookHeading,
            paragraphs: [],
            links: bookable.map((s) => ({
              label: f.serviceLine({ name: s.name, facts: factsOf(s, lang) }),
              href: `${FRONT_PATHS.book}?service=${encodeURIComponent(s.id)}`,
            })),
          },
        ]
      : [],
    links: { lead: bookable.length ? f.or : undefined, items: ask },
    nav: [{ label: f.signIn, href: "/login" }],
  };
}

/** What a form sent, as the adapter read it: every value a string, trimmed. */
export type FrontForm = Readonly<Record<string, string>>;

function personFields(lang: CustomerLang, form: FrontForm): PageField[] {
  const f = frontCopy(lang);
  return [
    {
      kind: "text",
      name: "name",
      label: f.fields.name,
      required: true,
      maxLength: NAME_MAX,
      value: form.name,
      autocomplete: "name",
    },
    {
      kind: "email",
      name: "email",
      label: f.fields.email,
      required: true,
      maxLength: EMAIL_MAX,
      value: form.email,
      autocomplete: "email",
    },
  ];
}

/** A once-per-form key: the same form sent twice (a double click, a reload) makes one request. */
const formKey = () => ulid();

/** The booking page: the service's facts, a week of free times, and who is booking. */
export async function frontBookView(
  caps: Capabilities,
  lang: CustomerLang,
  q: { readonly service?: string | undefined; readonly from?: string | undefined },
  opts: { readonly now?: number; readonly error?: string; readonly form?: FrontForm } = {},
): Promise<CustomerPage> {
  const f = frontCopy(lang);
  const now = opts.now ?? Date.now();
  const service = (await servicesOf(caps)).find((s) => s.id === q.service && s.price?.model !== "quote");
  if (!service)
    return { ...(await base(caps, lang, 404)), heading: f.book.noService, nav: [{ label: f.back, href: "/" }] };
  const { timezone } = await caps.getBusinessProfile();
  const today = Date.parse(`${localDate(now, timezone)}T00:00:00Z`);
  const asked = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? "") ? Date.parse(`${q.from}T00:00:00Z`) : Number.NaN;
  const startDay = Number.isFinite(asked) && asked > today ? asked : today;
  let slots: { startTime: string }[] = [];
  try {
    slots = (
      await caps.checkAvailability(
        {
          service_id: service.id,
          from: new Date(Math.max(startDay, now)).toISOString(),
          to: new Date(startDay + WEEK + 12 * 3_600_000).toISOString(),
        },
        { now },
      )
    ).slots
      .filter((s) => Date.parse(s.startTime) > now)
      .slice(0, 40);
  } catch {
    slots = [];
  }
  const days: { day: string; times: { value: string; label: string }[] }[] = [];
  for (const s of slots) {
    const day = dayText(s.startTime, timezone, lang);
    let group = days.find((d) => d.day === day);
    if (!group) {
      group = { day, times: [] };
      days.push(group);
    }
    group.times.push({ value: s.startTime, label: timeText(s.startTime, timezone, lang) });
  }
  const words = copyFor(lang).page.otherTime;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const here = `${FRONT_PATHS.book}?service=${encodeURIComponent(service.id)}`;
  const form = opts.form ?? {};
  const price = priceText(service, lang);
  return {
    ...(await base(caps, lang, opts.error ? 422 : 200)),
    heading: f.book.heading(service.name),
    paragraphs: [
      ...(service.description ? [service.description] : []),
      f.book.lead,
      f.book.zone(zoneName(timezone, lang, new Date(now))),
    ],
    rows: [
      { label: f.book.duration, value: f.minutes(service.durationMin) },
      ...(price ? [{ label: f.book.price, value: price }] : []),
    ],
    error: opts.error,
    form: {
      action: FRONT_PATHS.book,
      hidden: { service: service.id, k: form.k || formKey() },
      fields: [
        { kind: "times", name: "start", label: words.heading, days, empty: words.noneFree },
        ...personFields(lang, form),
        {
          kind: "textarea",
          name: "note",
          label: f.fields.note,
          required: false,
          maxLength: TEXT_MAX,
          value: form.note,
        },
      ],
      button: copyFor(lang).page.acceptTime.buttonFree,
      trap: true,
    },
    nav: [
      ...(startDay > today ? [{ label: words.earlier, href: `${here}&from=${iso(startDay - WEEK)}` }] : []),
      { label: words.later, href: `${here}&from=${iso(startDay + WEEK)}` },
      { label: f.back, href: "/" },
    ],
  };
}

/** The quote and message pages: who is asking, and what they need. */
export async function frontAskView(
  caps: Capabilities,
  lang: CustomerLang,
  kind: "quote" | "message",
  opts: { readonly error?: string; readonly form?: FrontForm } = {},
): Promise<CustomerPage> {
  const f = frontCopy(lang);
  const words = kind === "quote" ? f.quote : f.message;
  const form = opts.form ?? {};
  return {
    ...(await base(caps, lang, opts.error ? 422 : 200)),
    heading: words.heading,
    paragraphs: [words.lead],
    error: opts.error,
    form: {
      action: kind === "quote" ? FRONT_PATHS.quote : FRONT_PATHS.message,
      hidden: { k: form.k || formKey() },
      fields: [
        ...personFields(lang, form),
        { kind: "textarea", name: "text", label: words.what, required: true, maxLength: TEXT_MAX, value: form.text },
      ],
      button: f.send,
      trap: true,
    },
    nav: [{ label: f.back, href: "/" }],
  };
}

/** The page after a request: what happens next. */
export async function frontSent(caps: Capabilities, lang: CustomerLang, kind: string): Promise<CustomerPage> {
  const f = frontCopy(lang);
  const k: FrontKind = kind === "quote" || kind === "message" ? kind : "booking";
  return {
    ...(await base(caps, lang)),
    heading: f.sent.heading,
    paragraphs: [f.sent[k]],
    nav: [{ label: f.back, href: "/" }],
  };
}

/** An anonymous person on the web form, the way the other public doors describe a caller. */
function visitor(lang: CustomerLang, key: string, now: number): Caller {
  return {
    actor: { kind: "customer_human", id: `anon:${ulid(now)}`, channel: "form" },
    tier: "anonymous",
    sandbox: false,
    locale: lang,
    idempotency: { scope: "form", key },
    now: () => now,
  };
}

/** The person's name and address, or what is wrong with them. */
function person(lang: CustomerLang, form: FrontForm): { name: string; email: string } | { error: string } {
  const f = frontCopy(lang);
  const name = (form.name ?? "").slice(0, NAME_MAX);
  const email = (form.email ?? "").slice(0, EMAIL_MAX);
  if (!name || !email) return { error: f.missing };
  if (!EMAIL.test(email)) return { error: f.badEmail };
  return { name, email };
}

const keyOf = (form: FrontForm) => (/^[0-9A-Za-z]{10,40}$/.test(form.k ?? "") ? (form.k as string) : ulid());

/**
 * A booking sent from the page. A priced service first shows the summary the person confirms (the
 * confirm step); their "yes" sends it again with that summary's fingerprint, and only then is the
 * booking written.
 */
export async function frontBookAct(
  caps: Capabilities,
  lang: CustomerLang,
  form: FrontForm,
  opts: { readonly now?: number } = {},
): Promise<LinkActResult> {
  const f = frontCopy(lang);
  const now = opts.now ?? Date.now();
  const service = (await servicesOf(caps)).find((s) => s.id === form.service && s.price?.model !== "quote");
  if (!service)
    return {
      page: { ...(await base(caps, lang, 404)), heading: f.book.noService, nav: [{ label: f.back, href: "/" }] },
    };
  const again = (error: string) => frontBookView(caps, lang, { service: service.id }, { now, error, form });
  const who = person(lang, form);
  if ("error" in who) return { page: await again(who.error) };
  const start = Date.parse(form.start ?? "");
  if (!Number.isFinite(start) || start <= now) return { page: await again(f.book.pickTime) };
  const startTime = new Date(start).toISOString();
  const endTime = new Date(start + service.durationMin * 60_000).toISOString();
  const note = (form.note ?? "").slice(0, TEXT_MAX);
  try {
    await caps.createBooking(visitor(lang, keyOf(form), now), {
      payload: { reservationFor: { serviceId: service.id, name: service.name }, startTime, endTime },
      contact: { name: who.name, email: who.email, locale: lang },
      ...(note ? { message: note } : {}),
      ...(form.terms_sha ? { terms_sha: form.terms_sha } : {}),
    });
    return { redirect: `${FRONT_PATHS.sent}?k=booking` };
  } catch (error) {
    if (error instanceof WriteError && error.code === "confirm_terms") {
      const details = error.details ?? {};
      const words = copyFor(lang).page.acceptTime;
      return {
        page: {
          ...(await base(caps, lang)),
          heading: f.book.confirmHeading,
          paragraphs: [String(details.summary ?? "")].filter(Boolean),
          form: {
            action: FRONT_PATHS.book,
            hidden: {
              service: service.id,
              start: startTime,
              name: who.name,
              email: who.email,
              note,
              k: keyOf(form),
              terms_sha: String(details.terms_sha ?? ""),
            },
            fields: [],
            button: words.buttonPriced,
            trap: true,
          },
          nav: [{ label: f.back, href: `${FRONT_PATHS.book}?service=${encodeURIComponent(service.id)}` }],
        },
      };
    }
    // Taken since the page was drawn, or no longer bookable (the notice, the hours): another time.
    if (error instanceof WriteError && (error.code === "slot_taken" || error.code === "guard_failed")) {
      return { page: await again(f.book.timeTaken) };
    }
    if (error instanceof WriteError && error.code === "invalid_input") return { page: await again(f.missing) };
    throw error;
  }
}

/** A quote request or a message sent from the page. */
export async function frontAskAct(
  caps: Capabilities,
  lang: CustomerLang,
  kind: "quote" | "message",
  form: FrontForm,
  opts: { readonly now?: number } = {},
): Promise<LinkActResult> {
  const f = frontCopy(lang);
  const now = opts.now ?? Date.now();
  const who = person(lang, form);
  const text = (form.text ?? "").slice(0, TEXT_MAX);
  if ("error" in who || !text) {
    return { page: await frontAskView(caps, lang, kind, { error: "error" in who ? who.error : f.missing, form }) };
  }
  const caller = visitor(lang, keyOf(form), now);
  const contact = { name: who.name, email: who.email, locale: lang };
  if (kind === "quote") {
    const what = text.split("\n")[0]?.slice(0, 120) || f.quote.heading;
    await caps.requestQuote(caller, { payload: { itemOffered: { name: what }, description: text }, contact });
  } else {
    await caps.sendMessage(caller, { body: text, contact });
  }
  return { redirect: `${FRONT_PATHS.sent}?k=${kind}` };
}
