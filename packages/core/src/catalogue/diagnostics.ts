import { gtinDisplay, isPlaceholderTitle, normaliseGtin } from "@surfingdog/spec";
import type { ProductRow } from "./publish";

/**
 * What needs a look (ADR-029, Track 1): plain words for the owner beside each product, Merchant
 * Center style, computed on read and never stored. A barcode that did not pass the check and why, a
 * barcode the owner's AI proposed, why a product is on no network, and each network's own reason for
 * holding one back. Pictures, descriptions, ranges and unit prices come later.
 */

export type NoteCode =
  | "gtin_check_digit"
  | "gtin_length"
  | "gtin_spreadsheet"
  | "gtin_restricted"
  | "gtin_coupon"
  | "gtin_not_digits"
  | "gtin_all_zero"
  | "gtin_proposed"
  | "price_missing"
  | "price_zero"
  | "sample_name"
  | "network_held";

export interface ProductNote {
  readonly code: NoteCode;
  readonly words: string;
  /** What the owner can do about it in one tap, where there is one. */
  readonly action?: "confirm_barcode";
}

/** A network's reason for holding one product back, from its answer to a signed ping. */
export interface HeldReason {
  readonly network: string;
  readonly why: string;
}

type NoteRow = Pick<ProductRow, "name" | "price" | "active" | "listed" | "source" | "gtin" | "gtinGiven">;

function barcodeNote(given: string): ProductNote | null {
  const r = normaliseGtin(given, "barcode");
  if ("ok" in r) {
    return {
      code: "gtin_proposed",
      words: `Your AI proposed the barcode ${gtinDisplay(r.ok.gtin14)}. Use it?`,
      action: "confirm_barcode",
    };
  }
  switch (r.problem) {
    case "check_digit":
      return {
        code: "gtin_check_digit",
        words: `The barcode ${given} does not add up: its last digit should be ${r.expected}. One digit is probably wrong; scan the pack to be sure. Listed without a barcode until then.`,
      };
    case "length":
      return {
        code: "gtin_length",
        words: `A barcode has 8, 12, 13 or 14 digits; ${given} has ${given.replace(/\D/g, "").length}. Listed without a barcode until it is fixed.`,
      };
    case "spreadsheet_number":
      return {
        code: "gtin_spreadsheet",
        words: `The barcode came in as ${given}: a spreadsheet turned it into a number and lost its last digits. Set that column to text, export it again and import it. Listed without a barcode until then.`,
      };
    case "restricted":
      return {
        code: "gtin_restricted",
        words: `${given} is a shop's own code, which works only where it was printed, so it is not used as a barcode. Use the barcode on the pack if it has one.`,
      };
    case "coupon":
      return { code: "gtin_coupon", words: `${given} is a coupon or receipt number, not a product's barcode.` };
    case "not_digits":
      return {
        code: "gtin_not_digits",
        words: `The barcode ${given} has more than digits in it. Listed without a barcode until it is fixed.`,
      };
    case "all_zero":
      return {
        code: "gtin_all_zero",
        words: `The barcode ${given} is all zeros. Listed without a barcode until it is fixed.`,
      };
    default:
      return null;
  }
}

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** One product's notes, in the order the owner should read them. */
export function productNotes(row: NoteRow, held: readonly HeldReason[]): ProductNote[] {
  const out: ProductNote[] = [];
  if (row.gtinGiven) {
    const note = barcodeNote(row.gtinGiven);
    // A proposal shows even beside a barcode it would replace; a problem only where there is none.
    if (note && (note.code === "gtin_proposed" || !row.gtin)) out.push(note);
  }
  if (row.price.value <= 0) {
    if (row.active !== 1 && row.source !== "builtin") {
      out.push({ code: "price_missing", words: "No price yet, so it is on no network." });
    } else if (row.active === 1) {
      out.push({ code: "price_zero", words: "Priced at 0, so it is on no network." });
    }
  }
  if (row.active === 1 && isPlaceholderTitle(row.name)) {
    out.push({ code: "sample_name", words: "Its name looks like a template's sample." });
  }
  for (const h of held) {
    out.push({ code: "network_held", words: `${hostOf(h.network)} holds it back: ${h.why}` });
  }
  return out;
}

/** Why "Your products on networks" cannot work now, or null when it can. */
export type CatalogueBlocked = "out_of_directory" | "cannot_sign" | "no_network";

/** The owner's view of their products on networks (`GET /v1/owner/catalogue`). */
export interface CatalogueStatus {
  readonly listed: boolean;
  readonly tax_included: boolean | null;
  readonly blocked: CatalogueBlocked | null;
  readonly counts: {
    readonly listed: number;
    readonly needs_look: number;
    readonly kept_off: number;
    readonly off_sale: number;
  };
  /** Only the products with something to say, each with its notes. */
  readonly products: readonly { readonly id: string; readonly name: string; readonly notes: readonly ProductNote[] }[];
  /** The one-time offer to use imported products' codes that are barcodes as barcodes, while it stands. */
  readonly sku_offer: { readonly count: number } | null;
  readonly networks: readonly {
    readonly origin: string;
    readonly wants: boolean;
    readonly told: boolean | null;
    readonly offers_live: number | null;
    readonly held: number;
    readonly checked_at: string | null;
    readonly error: string | null;
  }[];
}

/** An imported product whose own code reads as a barcode and that has none yet: what the offer covers. */
export function skuIsBarcode(row: Pick<ProductRow, "source" | "sku" | "gtin" | "noGtin">): string | null {
  if (row.source === "builtin" || !row.sku || row.gtin || row.noGtin === 1) return null;
  const r = normaliseGtin(row.sku, "any");
  return "ok" in r ? r.ok.gtin14 : null;
}
