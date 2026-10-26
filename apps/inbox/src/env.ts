import { flagOn } from "@surfingdog/adapters";
import { type AddressRange, parseAddressRange } from "@surfingdog/platform";

/**
 * The host's settings, read the same way on both runtimes. The Deploy to Cloudflare button asks for
 * every value in `.dev.vars.example`, so any of them can arrive empty or as whatever was typed: an
 * empty value is no value, and a value that cannot work is said once and left out rather than
 * breaking every request.
 */

/** A comma-separated list (INBOX_OWNER_EMAIL): trimmed, with the empty entries left out. */
export function listFrom(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/**
 * INBOX_PUBLIC_URL as an origin, or undefined when it is empty or not an http(s) URL. Without it the
 * instance uses the address each request arrives at, and the Inbox address in Settings for work
 * that has no request (receipts, links in emails), which the owner's first sign-in fills in.
 */
export function publicUrlFrom(
  value: string | undefined,
  log: (line: string) => void = console.error,
): string | undefined {
  const typed = value?.trim();
  if (!typed) return undefined;
  try {
    const url = new URL(typed);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    // said below
  }
  log(
    `INBOX_PUBLIC_URL is not an http(s) address (${typed}); it is ignored, and the Inbox address in Settings is used`,
  );
  return undefined;
}

/**
 * MAIL_FROM and MAIL_FROM_NAME as a sender, or undefined when no address was given. MAIL_FROM may be
 * written with its name, `Oficina Maré <inbox@oficinamare.pt>`; MAIL_FROM_NAME wins over that name.
 * A value that is not an address (a placeholder such as "none") is said once and left out: there is
 * then no sender, and the sign-in link goes to the log with that reason.
 */
export function senderFrom(
  address: string | undefined,
  name: string | undefined,
  log: (line: string) => void = console.error,
): { address: string; name?: string | undefined } | undefined {
  const typed = address?.trim();
  if (!typed) return undefined;
  const written = /^(?:"?([^"<]*?)"?\s*)?<([^<>]*)>$/.exec(typed);
  const a = (written ? written[2] : typed)?.trim() ?? "";
  if (!/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(a)) {
    log(`MAIL_FROM is not an email address (${typed}); it is ignored: set it to one, like inbox@yourdomain.com`);
    return undefined;
  }
  const n = name?.trim() || written?.[1]?.trim();
  return n ? { address: a, name: n } : { address: a };
}

/**
 * INBOX_SECRET_KEY, trimmed, or undefined when empty. A newest key shorter than 32 characters is
 * still used, since secrets already sealed with it must keep opening, but it is said: the key seals
 * stored secrets and the receipt signing key, and a short one can be guessed from a copy of the database.
 */
export function secretKeyFrom(
  value: string | undefined,
  log: (line: string) => void = console.error,
): string | undefined {
  const typed = value?.trim();
  if (!typed) return undefined;
  const newest = typed.split(",")[0]?.trim() ?? "";
  if (newest.length < 32) {
    log(
      `INBOX_SECRET_KEY is only ${newest.length} characters; use \`openssl rand -base64 32\` for a new one, put it first, and keep the old one after a comma`,
    );
  }
  return typed;
}

/**
 * INBOX_OUTBOUND_DENY: comma-separated addresses and ranges (`203.0.114.7`, `2a01:4f8::/32`) that no
 * outbound call reaches, besides the loopback, private and other ranges no call ever does — the
 * server's own public addresses, say, or a neighbour's. `bad` holds what is not an address or a
 * range, for the server to refuse to start on: a range meant to be closed must not be silently open.
 */
export function outboundDenyFrom(value: string | undefined): { ranges: AddressRange[]; bad: string[] } {
  const ranges: AddressRange[] = [];
  const bad: string[] = [];
  for (const entry of listFrom(value)) {
    const range = parseAddressRange(entry);
    if (range) ranges.push(range);
    else bad.push(entry);
  }
  return { ranges, bad };
}

/**
 * What the server switched on of the job tools (ADR-034 §5): JOBBER_API_VERSION, the Jobber API version
 * the server's Jobber app was checked against (Jobber stays "set up" without one, or with the
 * template's 2022-03-10); JOB_TOOLS_CLEARED, the tools whose API terms whoever runs the server cleared
 * for this use (`housecallpro`, `fergus`), each "set up" until named.
 */
export function jobToolsFrom(env: {
  readonly JOBBER_API_VERSION?: string | undefined;
  readonly JOB_TOOLS_CLEARED?: string | undefined;
}): { jobTools: { jobberApiVersion?: string; cleared: string[] } } {
  const version = env.JOBBER_API_VERSION?.trim();
  return {
    jobTools: {
      ...(version ? { jobberApiVersion: version } : {}),
      cleared: listFrom(env.JOB_TOOLS_CLEARED).map((k) => k.toLowerCase()),
    },
  };
}

/** The OAuth clients an inbox may hold, by platform, and the environment variables each comes from. */
const OAUTH_ENV = {
  google: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
  shopify: ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"],
  square: ["SQUARE_CLIENT_ID", "SQUARE_CLIENT_SECRET"],
  calendly: ["CALENDLY_CLIENT_ID", "CALENDLY_CLIENT_SECRET"],
  // Job tools (ADR-034): ServiceM8's Public Application, Jobber's reviewed app.
  servicem8: ["SERVICEM8_CLIENT_ID", "SERVICEM8_CLIENT_SECRET"],
  jobber: ["JOBBER_CLIENT_ID", "JOBBER_CLIENT_SECRET"],
} as const;

type OAuthEnv = { readonly [K in (typeof OAUTH_ENV)[keyof typeof OAUTH_ENV][number]]?: string | undefined };

/**
 * The OAuth clients this inbox signs owners in to platforms with, each from its id and secret (both,
 * or neither: one alone is said and left out): GOOGLE_OAUTH_CLIENT_ID/_SECRET, SHOPIFY_CLIENT_ID/_SECRET,
 * SQUARE_CLIENT_ID/_SECRET, CALENDLY_CLIENT_ID/_SECRET, SERVICEM8_CLIENT_ID/_SECRET, JOBBER_CLIENT_ID/_SECRET. Each is a one-click sign-in beside a way that
 * needs no app of the server's (ADR-030 §5); without it, that way shows as "set up" in Settings →
 * Integrations ("Soon" on a hosted inbox). GOOGLE_OAUTH_REDIRECT_URI when the host keeps one redirect
 * address for all its inboxes; GOOGLE_OAUTH_TESTING=1 while Google's client is in Testing mode, so
 * Google says "Soon" rather than a sign-in that fails for anyone but its test users.
 */
export function oauthFrom(
  env: OAuthEnv & {
    readonly GOOGLE_OAUTH_REDIRECT_URI?: string | undefined;
    readonly GOOGLE_OAUTH_TESTING?: string | undefined;
  },
  log: (line: string) => void = console.error,
): {
  oauth: { [K in keyof typeof OAUTH_ENV]: { clientId: string; clientSecret: string } | null };
  oauthRedirect: ((kind: string) => string | undefined) | undefined;
  googleTesting: boolean;
} {
  const client = (platform: keyof typeof OAUTH_ENV) => {
    const [idName, secretName] = OAUTH_ENV[platform];
    const id = env[idName]?.trim() ?? "";
    const secret = env[secretName]?.trim() ?? "";
    if ((id && !secret) || (!id && secret)) {
      log(`${idName} and ${secretName} go together; with one alone ${platform} sign-in stays off`);
    }
    return id && secret ? { clientId: id, clientSecret: secret } : null;
  };
  const redirect = env.GOOGLE_OAUTH_REDIRECT_URI?.trim() ?? "";
  let fixed: string | undefined;
  if (redirect) {
    try {
      const url = new URL(redirect);
      if (url.protocol === "https:" && !url.search && !url.hash) fixed = url.toString();
      else log(`GOOGLE_OAUTH_REDIRECT_URI is not an https address without a query (${redirect}); it is ignored`);
    } catch {
      log(`GOOGLE_OAUTH_REDIRECT_URI is not an address (${redirect}); it is ignored`);
    }
  }
  return {
    oauth: {
      google: client("google"),
      shopify: client("shopify"),
      square: client("square"),
      calendly: client("calendly"),
      servicem8: client("servicem8"),
      jobber: client("jobber"),
    },
    oauthRedirect: fixed ? (kind) => (kind === "google_calendar" ? fixed : undefined) : undefined,
    googleTesting: /^(1|true|yes|on)$/i.test((env.GOOGLE_OAUTH_TESTING ?? "").trim()),
  };
}

/**
 * INBOX_UCP_LODGING (ADR-038), read as every switch is (`1`, `true`, `yes`, `on`). Booking sessions are
 * sealed with the instance's secret, so without INBOX_SECRET_KEY they stay off, and that is said once
 * rather than left for a platform to find.
 */
export function ucpLodgingFrom(
  value: string | undefined,
  secretKey: string | undefined,
  log: (line: string) => void = console.error,
): boolean {
  if (!flagOn(value)) return false;
  if (secretKey) return true;
  log("INBOX_UCP_LODGING is on but INBOX_SECRET_KEY is unset: UCP Lodging stays off.");
  return false;
}
