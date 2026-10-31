import { CARD_BRANDS, doorPlace, PAYMENTS_VOCABULARY, paymentLabel } from "@surfingdog/spec";
import { copyFor } from "../customer/copy";
import { dayText, localDate, moneyIn, timeText, zoneName } from "../customer/format";
import { frontCopy } from "../customer/front-copy";
import type { CustomerLang } from "../customer/lang";
import type { CustomerPage, LinkActResult, PageField, PageLink, PageSection } from "../customer/page";
import { ulid } from "../ids";
import { readSettings } from "../settings/schema";
import { drawFormKey, readFormKey, trapNameOf, trapRoom } from "../spam/formkey";
import type { ScreenInput } from "../spam/types";
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
  if (p.model === "fixed" && p.value === 0) return f.free;
  const money = moneyIn({ value: p.value, currency: p.currency ?? "EUR" }, lang);
  return p.model === "from" ? f.from(money) : money;
}

function factsOf(s: Service, lang: CustomerLang): string {
  return [frontCopy(lang).minutes(s.durationMin), priceText(s, lang)].filter(Boolean).join(" · ");
}

/** The ways a person pays (methods and wallets): the ones the front page names. */
const PERSON_PAYMENTS = new Set([...PAYMENTS_VOCABULARY.methods, ...PAYMENTS_VOCABULARY.wallets]);

/**
 * How a visitor can pay, in the business's voice and the visitor's language (`settings.payments`, as published): the
 * ways a person pays, each card brand inside card, general words in lower case. "" when the owner ticked none.
 */
export function payLine(payments: readonly string[] | undefined, lang: CustomerLang): string {
  const f = frontCopy(lang);
  const shown = (payments ?? []).filter((t) => PERSON_PAYMENTS.has(t));
  const brands = shown.filter((t) => CARD_BRANDS.includes(t)).map(paymentLabel);
  const card = shown.includes("card");
  const names = shown
    .filter((t) => !(card && CARD_BRANDS.includes(t)))
    .map((t) => {
      const name = f.payNames[t] ?? paymentLabel(t);
      return t === "card" && brands.length ? `${name} (${brands.join(", ")})` : name;
    });
  return names.length ? f.payWith(names) : "";
}

/** The page every other one is built on: the business's name, its footer, the way back. */
async function base(caps: Capabilities, lang: CustomerLang, status: CustomerPage["status"] = 200) {
  const business = (await caps.getBusinessProfile()).name;
  return { status, lang, business, footer: business, help: "" } as const;
}

/**
 * The front page: what can be booked, and the other ways to ask. A kind the business takes
 * somewhere else (`settings.doorsElsewhere`) is a link there instead, named by its platform ("Book at
 * Fresha") or else by its host, exactly as the address names it (`doorPlace`): bookings at a booking
 * platform, orders in the business's own checkout. Quotes and messages stay here.
 */
export async function frontHome(caps: Capabilities, lang: CustomerLang): Promise<CustomerPage> {
  const f = frontCopy(lang);
  const profile = await caps.getBusinessProfile();
  const away = profile.doors_elsewhere ?? [];
  const bookAway = away.find((d) => d.item_type === "booking");
  const orderAway = away.find((d) => d.item_type === "order");
  const bookable = bookAway ? [] : (await servicesOf(caps)).filter((s) => s.price?.model !== "quote");
  const ask: PageLink[] = [
    { label: f.quoteLink, href: FRONT_PATHS.quote },
    { label: f.messageLink, href: FRONT_PATHS.message },
  ];
  const sections: PageSection[] = [
    ...(bookAway
      ? [
          {
            heading: f.bookHeading,
            paragraphs: [],
            links: [{ label: f.bookAt(doorPlace(bookAway)), href: bookAway.url }],
          },
        ]
      : bookable.length
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
        : []),
    ...(orderAway
      ? [
          {
            heading: f.orderHeading,
            paragraphs: [],
            links: [{ label: f.orderAt(doorPlace(orderAway)), href: orderAway.url }],
          },
        ]
      : []),
  ];
  // A place to stay that takes stays here says so as schema.org reads it (ADR-037 §6.4).
  const jsonLd = profile.item_types.includes("stay")
    ? await caps.stays.frontJsonLd(profile.domain ? `https://${profile.domain}/` : null)
    : null;
  return {
    ...(await base(caps, lang)),
    heading: f.heading,
    sections,
    links: { lead: sections.length ? f.or : undefined, items: ask },
    nav: [{ label: f.signIn, href: "/login" }],
    // How a visitor can pay, as the owner ticked it: one quiet line under the business's name.
    help: payLine(profile.payments, lang),
    ...(jsonLd ? { jsonLd } : {}),
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

/**
 * A once-per-form key, signed (ADR-041 §4.1): the same form sent twice (a double click, a reload)
 * makes one request, and the hidden field takes a name drawn from it. A form shown again (an error,
 * the confirm step) keeps the key it was drawn with.
 */
async function keyFor(
  caps: Capabilities,
  form: FrontForm,
  path: string,
  kind: string,
  now: number,
): Promise<{ readonly k: string; readonly trap: string }> {
  if (form.k && /^[0-9A-Za-z]{10,40}$/.test(form.k)) return { k: form.k, trap: await trapNameOf(caps.secrets, form.k) };
  return drawFormKey(caps.secrets, path, kind, now);
}

/** A page's own address, embedded or not: the form posts back to the same kind of page. */
const embedded = (path: string, embed: boolean | undefined) =>
  embed ? `${path}${path.includes("?") ? "&" : "?"}embed=1` : path;

/** The booking page: the service's facts, a week of free times, and who is booking. */
export async function frontBookView(
  caps: Capabilities,
  lang: CustomerLang,
  q: { readonly service?: string | undefined; readonly from?: string | undefined },
  opts: {
    readonly now?: number;
    readonly error?: string;
    readonly form?: FrontForm;
    readonly embed?: boolean | undefined;
  } = {},
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
  const key = await keyFor(caps, form, FRONT_PATHS.book, "booking", now);
  return {
    ...(await base(caps, lang, opts.error ? 422 : 200)),
    ...(opts.embed ? { embed: true } : {}),
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
      action: embedded(FRONT_PATHS.book, opts.embed),
      hidden: { service: service.id, k: key.k },
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
      trap: key.trap,
    },
    nav: [
      ...(startDay > today
        ? [{ label: words.earlier, href: embedded(`${here}&from=${iso(startDay - WEEK)}`, opts.embed) }]
        : []),
      { label: words.later, href: embedded(`${here}&from=${iso(startDay + WEEK)}`, opts.embed) },
      ...(opts.embed ? [] : [{ label: f.back, href: "/" }]),
    ],
  };
}

/** The quote and message pages: who is asking, and what they need. */
export async function frontAskView(
  caps: Capabilities,
  lang: CustomerLang,
  kind: "quote" | "message",
  opts: {
    readonly error?: string;
    readonly form?: FrontForm;
    readonly now?: number;
    readonly embed?: boolean | undefined;
  } = {},
): Promise<CustomerPage> {
  const f = frontCopy(lang);
  const words = kind === "quote" ? f.quote : f.message;
  const form = opts.form ?? {};
  const path = kind === "quote" ? FRONT_PATHS.quote : FRONT_PATHS.message;
  const key = await keyFor(caps, form, path, kind, opts.now ?? Date.now());
  return {
    ...(await base(caps, lang, opts.error ? 422 : 200)),
    ...(opts.embed ? { embed: true } : {}),
    heading: words.heading,
    paragraphs: [words.lead],
    error: opts.error,
    form: {
      action: embedded(path, opts.embed),
      hidden: { k: key.k },
      fields: [
        ...personFields(lang, form),
        { kind: "textarea", name: "text", label: words.what, required: true, maxLength: TEXT_MAX, value: form.text },
      ],
      button: f.send,
      trap: key.trap,
    },
    nav: opts.embed ? [] : [{ label: f.back, href: "/" }],
  };
}

/**
 * The page after a request: what happens next, the same whatever the spam filter made of it, with a
 * way to reach the business if nobody answers when it shows a public address or phone (ADR-041 §14).
 */
export async function frontSent(
  caps: Capabilities,
  lang: CustomerLang,
  kind: string,
  opts: { readonly embed?: boolean | undefined } = {},
): Promise<CustomerPage> {
  const f = frontCopy(lang);
  const k: FrontKind = kind === "quote" || kind === "message" ? kind : "booking";
  const legal = (await readSettings(caps.db)).commerce.legal;
  const email = legal.email || undefined;
  const phone = legal.phone || undefined;
  return {
    ...(await base(caps, lang)),
    ...(opts.embed ? { embed: true } : {}),
    heading: f.sent.heading,
    paragraphs: [f.sent[k], ...(email || phone ? [f.sent.safety({ email, phone })] : [])],
    nav: opts.embed ? [] : [{ label: f.back, href: "/" }],
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

/**
 * What the form says of itself, for the spam filter (ADR-041 §4.1): its key, when it was drawn, its
 * hidden field. Null when its hidden field came back filled and today's room for bots' requests is
 * used up: the visitor is thanked, and nothing more is kept.
 */
async function screenOf(
  caps: Capabilities,
  form: FrontForm,
  path: string,
  kind: string,
  now: number,
): Promise<{ readonly screen: ScreenInput; readonly key: string } | null> {
  const { facts, key } = await readFormKey(caps.secrets, form, path, kind);
  if (facts.trap && !(await trapRoom(caps.db, now))) return null;
  return { screen: { door: "form", form: facts }, key };
}

/**
 * Writes a request from the form under its key; one that comes back with other words under the same
 * key (a replayed key) is written under a new one, and says so.
 */
async function underKey<R>(
  read: { readonly screen: ScreenInput; readonly key: string },
  write: (key: string, screen: ScreenInput) => Promise<R>,
): Promise<R> {
  try {
    return await write(read.key, read.screen);
  } catch (error) {
    if (!(error instanceof WriteError && error.code === "idempotency_mismatch")) throw error;
    const form = read.screen.form ? { ...read.screen.form, replayed: true } : undefined;
    return write(ulid(), { ...read.screen, ...(form ? { form } : {}) });
  }
}

/**
 * A booking sent from the page. A priced service first shows the summary the person confirms (the
 * confirm step); their "yes" sends it again with that summary's fingerprint, and only then is the
 * booking written.
 */
export async function frontBookAct(
  caps: Capabilities,
  lang: CustomerLang,
  form: FrontForm,
  opts: { readonly now?: number; readonly embed?: boolean | undefined } = {},
): Promise<LinkActResult> {
  // Bookings taken at a platform are made there: the visitor is sent on, and nothing is written here.
  const elsewhere = await caps.doorElsewhere("booking");
  if (elsewhere) return { redirect: elsewhere };
  const f = frontCopy(lang);
  const now = opts.now ?? Date.now();
  const service = (await servicesOf(caps)).find((s) => s.id === form.service && s.price?.model !== "quote");
  if (!service)
    return {
      page: { ...(await base(caps, lang, 404)), heading: f.book.noService, nav: [{ label: f.back, href: "/" }] },
    };
  const again = (error: string) =>
    frontBookView(caps, lang, { service: service.id }, { now, error, form, embed: opts.embed });
  const sent = embedded(`${FRONT_PATHS.sent}?k=booking`, opts.embed);
  const read = await screenOf(caps, form, FRONT_PATHS.book, "booking", now);
  if (!read) return { redirect: sent };
  const who = person(lang, form);
  if ("error" in who) return { page: await again(who.error) };
  const start = Date.parse(form.start ?? "");
  if (!Number.isFinite(start) || start <= now) return { page: await again(f.book.pickTime) };
  const startTime = new Date(start).toISOString();
  const endTime = new Date(start + service.durationMin * 60_000).toISOString();
  const note = (form.note ?? "").slice(0, TEXT_MAX);
  try {
    await underKey(read, (key, screen) =>
      caps.createBooking(
        visitor(lang, key, now),
        {
          payload: { reservationFor: { serviceId: service.id, name: service.name }, startTime, endTime },
          contact: { name: who.name, email: who.email, locale: lang },
          ...(note ? { message: note } : {}),
          ...(form.terms_sha ? { terms_sha: form.terms_sha } : {}),
        },
        { screen },
      ),
    );
    return { redirect: sent };
  } catch (error) {
    if (error instanceof WriteError && error.code === "confirm_terms") {
      const details = error.details ?? {};
      const words = copyFor(lang).page.acceptTime;
      return {
        page: {
          ...(await base(caps, lang)),
          ...(opts.embed ? { embed: true } : {}),
          heading: f.book.confirmHeading,
          paragraphs: [String(details.summary ?? "")].filter(Boolean),
          form: {
            action: embedded(FRONT_PATHS.book, opts.embed),
            hidden: {
              service: service.id,
              start: startTime,
              name: who.name,
              email: who.email,
              note,
              k: read.key,
              terms_sha: String(details.terms_sha ?? ""),
            },
            fields: [],
            button: words.buttonPriced,
            trap: await trapNameOf(caps.secrets, read.key),
          },
          nav: [
            {
              label: f.back,
              href: embedded(`${FRONT_PATHS.book}?service=${encodeURIComponent(service.id)}`, opts.embed),
            },
          ],
        },
      };
    }
    // Taken since the page was drawn, or no longer bookable (the notice, the hours): another time.
    if (error instanceof WriteError && (error.code === "slot_taken" || error.code === "guard_failed")) {
      return { page: await again(f.book.timeTaken) };
    }
    // Not a time the business offers any more (ADR-043 §2): the refusal names the nearest free ones.
    const reason = error instanceof WriteError ? error.details?.reason : undefined;
    if (error instanceof WriteError && (reason === "outside_hours" || reason === "time_not_free")) {
      return { page: await again(error.message) };
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
  opts: { readonly now?: number; readonly embed?: boolean | undefined } = {},
): Promise<LinkActResult> {
  const f = frontCopy(lang);
  const now = opts.now ?? Date.now();
  const sent = embedded(`${FRONT_PATHS.sent}?k=${kind}`, opts.embed);
  const read = await screenOf(caps, form, kind === "quote" ? FRONT_PATHS.quote : FRONT_PATHS.message, kind, now);
  if (!read) return { redirect: sent };
  const who = person(lang, form);
  const text = (form.text ?? "").slice(0, TEXT_MAX);
  if ("error" in who || !text) {
    return {
      page: await frontAskView(caps, lang, kind, {
        error: "error" in who ? who.error : f.missing,
        form,
        now,
        embed: opts.embed,
      }),
    };
  }
  const contact = { name: who.name, email: who.email, locale: lang };
  await underKey(read, async (key, screen) => {
    const caller = visitor(lang, key, now);
    if (kind === "quote") {
      const what = text.split("\n")[0]?.slice(0, 120) || f.quote.heading;
      return caps.requestQuote(
        caller,
        { payload: { itemOffered: { name: what }, description: text }, contact },
        { screen },
      );
    }
    return caps.sendMessage(caller, { body: text, contact }, { screen });
  });
  return { redirect: sent };
}

/**
 * The origins that may frame the business's form on their pages (ADR-041 §4.1): the business's own
 * website, with and without `www.`, and its own domain; on a hosted inbox, the site its host names.
 * Empty: nobody may.
 */
export async function embedAncestors(caps: Capabilities, hostSite?: string | null): Promise<string[]> {
  const settings = await readSettings(caps.db);
  const profile = await caps.getBusinessProfile();
  const out = new Set<string>();
  const add = (host: string) => {
    const h = host.toLowerCase().replace(/^www\./, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return;
    out.add(`https://${h}`);
    out.add(`https://www.${h}`);
  };
  if (hostSite) {
    try {
      add(new URL(hostSite).hostname);
    } catch {
      // not a site
    }
    return [...out];
  }
  if (settings.directory.url) {
    try {
      add(new URL(settings.directory.url).hostname);
    } catch {
      // not a site
    }
  }
  if (profile.domain) add(profile.domain);
  return [...out];
}
