/**
 * Every blog post's animated cover, by the name its front matter gives in `coverAnim`. Each one
 * explains its post in a short loop, is drawn the way HeroFlow.astro is (inline SVG composed at
 * rest, so the box is never empty), and stops when nobody is looking.
 */
import CoverFlood from "./CoverFlood.astro";
import CoverNetworks from "./CoverNetworks.astro";
import CoverOpen from "./CoverOpen.astro";
import CoverReceipts from "./CoverReceipts.astro";

export const coverAnims = {
  receipts: CoverReceipts,
  flood: CoverFlood,
  networks: CoverNetworks,
  open: CoverOpen,
} as const;
