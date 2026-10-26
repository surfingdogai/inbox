import type { CatalogueStatus } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  catalogueBlockedWords,
  catalogueStatusLine,
  catalogueToast,
  productListingBody,
  skuOfferWords,
} from "../client/src/lib/catalogue";

/** The words Settings → Networks and the product editor say of the business's products on networks (ADR-029). */
const status = (over: Partial<CatalogueStatus> = {}): CatalogueStatus => ({
  listed: true,
  tax_included: null,
  blocked: null,
  counts: { listed: 212, needs_look: 3, kept_off: 1, off_sale: 4 },
  products: [],
  sku_offer: null,
  networks: [
    {
      origin: "https://network.surfingdog.ai",
      wants: true,
      told: true,
      offers_live: 209,
      held: 3,
      checked_at: "2026-10-26T10:42:00.000Z",
      error: null,
    },
  ],
  ...over,
});

describe("Your products on networks", () => {
  it("says what each network lists, holds back and when it last checked", () => {
    expect(catalogueStatusLine(status(), "UTC", "en-GB")).toBe("209 listed · 3 held · checked 10:42");
    expect(catalogueStatusLine(status({ networks: [] }), "UTC", "en-GB")).toBe("212 ready to list");
    const never = status({
      networks: [
        {
          ...status().networks[0],
          offers_live: null,
          held: 0,
          checked_at: null,
        } as CatalogueStatus["networks"][number],
      ],
    });
    expect(catalogueStatusLine(never, "UTC", "en-GB")).toBe("212 ready to list · not checked yet");
  });

  it("says why the switch cannot work", () => {
    expect(catalogueBlockedWords("out_of_directory")).toBe(
      "Your business is out of the networks' directories (Settings → Be found). Products are listed only with it.",
    );
    expect(catalogueBlockedWords("cannot_sign")).toBe(
      "Your inbox has no signing key yet, so networks cannot check the products came from you.",
    );
    expect(catalogueBlockedWords("no_network")).toBe("Switch a network on first.");
    expect(catalogueBlockedWords(null)).toBeNull();
  });

  it("toasts what switching on and off does", () => {
    expect(catalogueToast(true, status())).toBe(
      "On. Within an hour, networks show your 212 products that are ready. 3 need a look first.",
    );
    expect(catalogueToast(true, status({ counts: { listed: 1, needs_look: 0, kept_off: 0, off_sale: 0 } }))).toBe(
      "On. Within an hour, networks show your 1 product that is ready.",
    );
    expect(catalogueToast(false, status())).toBe(
      "Off. Networks stop showing your products now. Your own doors still take orders.",
    );
  });

  it("offers product codes that are barcodes once", () => {
    expect(skuOfferWords(412)).toBe("412 of your product codes are barcodes. Use them as barcodes too?");
    expect(skuOfferWords(1)).toBe("1 of your product codes is a barcode. Use it as its barcode too?");
  });
});

describe("the product editor's listing fields", () => {
  it("sends what the owner typed, empty as none", () => {
    expect(
      productListingBody({
        brand: " Bialetti ",
        mpn: "",
        condition: "used",
        url: "https://loja.example/moka",
        imageUrl: "",
        keptOff: true,
        noGtin: false,
      }),
    ).toEqual({
      brand: "Bialetti",
      mpn: null,
      condition: "used",
      url: "https://loja.example/moka",
      image_url: null,
      listed: false,
      no_gtin: false,
    });
  });
});
