/**
 * What every language's dictionary holds (src/i18n/<lang>.ts): the words of the free tools' hub and
 * of the three guides that go with the tools, written in that language rather than translated word for
 * word, and the few words of the frame around them (the bar, the footer, the language row).
 *
 * A sentence may carry `code` and [words](target) links (src/lib/inline.ts). A target is a path, an
 * https address, or a reference resolved in the page's language (src/lib/local.ts): @<page id>,
 * @tool:<tool id>, @guide:<guide slug> (the English checklist guides), @start (the inbox's sign-up).
 *
 * Limits the tests hold every language to (test/i18n.node.test.ts): a title of at most 60
 * characters, a description of at most 155, a question's answer of at most 50 words, plain text in
 * answers, and no claim of being first, only or best.
 */
import type { Faq } from "../lib/faq";
import type { GuideSlug } from "../lib/guides";
import type { Lang, LocalGuideId, ToolId } from "../lib/i18n";

/** What a page is called and says before anything else. */
export interface Head {
  /** The <title>, at most 60 characters. */
  readonly title: string;
  /** The meta description, at most 155 characters. */
  readonly description: string;
  readonly h1: string;
  /** One or two sentences under the heading. */
  readonly intro: string;
  /** The page's name in lists, breadcrumbs and links. */
  readonly short: string;
  /** The social card's one idea, as a person would say it; \n is where the line breaks. */
  readonly idea: string;
  /** What the page's animation shows, for a reader who can't see it. */
  readonly coverAlt: string;
}

/** A step of a how-to: a few words, then what to do. */
export interface Step {
  readonly name: string;
  readonly text: string;
}

export interface ValidateGuide extends Head {
  /** The checker's form at the top: it asks the network's check, opened on the llms.txt finding. */
  readonly form: {
    readonly title: string;
    readonly label: string;
    /** A website a business in this language might have, as the field's example. */
    readonly placeholder: string;
    readonly button: string;
    readonly note: string;
  };
  readonly stepsH: string;
  readonly steps: readonly Step[];
  /**
   * "Send these steps to my web person": a mailto, no account, nothing stored. `validator` stands in
   * for the validator step in the e-mail, which has no "top of this page": {url} is the checker's.
   */
  readonly mail: {
    readonly label: string;
    readonly subject: string;
    readonly intro: string;
    readonly validator: string;
    readonly outro: string;
  };
  readonly errorsH: string;
  readonly errorsCols: readonly [string, string];
  readonly errors: readonly { readonly problem: string; readonly fix: string }[];
  readonly sampleH: string;
  readonly sampleIntro: string;
  /** A short, valid llms.txt in this language. */
  readonly sample: string;
  readonly sampleMore: string;
  readonly limitsH: string;
  readonly limits: readonly string[];
  /** The animation's few words. */
  readonly cover: {
    readonly line: string;
    readonly name: string;
    readonly summary: string;
    readonly link: string;
    readonly verdict: string;
  };
  readonly faqs: readonly Faq[];
}

export const KIND_IDS = [
  "restaurant",
  "salon",
  "clinic",
  "shop",
  "trades",
  "stay",
  "classes",
  "professional",
  "template",
] as const;
export type KindId = (typeof KIND_IDS)[number];

export interface ExampleKind {
  readonly id: KindId;
  /** One or two words, for the row of anchors. */
  readonly label: string;
  /** The section's heading: the kind of business. */
  readonly name: string;
  /** One line on what this example shows. */
  readonly note: string;
  /** The file itself: valid llms.txt, every address on a reserved .example domain. */
  readonly file: string;
}

export interface ExamplesGuide extends Head {
  /** That every name and address is made up. */
  readonly made: string;
  readonly jump: string;
  readonly kinds: readonly ExampleKind[];
  readonly howH: string;
  readonly how: readonly string[];
  readonly generator: string;
  readonly doorsH: string;
  /** The "For AI agents" section; its one quiet line on the inbox links @start once. */
  readonly doors: readonly string[];
  readonly faqs: readonly Faq[];
}

export interface PaymentsGuide extends Head {
  /** The answer in short: at most 50 words. */
  readonly answer: string;
  readonly kindsH: string;
  readonly kinds: readonly { readonly name: string; readonly says: string }[];
  readonly kindsSource: string;
  readonly stepsH: string;
  readonly steps: readonly string[];
  readonly standardsH: string;
  readonly standardsCols: readonly [string, string];
  readonly standards: readonly { readonly name: string; readonly what: string; readonly href?: string }[];
  readonly standardsNote: string;
  readonly doH: string;
  readonly do: readonly string[];
  /** Live counts from /v1/stats, dated by its as_of; nothing printed that was not read. */
  readonly counts: {
    readonly h: string;
    /** {pay} and {checked} are numbers, {date} the day they were counted. */
    readonly line: string;
    readonly link: string;
    readonly wait: string;
    readonly none: string;
  };
  /** What the words mean on a bank statement, where people search them that way. */
  readonly statement?: { readonly h: string; readonly text: string };
  readonly next: string;
  readonly cover: {
    readonly assistant: string;
    readonly person: string;
    readonly business: string;
    readonly approve: string;
    readonly token: string;
    readonly paid: string;
  };
  readonly faqs: readonly Faq[];
}

export interface ToolsHub extends Head {
  readonly toolsH: string;
  readonly tools: Readonly<Record<ToolId, { readonly name: string; readonly line: string }>>;
  /** The manifest and receipt check at /spec/check/, in English. */
  readonly spec: { readonly name: string; readonly line: string };
  readonly guidesH: string;
  /** One line for each translated guide; its name is the guide's own `short`. */
  readonly guides: Readonly<Record<LocalGuideId, string>>;
  /** The readiness checklist, eight guides in English, named in this language. */
  readonly checklist: {
    readonly name: string;
    readonly line: string;
    readonly names: Readonly<Record<GuideSlug, string>>;
  };
  readonly end: string;
  readonly cover: { readonly site: string };
}

export interface Ui {
  readonly skip: string;
  /** The language row's label, for screen readers. */
  readonly langs: string;
  readonly home: string;
  readonly inShort: string;
  readonly questions: string;
  readonly related: string;
  /** "Updated {date}". */
  readonly updated: string;
  readonly copy: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly wholeSite: string;
  /** What the whole-site check shows, after its link. */
  readonly wholeSiteLine: string;
  readonly getInbox: string;
  /** The words of the bar and the footer, by their English words. */
  readonly nav: Readonly<Record<string, string>>;
}

export interface Dict {
  readonly lang: Lang;
  readonly ui: Ui;
  readonly hub: ToolsHub;
  readonly validate: ValidateGuide;
  readonly examples: ExamplesGuide;
  readonly payments: PaymentsGuide;
}
