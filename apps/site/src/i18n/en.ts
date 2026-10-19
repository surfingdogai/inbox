import type { Dict } from "./types";

/** English: the x-default, written for an owner anywhere in the world. */
export const en: Dict = {
  lang: "en",
  ui: {
    skip: "Skip to content",
    langs: "Languages",
    home: "Home",
    inShort: "In short",
    questions: "Questions",
    related: "Related",
    updated: "Updated {date}",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Select it instead",
    wholeSite: "Check your whole site",
    wholeSiteLine: "what an assistant can do with your business, and what's missing.",
    getInbox: "Get your agent inbox",
    nav: {},
  },

  hub: {
    title: "Free AI agent readiness tools and guides · Surfing Dog",
    description:
      "Free tools to check your llms.txt, robots.txt, MCP server, UCP and ACP profiles and agent inbox, with plain guides for small businesses. No sign-up.",
    h1: "Free tools for AI agent readiness",
    intro:
      "Check one thing, or your whole site. Each tool says what's missing and the exact fix, in plain words. No sign-up.",
    short: "Free tools",
    idea: "Check one thing,\nor your whole site.",
    coverAlt:
      "Seven small tiles, one for each free tool: the whole site, llms.txt, the llms.txt generator, robots.txt, MCP, UCP and ACP, and the agent inbox. A light visits each in turn.",
    toolsH: "Tools",
    tools: {
      check: {
        name: "AI agent readiness check",
        line: "Your whole site, read the way a customer's assistant would: what it can do there, and what's missing.",
      },
      "llms-txt": {
        name: "llms.txt checker and validator",
        line: "Each problem with its line number and the exact fix, then the doors your file leads agents to.",
      },
      "llms-txt-generator": {
        name: "llms.txt generator",
        line: "An llms.txt made from what your website already says, ready to edit, check and upload.",
      },
      "ai-crawlers": {
        name: "AI crawler checker",
        line: "Which AI companies' crawlers your robots.txt lets in, which may train on your pages, and the line that decides.",
      },
      "mcp-server": {
        name: "MCP server tester",
        line: "What your MCP server offers an assistant, checked against the current spec, without calling a tool.",
      },
      ucp: {
        name: "UCP and ACP checker",
        line: "Whether AI agents can find your shop's checkout profiles, and what's missing for them to buy.",
      },
      "agent-inbox": {
        name: "Agent inbox checker",
        line: "A business's agent inbox manifest, field by field against the published spec, and whether each door answers.",
      },
    },
    spec: {
      name: "Manifest and receipt check",
      line: "Paste an agent inbox manifest or a signed receipt and check it against the spec, in your browser.",
    },
    guidesH: "Guides",
    guides: {
      "validate-llms-txt": "Seven short steps, with the common errors and how to fix each one.",
      "llms-txt-examples": "Ready-to-copy files for a restaurant, a salon, a clinic, a shop, a trade and more.",
      "ai-agent-assisted-payments": "How an assistant pays for a person, the standards behind it, and what to do now.",
    },
    checklist: {
      name: "The AI agent readiness checklist",
      line: "eight guides, one for each thing the check counts.",
      names: {
        "ai-assistant-bookings": "Bookings",
        "sell-through-ai-assistants": "Selling",
        "ai-assistant-messages-and-quotes": "Messages and quotes",
        "ai-assistant-payments": "Payments",
        "business-details-for-ai": "Your details as data",
        "findable-agent-doors": "Findable doors",
        "llms-txt": "llms.txt",
        "robots-txt-ai-agents": "robots.txt",
      },
    },
    end: "Not sure where to start? [Check your whole site](@tool:check): it shows which of these matter for your business.",
    cover: { site: "site" },
  },

  validate: {
    title: "How to validate your llms.txt (step by step) · Surfing Dog",
    description:
      "Check your llms.txt in five minutes: open it, read the first line, fix the links, run a validator, see what Lighthouse says. With common errors and fixes.",
    h1: "How to validate your llms.txt",
    intro: "Seven short steps, in order. Most problems are on the first line or in the links.",
    short: "How to validate your llms.txt",
    idea: "Line 1 is your name.\nEvery link is [name](https://…).",
    coverAlt:
      "An llms.txt file is checked line by line. The name on line 1 and the summary pass; a bare address on line 5 becomes a Markdown link; then the file reads as an llms.txt.",
    form: {
      title: "Check your llms.txt now",
      label: "Your website",
      placeholder: "yourbusiness.com",
      button: "Check",
      note: "Free, no sign-up. We read your /llms.txt the way an assistant would, and show each problem with its line and the fix.",
    },
    stepsH: "Seven steps",
    steps: [
      {
        name: "Open it",
        text: "Open yoursite.com/llms.txt in a browser. You should see plain text, not your homepage or an error page.",
      },
      {
        name: "Check line 1",
        text: "Line 1 is your name after one #: `# Your Business`. It's the one line the format requires.",
      },
      {
        name: "Add a summary",
        text: "Below it, one line that starts with >: what you do, and where. Optional, but readers like it.",
      },
      {
        name: "Make every link a link",
        text: "Under each ## heading, one link per line: `- [Name](https://…): a short note`. Use full https addresses.",
      },
      {
        name: "Run a validator",
        text: "Put your website into the llms.txt checker at the top of this page, and fix each line it names.",
      },
      {
        name: "See what Lighthouse says",
        text: "Optional: in Chrome, open DevTools, then Lighthouse, tick the Agentic Browsing category and run it.",
      },
      {
        name: "Check again",
        text: "Upload the fixed file, then check again. A cache may show the old file for a little while.",
      },
    ],
    mail: {
      label: "Send these steps to my web person",
      subject: "Our llms.txt: seven checks",
      intro: "Hi,\n\nCould you check our llms.txt with these seven steps?",
      validator: "Put the website into {url} and fix each line it names.",
      outro: "The guide, with the common errors and fixes:",
    },
    errorsH: "Common errors and how to fix them",
    errorsCols: ["What you see", "The fix"],
    errors: [
      {
        problem: "Your homepage, or a “page not found” page, at /llms.txt",
        fix: "There's no file yet. Upload a file named llms.txt to your site's root, or turn it on in your platform.",
      },
      {
        problem: "Line 1 isn't `# Your name`",
        fix: "Make line 1 your business's name after one # and a space. Nothing but blank lines may come before it.",
      },
      {
        problem: "`- Menu: https://…`",
        fix: "Write it as a link: `- [Menu](https://…): lunch and dinner`. Chrome's Lighthouse fails a file with no Markdown link.",
      },
      {
        problem: "`###` headings, or a heading between your name and your sections",
        fix: "Keep one # line for your name, and use ## for every section.",
      },
      {
        problem: "`http://` or `/menu`",
        fix: "Use the full address with https: `https://yourbusiness.com/menu`.",
      },
      { problem: "A link leads to a missing page", fix: "Fix the address, or remove the line." },
      {
        problem: "Your robots.txt blocks /llms.txt",
        fix: "Allow it: readers that obey robots.txt won't fetch a blocked file. The [AI crawler checker](@tool:ai-crawlers) shows the line.",
      },
      {
        problem: "Error 403 or 429, or a “checking your browser” page",
        fix: "Your host or firewall stops readers. Ask it to let /llms.txt through.",
      },
      { problem: "Odd characters, such as Ã© instead of é", fix: "Save the file as UTF-8 plain text." },
    ],
    sampleH: "What a valid file looks like",
    sampleIntro: "Short, with your name first and one link per line:",
    sample: `# Crumb & Co. Bakery

> Bakery and café for sourdough, pastries and celebration cakes. Open every day from 7:00.

## Visit and order

- [Menu and prices](https://crumbandco.example/menu): breads, pastries and coffee
- [Order a cake](https://crumbandco.example/cakes): three days' notice
- [Opening hours and how to find us](https://crumbandco.example/visit)

## Optional

- [Our story](https://crumbandco.example/about)`,
    sampleMore: "[More examples](@llms-txt-examples): a restaurant, a salon, a clinic, a shop, a trade and more.",
    limitsH: "What a valid file does, and doesn't",
    limits: [
      "Google Search doesn't use llms.txt. Chrome's Lighthouse audits it, and some AI tools read it.",
      "A valid file helps an assistant read about you. To let it ask, book or order, you need a door: a tool, an API or an [agent inbox](@start) that takes the request. More in [what llms.txt does, and doesn't](@guide:llms-txt).",
    ],
    cover: { line: "Line", name: "name", summary: "summary", link: "link fixed", verdict: "Reads as an llms.txt" },
    faqs: [
      {
        q: "What makes an llms.txt valid?",
        a: "Per llmstxt.org, only one thing is required: a # heading with your name. A good file adds a > summary and ## sections of [name](url) links.",
      },
      {
        q: "Does Google check my llms.txt?",
        a: "Google Search doesn't use it. Chrome's Lighthouse (13.3 and later) audits it under Agentic Browsing: a # heading, at least 50 characters and one Markdown link.",
      },
      {
        q: "Is llms-full.txt required?",
        a: "No. llms-full.txt is a community convention, not part of the llms.txt proposal.",
      },
      {
        q: "Can my llms.txt live in a folder?",
        a: "Yes. Since version 2 of the proposal (August 2026), a file at a path such as /docs/llms.txt covers the pages under that path.",
      },
    ],
  },

  examples: {
    title: "llms.txt examples for small businesses · Surfing Dog",
    description:
      "Ready-to-copy llms.txt examples for a restaurant, salon, clinic, shop, tradesperson, hotel and more, written to the llmstxt.org format. Copy, edit, check.",
    h1: "llms.txt examples for small businesses",
    intro: "Pick the one closest to your business, copy it, change the words and addresses, then check it.",
    short: "llms.txt examples",
    idea: "A restaurant, a salon, a plumber:\nan llms.txt for each, ready to copy.",
    coverAlt:
      "Small tiles for a restaurant, a salon, a trade and a shop light up in turn, and an llms.txt card beside them rewrites itself for each one: its name, its first section and its first link.",
    made: "Every name and address here is made up. Addresses ending in .example can't belong to anyone.",
    jump: "Examples",
    kinds: [
      {
        id: "restaurant",
        label: "Restaurant",
        name: "Restaurant, café or bar",
        note: "Menu, hours, booking and the policies guests ask about.",
        file: `# Lua Nova Kitchen

> Neighbourhood restaurant for seasonal small plates and natural wine. Open Tuesday to Sunday, lunch and dinner.

Walk-ins welcome; book for five or more. Prices include tax. Vegetarian and gluten-free dishes every day; tell us about allergies when you book.

## Visit and book

- [Menu and prices](https://luanova.example/menu): lunch and dinner, updated weekly
- [Opening hours and how to find us](https://luanova.example/visit): address, map, public transport
- [Book a table](https://book.luanova.example/): online, up to 8 people
- [Private events](https://luanova.example/events): groups of 10 to 40, quote on request

## Policies

- [Cancellations and deposits](https://luanova.example/policies): free cancellation up to 24 hours before
- [Allergens](https://luanova.example/allergens): dish by dish

## For AI agents

- [Agent inbox](https://inbox.luanova.example/.well-known/agent-inbox.json): messages, quote requests and table bookings
- [MCP server](https://inbox.luanova.example/mcp): check availability, request a booking

## Optional

- [Our story](https://luanova.example/about)
- [Gift cards](https://luanova.example/gift-cards)`,
      },
      {
        id: "salon",
        label: "Salon",
        name: "Hair, beauty or barber",
        note: "Services with prices, the booking page you already use, and the cancellation rule.",
        file: `# Jacaranda Hair & Beauty

> Hair salon and beauty studio: cuts, colour, braids, nails and brows. Open Tuesday to Saturday, late on Thursdays.

Appointments recommended; walk-ins when a chair is free. We speak English, French and Swahili.

## Services and booking

- [Services and prices](https://jacarandahair.example/services): from a fringe trim to full colour
- [Book an appointment](https://book.jacarandahair.example/): choose a stylist and a time
- [Our team](https://jacarandahair.example/team): who does what

## Policies

- [Cancellations](https://jacarandahair.example/cancellations): free up to 24 hours before; late cancellations pay half
- [Gift vouchers](https://jacarandahair.example/vouchers): any amount, valid 12 months

## For AI agents

- [Agent inbox](https://inbox.jacarandahair.example/.well-known/agent-inbox.json): questions and appointment requests

## Optional

- [Hair care tips](https://jacarandahair.example/blog)`,
      },
      {
        id: "clinic",
        label: "Clinic",
        name: "Clinic: dentist, physio, vet or therapist",
        note: "Treatments, fees and how to book; never anything about patients. No door yet, so no section for agents.",
        file: `# Banyan Dental Clinic

> Family dental clinic for check-ups, hygiene, fillings, whitening and children's dentistry. Open Monday to Saturday.

New patients welcome. For severe pain or swelling, call us before you come in.

## Treatments and booking

- [Treatments and fees](https://banyandental.example/treatments): price ranges for each treatment
- [Book a visit](https://banyandental.example/book): check-ups and hygiene online; other treatments after a check-up
- [Your first visit](https://banyandental.example/first-visit): what to bring, how long it takes
- [Insurance and payment plans](https://banyandental.example/insurance): plans we accept

## Policies

- [Cancellations](https://banyandental.example/cancellations): please give 24 hours' notice
- [Urgent care](https://banyandental.example/contact): same-day help for pain and accidents

## Optional

- [Our dentists](https://banyandental.example/team)`,
      },
      {
        id: "shop",
        label: "Shop",
        name: "Shop, online or on the high street",
        note: "Collections, delivery and returns, and the checkout profiles many shop platforms publish for you.",
        file: `# Tidewater Tea Co.

> Loose-leaf tea and teaware, packed to order. We ship worldwide from our own warehouse.

Free delivery on larger orders; the amount is shown at checkout. Orders placed before 2 pm ship the same working day.

## Shop

- [Black and green teas](https://tidewatertea.example/collections/tea)
- [Teapots and cups](https://tidewatertea.example/collections/teaware)
- [Gift boxes](https://tidewatertea.example/collections/gifts)

## Orders and policies

- [Delivery](https://tidewatertea.example/delivery): times and costs by country
- [Returns](https://tidewatertea.example/returns): 30 days, unopened
- [Track an order](https://tidewatertea.example/track)
- [Ways to pay](https://tidewatertea.example/payment): cards, wallets and bank transfer

## For AI agents

- [Shop profile (UCP)](https://tidewatertea.example/.well-known/ucp): catalogue and checkout
- [MCP server](https://tidewatertea.example/api/mcp): search products, build a cart

## Optional

- [Brewing guides](https://tidewatertea.example/blog)`,
      },
      {
        id: "trades",
        label: "Trades",
        name: "Trades: plumber, electrician, builder or cleaner",
        note: "Where you work, what a visit costs, and how to ask for a quote or an emergency call-out.",
        file: `# Brightline Plumbing & Heating

> Plumbing, heating and boiler repairs for homes and small businesses, across the city and nearby towns.

Fixed call-out fee, then a price before we start. Emergency call-outs every day, 7:00 to 22:00.

## Services and quotes

- [Services and areas we cover](https://brightlineplumbing.example/services): repairs, installs, servicing
- [Prices and call-out fees](https://brightlineplumbing.example/prices)
- [Request a quote](https://brightlineplumbing.example/quote): photos help us price it
- [Emergency call-out](https://brightlineplumbing.example/emergency): hours and how to reach us

## Policies

- [Certificates and insurance](https://brightlineplumbing.example/certificates)
- [Our guarantee](https://brightlineplumbing.example/guarantee): 12 months on parts and labour

## For AI agents

- [Agent inbox](https://inbox.brightlineplumbing.example/.well-known/agent-inbox.json): quote requests and messages

## Optional

- [Recent jobs](https://brightlineplumbing.example/jobs)`,
      },
      {
        id: "stay",
        label: "Hotel",
        name: "Hotel, B&B or guesthouse",
        note: "Rooms and rates, booking, arrival times and the rules guests ask about.",
        file: `# Kestrel Ridge Lodge

> Eight-room lodge in the hills, with breakfast included and walking trails from the door.

Check-in from 15:00, check-out by 11:00. Dogs welcome in two of the rooms.

## Rooms and booking

- [Rooms and rates](https://kestrelridge.example/rooms): with photos and what's included
- [Book a stay](https://kestrelridge.example/book): live availability
- [Getting here](https://kestrelridge.example/directions): by car, train and shuttle

## Policies

- [Cancellations](https://kestrelridge.example/cancellations): free up to 7 days before arrival
- [Pets](https://kestrelridge.example/pets)

## For AI agents

- [Agent inbox](https://inbox.kestrelridge.example/.well-known/agent-inbox.json): questions, group quotes and booking requests

## Optional

- [Walks nearby](https://kestrelridge.example/walks)`,
      },
      {
        id: "classes",
        label: "Classes",
        name: "Classes: gym, yoga, dance or music",
        note: "The timetable, memberships and the first visit. No door yet, so no section for agents.",
        file: `# Lotus Flow Yoga

> Yoga and pilates studio with classes for beginners to advanced, mornings and evenings, seven days a week.

First class free. Mats and blocks provided.

## Classes and memberships

- [Timetable](https://lotusflow.example/timetable): every class this week
- [Memberships and class passes](https://lotusflow.example/prices)
- [Book a class](https://lotusflow.example/book)
- [Your first visit](https://lotusflow.example/first-visit): what to wear, when to arrive

## Policies

- [Cancellations](https://lotusflow.example/cancellations): up to 4 hours before class

## Optional

- [Teacher training](https://lotusflow.example/training)`,
      },
      {
        id: "professional",
        label: "Professional",
        name: "Professional services: accountant, lawyer, agency or consultant",
        note: "What you do, for whom, what it costs, and how to start.",
        file: `# Okafor & Lim Accountants

> Accounting, tax returns and payroll for freelancers and small companies.

We work in English, Yoruba and Mandarin. Fixed monthly fees; a first call of 20 minutes is free.

## Services

- [Services and fees](https://okaforlim.example/services): monthly plans and one-off work
- [Book a first call](https://okaforlim.example/book)
- [What to prepare](https://okaforlim.example/checklist): documents for your first meeting

## Policies

- [Terms of engagement](https://okaforlim.example/terms)
- [Privacy](https://okaforlim.example/privacy)

## For AI agents

- [Agent inbox](https://inbox.okaforlim.example/.well-known/agent-inbox.json): questions and requests for a quote

## Optional

- [Tax deadlines this year](https://okaforlim.example/deadlines)`,
      },
      {
        id: "template",
        label: "Template",
        name: "A blank template",
        note: "Replace each {part in braces}, and delete the lines you don't need.",
        file: `# {Your business's name}

> {What you do, and where, in one line.}

{Optional: opening hours, the areas you serve, the languages you speak, how people pay.}

## {Services | Shop | Visit and book}

- [{Services and prices}](https://{yourdomain}/{page}): {a short note}
- [{Opening hours and how to find us}](https://{yourdomain}/{page})
- [{Book or order}](https://{your booking or shop address})

## Policies

- [{Cancellations, delivery or returns}](https://{yourdomain}/{page})

## For AI agents

- [{Agent inbox, MCP server or shop profile}](https://{its address}): {what it takes}

## Optional

- [{About us}](https://{yourdomain}/{page})`,
      },
    ],
    howH: "How to use one",
    how: [
      "Copy the closest example, and change the name, the summary and every address.",
      "Keep only what's true for you, and link pages that already exist.",
      "Upload it as llms.txt to your site's root, so it opens at yoursite.com/llms.txt.",
      "Check it with the [llms.txt checker](@tool:llms-txt), and fix each line it names.",
    ],
    generator:
      "Or start from your own website: the [llms.txt generator](@tool:llms-txt-generator) writes a first version from what your site already says.",
    doorsH: "The “For AI agents” section",
    doors: [
      "List only doors that work today: an agent inbox, an MCP server, a shop's checkout profile. No door yet? Leave the section out. An [agent inbox](@start) gives you one.",
      "## Optional is the name the format uses, by convention, for links a reader may skip, so it stays in English in every language.",
    ],
    faqs: [
      {
        q: "What should a small business put in llms.txt?",
        a: "Your name as a # heading, one line on what you do and where, then links to the pages that answer customers: services and prices, hours and location, booking, policies. Add your doors for AI agents if you have them.",
      },
      {
        q: "Which language should it be in?",
        a: "The one your customers use, the same as your site. Assistants read many languages.",
      },
      {
        q: "Can I link my booking platform or WhatsApp?",
        a: "Yes, as links with a note: - [Book a table](https://…): up to 8 people. Public addresses only; never private links or staff contacts.",
      },
      {
        q: "Where do I upload it on Wix, Shopify or WordPress?",
        a: "Wix can make one for you; on WordPress, Yoast and AIOSEO can; many Shopify stores already serve one. Anywhere else, upload a file named llms.txt to your site's root.",
      },
    ],
  },

  payments: {
    title: "What is AI agent-assisted payment? · Surfing Dog",
    description:
      "An AI assistant fills the basket or books; the person approves the payment. How it works, the standards (cards, wallets, UCP, ACP, AP2, x402), what to do.",
    h1: "What is AI agent-assisted payment?",
    intro:
      "A payment an AI assistant starts or completes for a person, with the person still approving it. Here's how it works today, and what a small business can do.",
    short: "AI agent-assisted payment",
    idea: "The assistant fills the basket.\nThe person approves. You're paid.",
    coverAlt:
      "A customer's assistant fills a basket and asks its person to approve. The person approves on their phone, a limited token travels to the business, and the business is paid.",
    answer:
      "It's a payment an AI assistant prepares for a person, who still approves it with a tap, a passkey or their banking app. The business is paid through its usual provider, and the assistant never needs a card number.",
    kindsH: "Assisted or agentic?",
    kinds: [
      {
        name: "Agent-assisted",
        says: "The assistant finds, fills the basket or holds the booking. The person approves the payment, each time.",
      },
      {
        name: "Agentic",
        says: "The agent pays on its own, within limits the person set earlier: one shop, an amount, a date.",
      },
    ],
    kindsSource:
      "The research firm Forrester drew this line in [November 2025](https://www.forrester.com/blogs/the-race-to-agentic-payments-in-us-b2c-e-commerce-where-we-are-now/).",
    stepsH: "How it works",
    steps: [
      "The assistant finds what its person wants, with the price: a table, a haircut, a product.",
      "It fills the basket or holds the booking, and asks its person to approve.",
      "The person approves with a tap, a passkey or their banking app. The approval becomes a token or a mandate, limited to one business, one amount or a period.",
      "Your checkout or payment provider checks the token, and you're paid as usual. The assistant never sees a card number.",
    ],
    standardsH: "The standards you'll hear about",
    standardsCols: ["Name", "What it is"],
    standards: [
      {
        name: "Card-network tokens",
        what: "Visa Intelligent Commerce and Mastercard Agent Pay: tokens the card networks issue for agents, reached through your payment provider.",
      },
      {
        name: "Wallets and bank apps",
        what: "Where a person approves, with a passkey or a fingerprint, a payment an assistant prepared.",
      },
      {
        name: "Bank mandates",
        what: "Account-to-account payments with limits set once, such as Pix Automático, UPI AutoPay, PayTo and SEPA Direct Debit. Whether an agent may use one depends on the scheme and your bank.",
      },
      {
        name: "UCP",
        what: "Universal Commerce Protocol: a shop's checkout profile for agents. Its payment handlers say how an agent can pay.",
        href: "https://ucp.dev",
      },
      {
        name: "ACP",
        what: "Agentic Commerce Protocol: checkout for agents, with delegated payment through the shop's own provider.",
        href: "https://www.agenticcommerce.dev",
      },
      {
        name: "AP2",
        what: "Agent Payments Protocol: mandates a person signs so an agent can pay within limits.",
        href: "https://ap2-protocol.org",
      },
      {
        name: "x402",
        what: "Payment over HTTP, mostly in stablecoins. It suits software and APIs more than a salon or a shop today.",
        href: "https://www.x402.org",
      },
    ],
    standardsNote: "This changes month by month. Written in October 2026; ask your provider before you choose.",
    doH: "What a small business can do now",
    do: [
      "Say how you take payment on your site: pay now, a deposit, on arrival or by invoice. An assistant reads this before it commits its person.",
      "Send a payment link to your own checkout. It works with any assistant today: the agent does the rest, and a person pays.",
      "Ask your payment provider which agent tokens and wallets it accepts, and in which countries.",
      "If you sell online, ask your shop platform whether it publishes a checkout profile (UCP or ACP) for your shop. The [UCP and ACP checker](@tool:ucp) shows what's there.",
    ],
    counts: {
      h: "In our directory",
      line: "Of the {checked} business websites we've checked, {pay} take payment through a door an agent can use. Counted {date}.",
      link: "See them on the leaderboards",
      wait: "Live counts from our directory appear here.",
      none: "The counts aren't available just now.",
    },
    statement: {
      h: "On a bank statement",
      text: "“Agent assisted payment” on a bank or card statement usually means something else: a payment taken by a company's staff on the phone or in a chat, which some companies charge a fee for. It has nothing to do with AI.",
    },
    next: "see whether an assistant can find how to pay you.",
    cover: {
      assistant: "Their assistant",
      person: "Their person",
      business: "Your business",
      approve: "Approve?",
      token: "One shop · one amount",
      paid: "Paid",
    },
    faqs: [
      {
        q: "What's the difference between agent-assisted and agentic payments?",
        a: "In an assisted payment the person still approves it, for example with a tap or a passkey. In a fully agentic one the agent pays on its own within limits set earlier. Forrester drew this line in November 2025.",
      },
      {
        q: "Can ChatGPT or other assistants pay for things?",
        a: "Some assistants can fill a basket or start a checkout, and some payment networks let an agent pay with a token the person approved. What's available changes by assistant, country and provider.",
      },
      {
        q: "Is it safe to let an agent pay my business?",
        a: "The agent never needs a card number: card-network tokens, wallets and mandates are limited to a merchant, an amount or a time, and the person approves them. You're paid through your usual provider.",
      },
      {
        q: "Do I need new software to accept it?",
        a: "Usually not to start: a payment link on your own checkout works with any assistant. Agent tokens and wallets come through your payment provider; ask which they support.",
      },
      {
        q: "What does “agent assisted payment” on my bank statement mean?",
        a: "Usually a payment taken by a company's staff on the phone or in chat, which some companies charge a fee for. It has nothing to do with AI.",
      },
    ],
  },
};
