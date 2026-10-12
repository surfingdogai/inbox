/**
 * Questions a page answers in the open, and the FAQPage structured data made from the same words.
 * An answer is plain text, so what the page shows and what the data says are one string and can
 * never drift apart; a page puts its links beside the questions, not inside the answers.
 */
export interface Faq {
  readonly q: string;
  /** Plain text, at most 60 words: no markup, no Markdown. */
  readonly a: string;
}

/** A source for something a page says another company's product does, and when we read it. */
export interface Source {
  readonly label: string;
  readonly href: string;
}

/** The FAQPage for a page's visible questions, word for word. */
export function faqPage(faqs: readonly Faq[], url: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    url,
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}
