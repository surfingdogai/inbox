import type { ForwardView, HostSender, MailProvider } from "./types";

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

/** `{to}` is the inbox's own address. */
export const PROVIDER_STEPS: Readonly<Record<MailProvider, ProviderSteps>> = {
  gmail: {
    steps: [
      "In Gmail, open Settings → See all settings → Forwarding and POP/IMAP.",
      "Add a forwarding address: {to}. Then Next, Proceed.",
      "Gmail sends a confirmation here. It shows on this page in a moment.",
      "Confirm it, then choose Forward a copy of incoming mail to {to}, keep Gmail's copy, and Save Changes.",
    ],
    confirms: true,
  },
  google_workspace: {
    steps: [
      "In Gmail, open Settings → See all settings → Forwarding and POP/IMAP.",
      "Add a forwarding address: {to}. Then Next, Proceed.",
      "Google sends a confirmation here. It shows on this page in a moment.",
      "Confirm it, then choose Forward a copy of incoming mail to {to}, keep Gmail's copy, and Save Changes.",
    ],
    note: "No forwarding option? Your admin allows it in the Admin console: Apps → Google Workspace → Gmail → End user access → Automatic forwarding. A group address can add {to} as a member instead.",
    confirms: true,
  },
  outlook: {
    steps: [
      "In Outlook.com, open Settings → Mail → Forwarding.",
      "Turn on Enable forwarding and enter {to}.",
      "Tick Keep a copy of forwarded messages, then Save.",
    ],
  },
  microsoft_365: {
    steps: [
      "In Outlook on the web, open Settings → Mail → Forwarding.",
      "Turn on Enable forwarding and enter {to}.",
      "Tick Keep a copy of forwarded messages, then Save.",
    ],
    note: "Microsoft 365 holds back forwarding outside your company until your admin allows it: Microsoft Defender → Policies & rules → Threat policies → Anti-spam → Outbound policy → Forwarding rules: On.",
  },
  icloud: {
    steps: [
      "On iCloud.com, open Mail, then Settings → General.",
      "Tick Forward my email to and enter {to}.",
      "Leave Delete messages after forwarding unticked, then Done.",
    ],
  },
  ionos: {
    steps: [
      "In your IONOS account, open Email and choose the address.",
      "Open Forwarding and add {to}.",
      "Keep a copy in the mailbox if you still read it there, then Save.",
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
  cpanel: {
    steps: [
      "In cPanel, open Email → Forwarders → Add Forwarder.",
      "Address: the part before the @, and your domain.",
      "Forward to email address: {to}. Then Add Forwarder.",
    ],
    note: "Plesk and other control panels call it Forwarding or Redirect.",
  },
  other: {
    steps: [
      "In your mail settings, find Forwarding (sometimes Redirect, or Rules).",
      "Forward all mail to {to}, keeping a copy if you want one.",
      "If your provider asks you to confirm, the code or link shows on this page.",
    ],
  },
};

export function stepsFor(provider: MailProvider, to: string): ProviderSteps {
  const s = PROVIDER_STEPS[provider];
  return {
    ...s,
    steps: s.steps.map((line) => line.replaceAll("{to}", to)),
    ...(s.note ? { note: s.note.replaceAll("{to}", to) } : {}),
  };
}

/** Where a forwarded address stands, in a few words. */
export function forwardWords(f: ForwardView): { readonly text: string; readonly tone: "ok" | "wait" | "off" } {
  if (f.checking) return { text: "Checking…", tone: "wait" };
  if (f.state === "working") return { text: "Forwarding works", tone: "ok" };
  if (f.state === "confirm") return { text: `Confirm in ${f.provider_name}`, tone: "wait" };
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

/** Sending from the business's own address, in a few words. */
export function senderWords(s: HostSender): string {
  switch (s.state) {
    case "verified":
      return `Email goes from ${s.address}.`;
    case "verifying":
      return "The records are there. The sending service is checking them.";
    case "dns":
      return "Add these records where your domain's DNS is managed.";
    case "failed":
      return s.problem || "Something stopped checking out. Look at the records again.";
    case "unavailable":
      return "Not available on this inbox yet.";
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
