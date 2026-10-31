/**
 * "Add your website": one wording and one address for every place a business is offered a way into
 * the directory (the home page, /search, /network, the footer and the guides), and the words of the
 * page it leads to (src/pages/add.astro). The page builds nothing new; it puts side by side the ways
 * that already exist: the check, register_business from the business's own AI, the inbox, and the
 * owner's page at /b/<domain>/owner. test/add.node.test.ts holds every link to the one wording.
 */
import type { Faq } from "./faq";

/** The words of every link to the page, everywhere. */
export const ADD_LABEL = "Add your website";
export const ADD_HREF = "/add/";

/** Where an assistant connects to Surfing Dog Search, as the home page gives it. */
export const MCP_ADDRESS = "https://surfingdog.ai/mcp";

export const ADD_PAGE = {
  title: "Add your website to Surfing Dog Search · Surfing Dog",
  description:
    "Add your business's website to the directory AI assistants search: check it, or let your own AI register it. Listing is free; nobody can pay for a place.",
  h1: ADD_LABEL,
  lede: "Surfing Dog Search lists the businesses an AI assistant can already ask, book or buy from, each with its own doors. Listing is free, and nobody can pay for a place.",
} as const;

/** Its questions, on the page and in its FAQPage data in the same words. */
export const ADD_FAQS: readonly Faq[] = [
  {
    q: "Does it cost anything to be listed?",
    a: "No. Listing is free, and nobody can pay for a place: the directory's order comes from published rules.",
  },
  {
    q: "Why isn't my business listed?",
    a: "The directory lists businesses an AI assistant can already ask, book or buy from, through a door their site leads to. A site with only a phone, an email or a contact form isn't listed. A local business also needs its site to match public maps or registers, or to be claimed.",
  },
  {
    q: "Can I add a business that isn't mine?",
    a: "Anyone can check any website, and a check changes nothing about a listing. Only a business's owner can register, correct or hide it, by proving the domain is theirs.",
  },
  {
    q: "Can I list my products too?",
    a: "Yes, through an agent inbox of ours: it lists the products in its catalogue in Surfing Dog's product search unless you switch that off, while your business is in the directory.",
  },
  {
    q: "How do I take my business out?",
    a: "Opt out on our crawler's page: the crawl stops, everything found on your site is deleted, and an entry nobody claimed goes with it. An entry you claimed, you take out with its claim token or a proof as strong as your claim.",
  },
];
