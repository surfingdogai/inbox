/**
 * The page a link in the business's email opens (ADR-018 §5), as data: the adapter only turns it
 * into HTML, escaping every value. Everything on it is the business's, in the customer's language —
 * its name as the title, the terms, one button, the other answers of the same email — and nothing
 * names anyone else.
 */
export interface CustomerPage {
  /** The HTTP status to answer with. */
  readonly status: 200 | 404 | 409 | 410 | 422 | 429 | 500;
  readonly lang: "en" | "pt";
  /** The business's name: the header and the page title. Empty when it has none. */
  readonly business: string;
  /** The page title, when it is more than the business's name. */
  readonly title?: string | undefined;
  readonly heading: string;
  readonly paragraphs?: readonly string[] | undefined;
  /** Parts under headings of their own, after the paragraphs (the page about the network). */
  readonly sections?: readonly PageSection[] | undefined;
  /** The terms, one row each: what, when, price, total, until when. */
  readonly rows?: readonly { readonly label: string; readonly value: string }[] | undefined;
  /** The business's own words about it (the note it wrote, the question it asked), shown as a quote. */
  readonly quote?: string | undefined;
  readonly form?: PageForm | undefined;
  /** A refusal of what was just sent, above the form. */
  readonly error?: string | undefined;
  /** The other answers of the same email, as plain links. */
  readonly links?: { readonly lead?: string | undefined; readonly items: readonly PageLink[] } | undefined;
  /** Earlier / later, for the list of free times. */
  readonly nav?: readonly PageLink[] | undefined;
  readonly footer: string;
  readonly help: string;
}

export interface PageSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly links?: readonly PageLink[] | undefined;
}

export interface PageLink {
  readonly label: string;
  readonly href: string;
}

export interface PageForm {
  /** Where the form posts: this page when absent. */
  readonly action?: string | undefined;
  readonly hidden: Readonly<Record<string, string>>;
  readonly fields: readonly PageField[];
  readonly button: string;
}

export type PageField =
  | {
      readonly kind: "textarea";
      readonly name: string;
      readonly label: string;
      readonly required: boolean;
      readonly maxLength: number;
    }
  | {
      readonly kind: "times";
      readonly name: string;
      readonly label: string;
      readonly days: readonly {
        readonly day: string;
        readonly times: readonly { readonly value: string; readonly label: string }[];
      }[];
      /** Shown instead of the list when nothing is free. */
      readonly empty: string;
    };

/** What a POST to a link answers: see the page again (303), or this page. */
export type LinkActResult = { readonly redirect: string } | { readonly page: CustomerPage };
