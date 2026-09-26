/**
 * Words the business never says to a customer (ADR-018 §5): the customer wrote to the business and
 * meets only the business, so nothing they read names the software, a network, an offer, a key, a
 * draft, a rule, a limit, a floor or their standing. The inbox's own copy is walked against these by
 * `test/customer-copy.test.ts`; words the owner writes for customers to read (a reward's line) are
 * checked against them when saved.
 */
export const FORBIDDEN_WORDS: readonly RegExp[] = [
  /surfing/i,
  /\binbox\b/i,
  /network/i,
  /\brede\b/i,
  /\bpass\b/i,
  /\bpasse\b/i,
  /\bkey\b/i,
  /\bchave\b/i,
  /receipt/i,
  /recibo/i,
  /\boffer/i,
  /\boferta/i,
  /\bdraft/i,
  /rascunho/i,
  /\brules?\b/i,
  /\bregras?\b/i,
  /\blimit/i,
  /\blimite/i,
  /\bfloor\b/i,
  /preço mínimo/i,
  /\btier\b/i,
  /\bscore/i,
  /\bpontua/i,
  /reputa/i,
  /\brecord\b/i,
  /\bhist[oó]ri/i,
];

/** The first forbidden word in `text`, as written, or null. */
export function forbiddenWordIn(text: string): string | null {
  for (const word of FORBIDDEN_WORDS) {
    const m = word.exec(text);
    if (m) return m[0];
  }
  return null;
}
