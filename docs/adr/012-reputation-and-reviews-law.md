# ADR-012 — Reputation is advisory; reviews carry their rules

**Status:** accepted (21 Sep 2026). Research, not legal advice; a DPIA and counsel follow in a later release.

## Decision
- **Pseudonyms** are HMACs with a server-held secret, never a bare hash of an email or phone.
  They are still personal data (GDPR Art. 4(5), Recital 26, CJEU C-413/23 P).
- **The score is advisory.** Lookups return decayed counts per outcome code and a tier, never
  pass/fail and never a "decline" output. Terms ban solely automated declines; the human decision
  and its reason are recorded; a contest automatically restricts the data (Art. 18); explanations
  describe the procedure and what would change the result (C-203/22). Retention 12–18 months with
  half-lives as the storage-limitation mechanism; single-event weight capped; nothing feeds
  credit, housing or employment decisions.
- **Compliance work in a later release:** legitimate-interest assessment (Art. 6(1)(f)), DPIA (CNPD
  Regulation 1/2018 items 4–5), DPO notified to CNPD, Art. 14 notice delivered inside the receipt
  co-sign flow, Art. 26 joint-controller terms with businesses and Art. 28 processing terms,
  Cloudflare DPA on file with minimal personal data crossing the proxy and a DNS-only fallback.
- **Reviews:** a "How reviews work" notice (receipt verification, who may review, all reviews
  published including negatives, reveal window and timeout, aggregation, no sponsorship) linked
  from every review surface and returned in the API and MCP payload. "Verified" only as far as
  the co-signed receipt proves it, with logs. The consumer review publishes after the window even
  if the business never co-signs or reviews. Negatives are removed only for documented fraud, with
  a takedown log and a statement of reasons. Agent-filed reviews need the human's confirmation.
  Ranking parameters and their relative importance are disclosed to consumers and, in the business
  terms, to businesses; sponsored placement is labelled. Statements of reasons and 30-day notice
  before delisting a business.
- **DSA:** contact points, terms, notice-and-action and statements of reasons from day one; the
  rest of Section 3 is exempt while micro or small.

## Why
GDPR Article 22 via the SCHUFA ruling makes a score that businesses "draw strongly on" our
automated decision, with no Portuguese legal basis for it. The AI Act's social-scoring ban does
not reach a same-context, proportionate, rule-based reliability score (Commission guidelines
C(2025) 5052 ¶175–177), and a human-authored formula is likely not an AI system at all, but the
proportionality limb is live: one no-show must never mean network-wide exclusion. UCPD Art. 7(6)
and the Portuguese transposition (DL 109-G/2021, ASAE) make the review-process notice the first
thing an enforcer checks; P2B (DL 68/2023, ANACOM) applies once businesses accept our terms.
