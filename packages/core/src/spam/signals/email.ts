import { SHARED_MAIL_PROVIDERS } from "../data";
import { emailDomain, foldConfusables, registrableDomain } from "../normalise";
import type { EmailFacts, Signal } from "../types";

/**
 * What a new email tells (ADR-029 §5): a server that marked it, what the receiving server found of
 * its sender, a display name that names someone else, the business's own name used from outside, and
 * answers that would go elsewhere. Signed-in mail is not trust: an email that passes DMARC can still
 * be a pitch, so authentication only ever takes a point off, and never waves anything through.
 */

const ADDRESS_OR_DOMAIN = /[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}|\b[a-z0-9-]{2,}(?:\.[a-z0-9-]{2,})*\.[a-z]{2,}\b/gi;

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
  const alignedDkim = dkim.some(
    (d) => d === fromDomain || fromDomain.endsWith(`.${d}`) || registrableDomain(d) === fromReg,
  );
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
    const brand = brandOf(business.name);
    const nameFolded = foldConfusables(name).toLowerCase();
    // The business's whole name, as words of their own, or the whole local part: a customer whose
    // name shares a word with the business's ("Maria Rossi" writing to "Rossi Bakery") never counts.
    const usesName =
      brand.length >= 5 &&
      (squash(nameFolded) === brand || wholeWords(nameFolded, business.name) || squash(local) === brand);
    const usesDomain = own.some((d) => {
      const label = d.split(".")[0] ?? "";
      return d.length > 0 && (nameFolded.includes(d) || (label.length >= 5 && squash(local).startsWith(label)));
    });
    if (usesName || usesDomain) out.push({ c: "poses_as_us", w: 3, f: "basic" });
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
