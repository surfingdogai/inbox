import type { Signal } from "./types";

/**
 * Why something is under Spam or Held, or carries a label, in the owner's words (ADR-041 §11.2).
 * Built from codes, numbers and host names only: the owner reads our sentences and the passages the
 * code found in the message, never a model's prose. Each cause has a chip (a few words on the row)
 * and a sentence (on the item).
 */

const TOPIC_PITCH: Readonly<Record<string, string>> = {
  seo: "SEO",
  links_guest_posts: "links and guest posts",
  web_design: "a website",
  apps_software: "apps and software",
  marketing_ads: "ads and marketing",
  leads: "leads",
  reviews_for_sale: "reviews",
  social_media: "social media",
  finance: "loans and funding",
  outsourcing: "outsourcing",
};

const TOPIC_SCAM: Readonly<Record<string, string>> = {
  invoice_payment: "an invoice or payment demand",
  bank_details: "asks to change bank details",
  account_notice: "a fake account notice",
  domain_listing: "a fake domain or listing notice",
  legal_copyright: "a fake legal notice",
  review_threat: "a review threat",
  overpayment: "an overpayment story",
  prize_job: "a prize or job offer",
  sign_in_link: "a link to a sign-in page",
};

export const CHIPS: Readonly<Record<string, string>> = {
  trap: "Filled by a bot",
  no_key: "Not sent from your form",
  too_fast: "Sent too fast",
  key_invalid: "Old or forged form",
  key_replayed: "Form sent twice",
  key_stale: "Old form",
  name_link: "Link in the name",
  markup: "Link markup",
  server_marked: "Marked by a mail server",
  dmarc_fail: "Sender not verified",
  display_other: "Name shows another address",
  poses_as_us: "Uses your name",
  lookalike: "Look-alike address",
  reply_elsewhere: "Answers go elsewhere",
  disposable: "Throwaway address",
  no_mail: "Address takes no mail",
  link_mismatch: "Disguised link",
  link_disguised: "Disguised link",
  shortener: "Short link",
  link_only: "Only links",
  many_links: "Many links",
  disguised_letters: "Disguised letters",
  invisible: "Hidden characters",
  talks_to_filter: "Instructions for an assistant",
  ai_talks_to_filter: "Instructions for an assistant",
  wave: "Sent many times",
  same_text: "Sent many times",
  near_same: "Sent many times",
  same_link_domain: "Same link, many senders",
  like_marked: "Like one you marked",
  many_new: "Many new requests",
  blocked: "You put this sender aside",
  pitches: "Sales pitch",
  scams: "May be a scam",
  junk: "Junk",
  bank_change_known: "Check before paying",
  learning: "Would have been put aside",
};

/** The chip a delivered item with a label carries. */
export const WARN_CHIPS: Readonly<Record<string, string>> = {
  pitches: "May be a sales pitch",
  scams: "May be a scam",
  junk: "May be junk",
  learning: "Would have been put aside",
  bank_change_known: "Check before paying",
};

export function chipOf(cause: string | null, warned = false): string {
  if (!cause) return "";
  return (warned ? WARN_CHIPS[cause] : undefined) ?? CHIPS[cause] ?? "Spam filter";
}

/** "Mon 26 Oct", in the business's time: the app's short date. */
function dayWords(ms: number, tz: string | undefined): string {
  const d = new Date(ms);
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" })
      .format(d)
      .replace(/,/g, "");
  try {
    return format(tz ?? "UTC");
  } catch {
    return format("UTC");
  }
}

/** The sentence for one signal, with what it measured. */
export function sentenceOf(
  s: Signal,
  ctx: {
    readonly topic?: string | undefined;
    readonly address?: string | undefined;
    /** The business's time zone, for a day named. */
    readonly tz?: string | undefined;
  } = {},
): string {
  const n = s.v ?? 0;
  switch (s.c) {
    case "trap":
      return "A field only bots can see was filled in.";
    case "no_key":
      return "It was sent without opening your form.";
    case "too_fast":
      return `Your form was filled in ${n} second${n === 1 ? "" : "s"}.`;
    case "key_invalid":
      return "It came from a form your page didn't draw, or one drawn before a change of keys.";
    case "key_replayed":
      return "Your form came back twice with different words.";
    case "key_stale":
      return "Your form was opened more than a day before it was sent.";
    case "name_link":
      return "The name field holds a link or an email address.";
    case "markup":
      return "It holds link markup a person wouldn't type.";
    case "server_marked":
      return "A mail server it passed through marked it as spam.";
    case "dmarc_fail":
      return "Its mail server couldn't show the email is from the address it names.";
    case "display_other":
      return "The sender's name shows a different address than the one it came from.";
    case "poses_as_us":
      return "It uses your business's name from an address that isn't yours.";
    case "lookalike":
      return `It looks like ${s.d ?? "your address"}, but isn't.`;
    case "reply_elsewhere":
      return "Answers would go to a different address than the sender's.";
    case "disposable":
      return "It came from a throwaway email address.";
    case "no_mail":
      return `This address may have a typo: ${s.d ?? "its domain"} takes no mail.`;
    case "link_mismatch":
      return "A link shows one address and goes to another.";
    case "link_disguised":
      return "A link hides where it goes.";
    case "shortener":
      return "It links through a link shortener.";
    case "link_only":
      return "It is little more than links.";
    case "many_links":
      return "It holds many links.";
    case "disguised_letters":
      return "A word in it mixes look-alike letters from another alphabet.";
    case "invisible":
      return "It hides invisible characters inside words.";
    case "talks_to_filter":
    case "ai_talks_to_filter":
      return "It contains instructions aimed at an assistant. Your assistant is told not to follow them.";
    case "wave":
    case "same_text":
    case "near_same":
      return `The same message came from ${n} senders this week.`;
    case "same_link_domain":
      return `${n} senders this week linked to ${s.d ?? "the same site"}.`;
    case "like_marked":
      return `It reads like a message you marked as spam on ${dayWords(n, ctx.tz)}.`;
    case "many_new":
      return `This sender made ${n} new requests today.`;
    case "blocked":
      return `You chose to put aside messages from ${ctx.address ?? "this sender"}.`;
    case "bank_change_known":
      return "Asks to change bank details. Confirm by phone before paying.";
    case "pitch_phrases":
    case "ai_kind":
      return kindSentence(s.f, ctx.topic);
    case "scam_phrases":
      return kindSentence("scams", ctx.topic);
    case "gibberish":
      return "It doesn't ask for anything you offer.";
    default:
      return "";
  }
}

/** A filter's sentence, with the topic the AI check named when it did. */
export function kindSentence(filter: string, topic?: string): string {
  if (filter === "pitches") {
    return `Sales pitch: ${(topic && TOPIC_PITCH[topic]) || "something you didn't ask for"}.`;
  }
  if (filter === "scams") return `Possible scam: ${(topic && TOPIC_SCAM[topic]) || "asks for money or details"}.`;
  if (filter === "junk") return "It doesn't ask for anything you offer.";
  return "";
}

/** What a warned item says in itself (§11.2): what it may be, and why it came anyway. */
export function warnSentence(cause: string | null): string {
  const what = cause === "pitches" ? "a sales pitch" : cause === "scams" ? "a scam" : cause === "junk" ? "junk" : null;
  return what ? `This may be ${what}. It came to you because the filter wasn't sure.` : "";
}

/** The owner's lines under "Why it's here": the strongest cause first, then the others. */
export function reasons(
  signals: readonly Signal[],
  ctx: {
    readonly topic?: string | undefined;
    readonly address?: string | undefined;
    readonly learning?: boolean;
    readonly tz?: string | undefined;
  } = {},
): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const ordered = [...signals].filter((s) => s.w > 0).sort((a, b) => (b.x ?? 0) - (a.x ?? 0) || b.w - a.w);
  for (const s of ordered) {
    const line = sentenceOf(s, ctx);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(lines.length === 0 && ctx.learning ? `Would have been put aside: ${line}` : line);
  }
  return lines;
}
