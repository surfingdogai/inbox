/** Who runs Surfing Dog, as the Portuguese commercial register records it. Every legal page names it. */
export const COMPANY = {
  name: "Surfing Dog, Lda",
  nipc: "517113325",
  country: "Portugal",
} as const;

/** The line under each legal page's date. No postal address is published. */
export const COMPANY_LINE = `${COMPANY.name}, ${COMPANY.country}, NIPC ${COMPANY.nipc}.`;
