/**
 * The spam filter's vocabulary (ADR-041). A request from a stranger is screened once, as it arrives,
 * into one of four verdicts; what decided it is kept as codes and numbers, never as words.
 */

/** The door a request came through, as the filter tells them apart. */
export type Door = "form" | "site_form" | "email" | "agent";

/** The three filters an owner switches on, one per kind of unwanted message. */
export type Filter = "pitches" | "scams" | "junk";
export const FILTERS: readonly Filter[] = ["pitches", "scams", "junk"];
export const isFilter = (value: unknown): value is Filter =>
  value === "pitches" || value === "scams" || value === "junk";

/** What a filter does with what it is sure of: put it aside, or only label it. */
export type FilterChoice = "aside" | "label";

/** Where a signal comes from: the free protection, one of the filters, or the AI check. */
export type Source = "basic" | Filter | "ai";

/**
 * What screening decided. `deliver`: as if there were no filter; `warn`: delivered, on Needs you,
 * with a label, and rules may only flag it; `hold`: kept until the sender confirms or a person lets
 * it in, nobody told; `aside`: under Spam, nobody told.
 */
export type Verdict = "deliver" | "warn" | "hold" | "aside";

/** `items.screen`. */
export type Screen = "pending" | "delivered" | "warned" | "held" | "aside" | "released";

/** The screen a verdict leaves on its item. */
export const SCREEN_OF: Readonly<Record<Verdict, Screen>> = {
  deliver: "delivered",
  warn: "warned",
  hold: "held",
  aside: "aside",
};

/**
 * One signal, as it is stored: its code, its points (`w`, negative for what speaks for the sender),
 * a measured value where one helps the owner's sentence (`v`: seconds, senders, requests), where it
 * came from (`f`), and whether it is certain on its own (`x`). Never a word of the message.
 */
export interface Signal {
  readonly c: string;
  readonly w: number;
  readonly v?: number | undefined;
  readonly f: Source;
  readonly x?: 1 | undefined;
  /** A domain the owner's sentence names (a look-alike, a link many senders share): a host name only. */
  readonly d?: string | undefined;
}

/** What the business's own form saw (`/p/…`, the embed, a connected WordPress form). */
export interface FormFacts {
  /** `none`: no key at all (the form was never drawn); `unsigned`: no secret to sign with. */
  readonly key: "none" | "valid" | "invalid" | "unsigned";
  /** When the form was drawn, from its key; absent when it cannot be known. */
  readonly drawnAt?: number | undefined;
  /** How long the visitor took, when the page that drew the form says (WordPress). */
  readonly elapsedMs?: number | undefined;
  /** The hidden field came back filled. */
  readonly trap: boolean;
  /** The same key came back with other words. */
  readonly replayed?: boolean | undefined;
}

/** What the email door read on a new email. */
export interface EmailFacts {
  /** A server it passed through marked it as spam (`spamVerdict`). */
  readonly serverMarked: boolean;
  /** What the receiving server found, when it said. */
  readonly auth?:
    | {
        readonly spf?: string | undefined;
        readonly dkim?: readonly string[] | undefined;
        readonly dmarc?: string | undefined;
      }
    | undefined;
  /** The From's display name, as written. */
  readonly displayName?: string | undefined;
  /** The Reply-To address, when it is not the From. */
  readonly replyTo?: string | undefined;
  /** The HTML part, for links that show one address and go to another. */
  readonly html?: string | undefined;
  readonly attachments?: { readonly count: number; readonly types: readonly string[] } | undefined;
}

/**
 * What a door hands the write path for the filter (`CreateInput.screen`). The agent's own facts —
 * its key, its level, what it presented — are on the caller and the identity already.
 */
export interface ScreenInput {
  readonly door: Door;
  readonly form?: FormFacts | undefined;
  readonly email?: EmailFacts | undefined;
}

/** The judge's answer after the code checked it. */
export interface CheckedAnswer {
  readonly kind: "customer" | "sales_pitch" | "scam" | "junk" | "unclear";
  readonly certainty: "low" | "medium" | "high";
  readonly customerIntent: boolean;
  readonly talksToFilter: boolean;
  readonly topic: string;
  /** Passages found word for word in what the judge was sent. */
  readonly quotes: readonly string[];
}

/** How the AI check went for one item. */
export type AiOutcome = "none" | "skipped" | "reused" | "judged" | "capped" | "failed";

/**
 * The kinds of handle a sender is known by here (never a client's network address). `agent_key` is an
 * agent's own key; `platform_key` a platform's (Web Bot Auth), which signs for every one of its users.
 */
export type HandleKind = "agent_key" | "platform_key" | "pass" | "mailbox" | "mail_domain" | "carried_for";

export interface Handle {
  readonly kind: HandleKind;
  readonly ref: string;
}

/** Signals that alone reach the aside band. */
export const CERTAIN = new Set(["trap", "no_key", "server_marked", "blocked", "wave", "like_marked", "many_new"]);

/** Certain signals a sender's own confirmation does not undo, and whose request gets no acknowledgement. */
export const NO_PROOF = new Set(["trap", "no_key", "server_marked", "blocked", "wave", "like_marked"]);

/** The item types the filter screens; a refund is a customer's about their own order, never screened. */
export const SCREENED_TYPES = new Set(["message", "quote_request", "booking", "order"]);

/** Points at which a request is labelled, and at which it is put aside or held. */
export const WARN_AT = 3;
export const ASIDE_AT = 6;

/** The UTC day of a moment: what counters and handles are kept by. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** How long a filter's learning week lasts, and how long off-and-on again keeps it. */
export const LEARNING_MS = 7 * 86_400_000;
export const LEARNING_KEPT_MS = 30 * 86_400_000;

/** How long the effects of a new item wait for its screening before they run anyway. */
export const SCREEN_DEADLINE_MS = 60_000;
