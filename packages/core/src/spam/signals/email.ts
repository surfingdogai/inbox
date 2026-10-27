import { SHARED_MAIL_PROVIDERS } from "../data";
import { emailDomain, foldConfusables, registrableDomain } from "../normalise";
import type { EmailFacts, Signal } from "../types";

/**
 * What a new email tells (ADR-041 §5): a server that marked it, what the receiving server found of
 * its sender, a display name that names someone else, the business's own name used from outside, and
 * answers that would go elsewhere. Signed-in mail is not trust: an email that passes DMARC can still
 * be a pitch, so authentication only ever takes a point off, and never waves anything through.
 */

const ADDRESS_OR_DOMAIN = /[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}|\b[a-z0-9-]{2,}(?:\.[a-z0-9-]{2,})*\.[a-z]{2,}\b/gi;

/** Whether a DKIM signature of the From's own domain came with the email. */
function alignedDkimOf(f: EmailFacts, from: string): boolean {
  const fromDomain = emailDomain(from) ?? "";
  if (!fromDomain) return false;
  const fromReg = registrableDomain(fromDomain);
  return (f.auth?.dkim ?? []).some(
    (d) => d === fromDomain || fromDomain.endsWith(`.${d}`) || registrableDomain(d) === fromReg,
  );
}

/**
 * Whether the receiving server found the From's own domain behind the email: DMARC passed, or a DKIM
 * signature of that domain, with DMARC not failing. What counts against an address's budget is kept
 * apart for mail without it, so forgeries under an address never spend its owner's.
 */
export function emailAuthenticated(f: EmailFacts | undefined, from: string): boolean {
  if (!f || f.auth?.dmarc === "fail") return false;
  return f.auth?.dmarc === "pass" || alignedDkimOf(f, from);
}

/** Words that make a name an office of the business rather than a person's: "Amélie Billing", "support.amelie". */
const ROLE_WORDS =
  /^(billing|support|admin|administration|accounts?|accounting|invoices?|invoicing|payments?|finance|security|helpdesk|help|service|team|office|noreply|no-reply|donotreply|bookings?|reservations?|orders?|sales)$/u;

export function emailSignals(
  f: EmailFacts,
  from: string,
  business: { readonly name: string; readonly domains: readonly string[] },
): Signal[] {
  const out: Signal[] = [];
  if (f.serverMarked) out.push({ c: "server_marked", w: 6, f: "basic", x: 1 });
  const fromDomain = emailDomain(from) ?? "";
  const fromReg = fromDomain ? registrableDomain(fromDomain) : "";
  const dkim = f.auth?.dkim ?? [];
  const alignedDkim = alignedDkimOf(f, from);
  // SPF alone says nothing: the business's own forward breaks it for every honest sender.
  if (f.auth?.dmarc === "fail") out.push({ c: "dmarc_fail", w: 2, f: "basic" });
  else if (f.auth?.dmarc === "pass" || alignedDkim) out.push({ c: "aligned", w: -1, f: "basic" });
  const name = (f.displayName ?? "").trim();
  if (name) {
    const named = [...name.matchAll(ADDRESS_OR_DOMAIN)].map((m) => {
      const v = m[0].toLowerCase();
      return registrableDomain(v.includes("@") ? (emailDomain(v) ?? v) : v);
    });
    if (named.some((d) => d && d !== fromReg)) out.push({ c: "display_other", w: 2, f: "basic" });
  }
  const own = business.domains.map((d) => registrableDomain(d));
  const fromOwn = own.includes(fromReg);
  if (!fromOwn && !alignedDkimFor(own, dkim)) {
    const local = (from.split("@")[0] ?? "").toLowerCase();
    if (posesAsUs(foldConfusables(name).toLowerCase(), local, business.name, own))
      out.push({ c: "poses_as_us", w: 3, f: "basic" });
  }
  const reply = f.replyTo ? emailDomain(f.replyTo) : null;
  if (reply) {
    const replyReg = registrableDomain(reply);
    const company = fromDomain && !SHARED_MAIL_PROVIDERS.has(fromDomain);
    const elsewhere =
      (company && SHARED_MAIL_PROVIDERS.has(reply)) ||
      (replyReg !== fromReg && !SHARED_MAIL_PROVIDERS.has(reply) && !SHARED_MAIL_PROVIDERS.has(fromDomain));
    if (elsewhere) out.push({ c: "reply_elsewhere", w: 2, f: "basic" });
  }
  return out;
}

function alignedDkimFor(own: readonly string[], dkim: readonly string[]): boolean {
  return dkim.some((d) => own.includes(registrableDomain(d)));
}

/**
 * Whether a display name or an address's local part passes for the business itself: its whole name
 * or its domain, alone or with an office's word ("billing", "support"), never a person's name that
 * merely holds it. "Maria Rossi" writing to "Rossi Bakery", or "Amélie Dupont" to a business called
 * "Amélie", is a customer. A business named by one word, often a first name, counts only with an
 * office's word beside it.
 */
function posesAsUs(display: string, local: string, businessName: string, own: readonly string[]): boolean {
  const brand = plain(brandOf(businessName));
  const single = words(businessName).length < 2;
  const displayWords = words(display);
  const localWords = local
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(plain);
  // What a name is once an office's words are taken out, and whether it had any.
  const rest = (ws: readonly string[]) => ws.filter((w) => !ROLE_WORDS.test(w));
  const role = (ws: readonly string[]) => ws.some((w) => ROLE_WORDS.test(w));
  const is = (ws: readonly string[], target: string) => {
    if (squashWords(rest(ws.map(plain))) !== target) return false;
    return !single || role(ws);
  };
  if (brand.length >= 5) {
    if (is(displayWords, brand) || is(localWords, brand)) return true;
    if (!single && wholeWords(display, businessName)) return true;
  }
  return own.some((d) => {
    if (!d) return false;
    // The business's whole domain written in the name ("kopisenja.example Billing").
    if (display.includes(d)) return true;
    const label = plain(squash(d.split(".")[0] ?? ""));
    if (label.length < 5) return false;
    // A domain that is the one-word name again is held to the one-word rule.
    const oneWord = single && label === brand;
    const left = rest(localWords);
    if (squashWords(left) !== label) return false;
    return !oneWord || role(localWords);
  });
}

/** Lower-case words of letters and digits, as folded. */
function words(text: string): string[] {
  return foldConfusables(text.normalize("NFKC"))
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Without accents: "amélie" → "amelie", so a name and an address compare. */
function plain(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "");
}

function squashWords(ws: readonly string[]): string {
  return ws.join("");
}

/** A business name as one run of letters and digits, lower case: "Café Maré" → "cafémaré". */
function brandOf(name: string): string {
  return squash(foldConfusables(name.normalize("NFKC")).toLowerCase());
}

/** Whether a text holds the business's name as words of their own. */
function wholeWords(text: string, businessName: string): boolean {
  const words = foldConfusables(businessName.normalize("NFKC"))
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length < 2) return false;
  const have = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let i = 0; i + words.length <= have.length; i++) {
    if (words.every((w, j) => have[i + j] === w)) return true;
  }
  return false;
}

function squash(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, "");
}
