import type { DnsRow, ForwardView, HostSender, MailProvider } from "./types";

/**
 * Settings → Email (ADR-026): the words, and each mail provider's steps for forwarding an existing
 * address to the inbox's own. Kept short: a step is what to click, in the order it is clicked.
 */

export interface ProviderSteps {
  readonly steps: readonly string[];
  /** Said once, under the steps, when there is something an owner trips on. */
  readonly note?: string;
  /** The provider sends a confirmation to the inbox: the page waits for it and shows it. */
  readonly confirms?: boolean;
}

/** Every provider's steps start here: a whole mailbox forwarded brings everything, not only customers. */
export const FIRST_STEP = "Forward only the address customers write to.";

const GMAIL_SHARED =
  "Does this address share a mailbox with your own mail? Forward only its mail: in Gmail, search to:{address}, then Create filter → Forward it to {to}.";
const OUTLOOK_SHARED =
  "Shares a mailbox with your own mail? Use Rules → Add new rule → Sent to {address} → Redirect to {to}.";

/** `{to}` is the inbox's own address, `{address}` the one being forwarded. */
export const PROVIDER_STEPS: Readonly<Record<MailProvider, ProviderSteps>> = {
  gmail: {
    steps: [
      "In Gmail, open Settings → See all settings → Forwarding and POP/IMAP.",
      "Add a forwarding address: {to}. Then Next, Proceed.",
      "Gmail sends a confirmation here. It shows on this page in a moment.",
      "Confirm it, then choose Forward a copy of incoming mail to {to}, keep Gmail's copy, and Save Changes.",
    ],
    note: GMAIL_SHARED,
    confirms: true,
  },
  google_workspace: {
    steps: [
      "In Gmail, open Settings → See all settings → Forwarding and POP/IMAP.",
      "Add a forwarding address: {to}. Then Next, Proceed.",
      "Google sends a confirmation here. It shows on this page in a moment.",
      "Confirm it, then choose Forward a copy of incoming mail to {to}, keep Gmail's copy, and Save Changes.",
    ],
    note: `${GMAIL_SHARED} No forwarding option? Your admin allows it in the Admin console: Apps → Google Workspace → Gmail → End user access → Automatic forwarding. A group address can add {to} as a member instead.`,
    confirms: true,
  },
  outlook: {
    steps: [
      "In Outlook.com, open Settings → Mail → Forwarding.",
      "Turn on Enable forwarding and enter {to}.",
      "Tick Keep a copy of forwarded messages, then Save.",
    ],
    note: OUTLOOK_SHARED,
  },
  microsoft_365: {
    steps: [
      "In Outlook on the web, open Settings → Mail → Forwarding.",
      "Turn on Enable forwarding and enter {to}.",
      "Tick Keep a copy of forwarded messages, then Save.",
    ],
    note: `${OUTLOOK_SHARED} A shared mailbox? Your admin forwards it: Exchange admin center → Recipients → Mailboxes → the mailbox → Mail flow settings → Email forwarding. Microsoft 365 holds back forwarding outside your company until your admin allows it: Microsoft Defender → Policies & rules → Threat policies → Anti-spam → Outbound policy → Forwarding rules: On.`,
  },
  icloud: {
    steps: [
      "On iCloud.com, open Mail, then Settings → General.",
      "Tick Forward my email to and enter {to}.",
      "Leave Delete messages after forwarding unticked, then Done.",
    ],
  },
  yahoo: {
    steps: [
      "In Yahoo Mail, open Settings → More Settings → Mailboxes, and choose the address.",
      "Under Forwarding, enter {to}, then Verify.",
      "Yahoo emails a confirmation here: it arrives in your inbox. Open its link, then Save.",
    ],
  },
  proton: {
    steps: [
      "In Proton Mail (a paid plan), open Settings → All settings → Proton Mail → Auto-reply and forward → Forward emails.",
      "Add forwarding rule: from {address} to {to}.",
      "If Proton asks to confirm, its email arrives in your inbox.",
    ],
  },
  fastmail: {
    steps: [
      "In Fastmail, open Settings → Mail rules → Forwarding (or a rule for {address}).",
      "Forward to {to}, and keep a copy in your inbox.",
      "Save.",
    ],
  },
  zoho: {
    steps: [
      "In Zoho Mail, open Settings → Mail Forwarding and POP/IMAP.",
      "Add {to} under Mail Forwarding.",
      "Zoho sends a verification code here. It shows on this page in a moment.",
      "Verify it in Zoho, then switch the forward on.",
    ],
    confirms: true,
  },
  ionos: {
    steps: [
      "In your IONOS account, open Email and choose the address.",
      "Open Forwarding and add {to}.",
      "Keep a copy in the mailbox if you still read it there, then Save.",
    ],
  },
  godaddy: {
    steps: [
      "Your GoDaddy email is Microsoft 365: sign in to Outlook on the web, then Settings → Mail → Forwarding.",
      "Turn on Enable forwarding and enter {to}.",
      "Tick Keep a copy of forwarded messages, then Save.",
    ],
    note: `${OUTLOOK_SHARED} Forwarding outside your company may need your admin's yes in GoDaddy's Email & Office dashboard.`,
  },
  hostinger: {
    steps: [
      "In hPanel, open Emails, then the domain → Forwarders.",
      "Create forwarder: from {address} to {to}.",
      "Save. Your own mailbox keeps its copy.",
    ],
  },
  ovh: {
    steps: [
      "In the OVH Control Panel, open Web Cloud → Emails → the domain → Redirection.",
      "Add a redirection from {address} to {to}, and keep a copy.",
      "Confirm.",
    ],
  },
  cpanel: {
    steps: [
      "In cPanel, open Email → Forwarders → Add Forwarder.",
      "Address: the part before the @, and your domain.",
      "Forward to email address: {to}. Then Add Forwarder.",
    ],
    note: "Plesk and other control panels call it Forwarding or Redirect. If your host offers SRS, turn it on.",
  },
  other: {
    steps: [
      "In your mail settings, find Forwarding (sometimes Redirect, or Rules).",
      "Forward {address} to {to}, keeping a copy if you want one.",
      "If your provider asks you to confirm, the code shows on this page.",
    ],
  },
};

export function stepsFor(provider: MailProvider, to: string, address = "your address"): ProviderSteps {
  const s = PROVIDER_STEPS[provider];
  const fill = (line: string) => line.replaceAll("{to}", to).replaceAll("{address}", address);
  return {
    ...s,
    steps: [FIRST_STEP, ...s.steps.map(fill)],
    ...(s.note ? { note: fill(s.note) } : {}),
  };
}

/** Where a forwarded address stands, in a few words. */
export function forwardWords(f: ForwardView): { readonly text: string; readonly tone: "ok" | "wait" | "off" } {
  if (f.checking) return { text: "Checking…", tone: "wait" };
  if (f.state === "working") return { text: "Forwarding works", tone: "ok" };
  if (f.state === "confirm") return { text: `Confirm in ${f.confirmation?.provider || f.provider_name}`, tone: "wait" };
  if (f.state === "not_yet") return { text: "Not arriving yet", tone: "off" };
  return { text: "Not checked yet", tone: "off" };
}

/** The host of a confirmation link, so the owner sees where it opens before opening it. */
export function linkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Sending from the business's own address, in a few words, while it is not yet (or no longer) in use. */
export function senderWords(s: HostSender): string {
  switch (s.state) {
    case "verified":
      return "Your own address, signed for your domain.";
    case "verifying":
      return "The records are there. The sending service is checking them.";
    case "dns":
      return "Add these records where your domain's DNS is managed.";
    case "failed":
      return s.problem || "Something stopped checking out. Look at the records again.";
    default:
      return "";
  }
}

/** A DNS row's name as most DNS panels want it: without the domain at its end. */
export function shortName(name: string, domain: string): string {
  const n = name.replace(/\.$/, "");
  if (n === domain) return "@";
  return n.endsWith(`.${domain}`) ? n.slice(0, -(domain.length + 1)) : n;
}

/** The rows as one block of text: what "Copy all" copies, and what the web person is sent. */
export function rowsText(rows: readonly DnsRow[], domain: string): string {
  return rows
    .map((r) =>
      [r.type, shortName(r.name, domain), ...(r.priority !== undefined ? [String(r.priority)] : []), r.value].join(
        "  ",
      ),
    )
    .join("\n");
}

/**
 * An email to whoever looks after the business's domain, with the rows to add: the owner sends it
 * from their own mail program, to whom they choose.
 */
export function webPersonMailto(domain: string, rows: readonly DnsRow[]): string {
  const subject = `DNS records for ${domain}`;
  const body = [
    `Hello, could you add these records to ${domain}'s DNS? They let our email be signed for our own domain. None of them changes where our email goes.`,
    "",
    "Type  Name  [Priority]  Value",
    rowsText(rows, domain),
    "",
    "Thank you!",
  ].join("\n");
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** When the records were last looked at, in words: "Checked 5 minutes ago". */
export function checkedWords(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Checked ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `Checked on ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(at)}`;
}

/** A DNS value split where it may break: after each dot, so a long name never breaks mid-word. */
export function breakAtDots(value: string): string[] {
  return value.split(/(?<=\.)/);
}
