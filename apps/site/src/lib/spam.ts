import type { Faq, Source } from "./faq";
import type { GuideOption } from "./guides";

/**
 * The spam filter's pages (ADR-029 §13): /inbox/spam/, the guide on contact form spam, and the words
 * both share with the owner app's Settings → Spam. Plain words with no claim of rank, examples from
 * many countries, and what another company's product does dated and sourced.
 */

/** When the sources below were read. */
export const SPAM_CHECKED = "24 October 2026";

export const SPAM_PAGE = {
  path: "/inbox/spam/",
  title: "Spam filter for your inbox · Surfing Dog",
  description:
    "Sales pitches, scams and junk wait aside; real customers come straight in. Every choice is explained, and one tap undoes it.",
  heading: "Keep the pitches out. Keep every customer.",
  lede: "A spam filter for what your business gets by email, from your website and from AI agents. It explains every choice, and one tap undoes it.",
} as const;

/** The three filters, in the words Settings → Spam uses. */
export const SPAM_FILTERS: readonly { readonly title: string; readonly line: string }[] = [
  { title: "Sales pitches", line: "SEO, guest posts, websites, ads and leads you didn't ask for." },
  { title: "Scams", line: "False invoices, changed bank details, account and domain warnings, review threats." },
  { title: "Junk", line: "Random text, link lists, adult, gambling and crypto promotion." },
];

/** What the free protection stops, always on, on every door. */
export const SPAM_FREE: readonly string[] = [
  "Form bots: a hidden field filled in, a form never opened, one filled faster than anyone types.",
  "Mail a server on its way already marked as spam.",
  "Senders posing as you, and addresses made to look like yours.",
  "Disguised links: one address shown, another behind it.",
  "The same message, or the same link, from many senders at once.",
  "Floods of new requests from one sender.",
];

export const SPAM_LINES = {
  why: "Under Spam, each message carries a short label and a sentence saying why, and the words it found are quoted. Nothing a model wrote is shown: the reasons are the filter's own.",
  lost: "Bookings it doubts wait for the sender to confirm, and hold no time. Messages it puts aside are kept, and one tap brings them back.",
  form: "Put our form on any site, with no script and no puzzle for your customers. Or let your own website's forms pass what they receive to your inbox, with a key that can do nothing else.",
  yours:
    "No spam company's cloud, no sharing between businesses. Before anything is read by AI, email addresses, phone numbers and bank details are taken out.",
  cost: "Run it yourself: free, with your own AI model or none. Hosted: free for now; later, a small price for each filter you switch on, and we'll ask you beforehand.",
} as const;

export const SPAM_FAQS: readonly Faq[] = [
  {
    q: "Will I miss a customer?",
    a: "Nothing is refused, bounced or deleted for what it says. What it is sure of waits under Spam, explained. Bookings, orders and quote requests it doubts wait under Held, holding no time, until the sender confirms or you let them in. The rest reaches you, labelled if unsure. A sender flooding you with new requests is asked to retry later.",
  },
  {
    q: "What does a customer see?",
    a: "The same as without a filter: the same page after sending, the same email saying their request arrived, and the same answers to their assistant. A new customer's email asks them to confirm it is them; every new customer gets it, so it says nothing about the filter.",
  },
  {
    q: "Does it work in my language?",
    a: "Yes. Language, script, country, name, spelling and email provider are never reasons. It looks at how a message came and what it asks for. Its tests include more than 140 customer messages in 29 languages, short, rude, misspelled or machine-translated, and none of them is put aside.",
  },
  {
    q: "Which AI models can I use?",
    a: "On your own server, your own key from Anthropic, OpenAI or Google Gemini, or a model on your own server through a chat-completions API. Without one, the filters look for known phrases, nothing more. On a hosted inbox we pay for the model, and the filters look for phrases until reading by AI is switched on.",
  },
  {
    q: "Can an AI assistant still ask me for a price?",
    a: "Yes. An assistant asking for its person is a customer. A request that names what you offer is never put aside for its words alone, and an assistant that signs its requests or carries its person's pass is trusted more, never less.",
  },
  {
    q: "What about my WordPress forms?",
    a: "The inbox's WordPress plugin points AI agents at your inbox. Your form plugin's messages can reach the inbox through its forms door, with a key that may do nothing else; a developer connects it once. A plugin setting that does this for you is not built yet.",
  },
];

export const SPAM_SOURCES = {
  w3cCaptcha: {
    label: "W3C: Inaccessibility of CAPTCHA (Group Draft Note, 16 December 2021)",
    href: "https://www.w3.org/TR/turingtest/",
  },
  w3cHoneypots: {
    label: "W3C: Inaccessibility of CAPTCHA, §2.2.4 Honeypots",
    href: "https://www.w3.org/TR/turingtest/#honeypots",
  },
  recaptcha: {
    label: "Google Cloud: reCAPTCHA tiers and pricing",
    href: "https://docs.cloud.google.com/recaptcha/docs/compare-tiers",
  },
  akismet: { label: "Akismet: pricing", href: "https://akismet.com/pricing/" },
  owasp: {
    label: "OWASP: LLM01:2025 Prompt Injection",
    href: "https://genai.owasp.org/llmrisk/llm01-prompt-injection/",
  },
} as const satisfies Record<string, Source>;

/** The guide: how to stop contact form spam without losing customers. */
export const SPAM_GUIDE = {
  slug: "stop-contact-form-spam",
  title: "How to stop contact form spam without losing customers",
  description:
    "Hidden fields, time checks, CAPTCHAs, cloud checkers, filtering in your inbox and AI checks: what each costs, how each fails, and how to keep every real customer.",
  answer:
    "Combine a hidden field and a time check, which stop simple bots for free, with a filter that keeps what it catches instead of deleting it, explains why, and lets you undo it in one tap. Avoid anything that silently drops messages.",
} as const;

export const SPAM_GUIDE_OPTIONS: readonly GuideOption[] = [
  {
    way: "A hidden field",
    what: "Free and invisible to people: a field your page hides, which a bot fills in. It fails against a bot that reads the page as a person does, and against people paid to type pitches.",
    links: [SPAM_SOURCES.w3cHoneypots],
  },
  {
    way: "A time check",
    what: "Free: a form sent two seconds after it opened was not typed by hand. A page left open for days, or a browser that fills the form in, can look odd too, so treat the time as a hint, not a verdict.",
  },
  {
    way: "CAPTCHAs and challenges",
    what: "A script on your page and a puzzle for your customers, which shuts some people out, including many people with disabilities. Some services price it by volume past a free allowance. It does nothing against a person typing a pitch.",
    links: [SPAM_SOURCES.w3cCaptcha, SPAM_SOURCES.recaptcha],
  },
  {
    way: "Cloud spam checkers",
    what: "Your visitors' messages go to the checker's servers, and plans are priced by site and by checks a month. Look at where what it catches goes: whether you can see it, and bring it back.",
    links: [SPAM_SOURCES.akismet],
  },
  {
    way: "Filtering in your inbox (Surfing Dog Inbox, ours)",
    what: "Free protection on every door, three filters you switch on, and nothing a person wrote is deleted: what it catches waits under Spam or Held with its reason, one tap back. Open source; on your own server it is free, with your own AI model or none.",
    links: [
      { label: "The spam filter", href: "/inbox/spam/" },
      { label: "How it decides", href: "/docs/spam/" },
    ],
    ours: true,
  },
  {
    way: "An AI check",
    what: "Reads what a list of phrases can't, such as a pitch reworded a hundred ways. Each check costs money, and a message can try to give it instructions: send it masked text, check its answer in code, and never let it decide alone.",
    links: [SPAM_SOURCES.owasp],
  },
];

export const SPAM_GUIDE_FAQS: readonly Faq[] = [
  {
    q: "Should spam be deleted automatically?",
    a: "No. A filter is sometimes wrong, and a deleted customer is a lost one. Keep what it catches where you can see it, with the reason, for as long as you choose: for good, or a month or three.",
  },
  {
    q: "Do I need a CAPTCHA?",
    a: "Rarely, for a contact form. A hidden field and a time check stop simple bots without asking anything of your customers, and a puzzle does nothing against a person typing a sales pitch.",
  },
  {
    q: "Can I filter with AI without sending my customers' details away?",
    a: "Yes: take out email addresses, phone numbers and bank or card numbers before anything leaves, send just what the message says, and use a service that keeps nothing. Check the model's answer in code, so a message cannot talk it into anything.",
  },
];
