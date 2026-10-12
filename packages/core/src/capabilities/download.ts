import type { SqliteSnapshot } from "@surfingdog/platform";
import { MIGRATIONS } from "../schema/migrations.generated";
import { zip } from "../util/zip";

/**
 * Downloading an inbox: the whole database as one SQLite file the owner takes away, in a zip with a
 * README that says what is in it and what was left out, and a manifest that says the same for a
 * program. The file opens in an inbox the owner runs themselves.
 *
 * The copy is made by the runtime (`SqliteSnapshot`: `VACUUM INTO`, then these statements on the
 * copy, then `VACUUM`, so nothing removed lingers in its free pages). What it leaves out is what
 * lets someone in, or what only means something here: who is signed in, sign-in links and codes,
 * the hashes keys and connected AI apps are checked against, the counters that slow floods, and every
 * sealed secret. Each table is listed in `TABLES` as kept or as stripped, and a test fails when a
 * migration adds a table that is not, so a new table holding a secret cannot slip into a download.
 */

/** A table in the copy: kept whole, or with some of it left out, and what that means for the owner. */
export interface DownloadTable {
  /** What the copy leaves out of it, in the owner's words; absent when it is kept whole. */
  readonly leftOut?: string;
  /** Anything else worth knowing about what it holds. */
  readonly note?: string;
  /** The statements that strip it, run on the copy only. */
  readonly strip?: (now: number) => readonly string[];
}

const empty = (table: string) => () => [`DELETE FROM ${table}`];

/** Every table a migration makes, and what a download does with it. */
export const DOWNLOAD_TABLES: Readonly<Record<string, DownloadTable>> = {
  // Who the business is and what it offers.
  business: {},
  settings: {
    leftOut:
      "The secret inbound email is let in with, and this inbox's own address (notifications.appUrl): set them again where you open the copy.",
    strip: () => ["UPDATE settings SET doc = json_remove(doc, '$.email.inboundSecret', '$.notifications.appUrl')"],
  },
  locations: {},
  services: {},
  resources: {},
  products: {},
  price_floors: {},
  availability_rules: { note: "Opening hours and closed days." },
  rules: {},
  // The requests, the conversations and the customers.
  items: {},
  item_events: {},
  thread_entries: {},
  slot_claims: {},
  item_offers: {},
  offer_drafts: {},
  parties: { note: "The customers." },
  party_contacts: {},
  party_identities: {},
  person_links: {},
  network_stops: {},
  agents: {},
  carrying_agents: {},
  receipts: {},
  item_presentations: {},
  outbound_mail: { note: "Every email the inbox sent; the links in them answer only at the inbox that sent them." },
  mail_refs: {},
  action_links: { note: "The links in emails to customers, which answer only at the inbox that sent them." },
  blobs: { note: "Where attachments are kept. The files themselves are not in this download." },
  // The networks this inbox reports to.
  network_status: {},
  network_publications: {},
  network_cache: {},
  key_directories: {},
  reviews_outbox: {},
  // Integrations.
  webhooks: {
    leftOut:
      "Each endpoint's signing secret and extra headers. The endpoints are switched off: give one a new secret, then switch it on.",
    strip: (now) => [
      `UPDATE webhooks SET secret_enc = '', headers_enc = NULL, active = 0, disabled_at = COALESCE(disabled_at, ${now})`,
    ],
  },
  webhook_deliveries: {},
  connectors: {
    leftOut: "The connectors' credentials and the addresses platforms send to. The connectors are switched off.",
    strip: () => ["UPDATE connectors SET config_enc = NULL, inbound_token = NULL, status = 'disabled'"],
  },
  connector_events: {},
  // People who sign in, keys and AI apps.
  users: { note: "The people who sign in. Sign in where you open the copy with the same email address." },
  sessions: { leftOut: "Who is signed in.", strip: empty("sessions") },
  login_tokens: { leftOut: "Sign-in links and codes not used yet.", strip: empty("login_tokens") },
  passkeys: { leftOut: "Sign-in credentials.", strip: empty("passkeys") },
  api_keys: {
    leftOut: "The keys made here, and what they are checked against. Make new keys where you open the copy.",
    strip: empty("api_keys"),
  },
  scope_refusals: {},
  oauth_clients: {},
  oauth_codes: { leftOut: "Codes AI apps were connecting with.", strip: empty("oauth_codes") },
  oauth_tokens: {
    leftOut: "The AI apps connected here, and what they are checked against. Connect them again.",
    strip: empty("oauth_tokens"),
  },
  // Secrets, and what only means something here.
  signing_keys: {
    leftOut:
      "The private half of each key receipts were signed with. The inbox that opens the copy makes a key of its own; the public halves stay, so the receipts signed here still verify.",
    strip: (now) => [`UPDATE signing_keys SET private_jwk_enc = '', retired_at = COALESCE(retired_at, ${now})`],
  },
  pending_identity: {
    leftOut: "Keys a network issued to new customers, sealed, that had not been emailed yet.",
    strip: empty("pending_identity"),
  },
  customer_codes: { leftOut: "One-time codes sent to customers.", strip: empty("customer_codes") },
  idempotency_keys: {
    leftOut: "Answers kept for requests sent twice, which can hold sealed secrets.",
    strip: empty("idempotency_keys"),
  },
  rate_limits: { leftOut: "The counters that slow down floods.", strip: empty("rate_limits") },
  sig_nonces: {},
  jobs: {
    leftOut: "Work waiting to run here, such as emails not sent yet. The inbox that opens the copy queues its own.",
    strip: empty("jobs"),
  },
  migrations: { note: "The version of the database, so the inbox that opens it knows it." },
};

/** The search index, which SQLite keeps in a table and several of its own: kept as it is. */
export const SEARCH_TABLES = /^search_fts(_\w+)?$/;

/** The statements that strip a copy, in the order the tables are listed. */
export function downloadStrip(now: number): string[] {
  return Object.values(DOWNLOAD_TABLES).flatMap((t) => (t.strip ? [...t.strip(Math.floor(now))] : []));
}

/** The download's manifest: what is in the zip, for a program. */
export interface DownloadManifest {
  readonly format: "surfingdog-inbox-download/1";
  readonly created_at: string;
  readonly inbox_version: string;
  readonly business: { readonly name: string; readonly address: string | null };
  readonly database: {
    readonly file: "inbox.db";
    readonly bytes: number;
    readonly sha256: string;
    /** The last migration it has: the inbox that opens it needs this version or a later one. */
    readonly schema_version: number;
  };
  readonly tables: readonly { readonly name: string; readonly rows: number; readonly left_out?: string }[];
}

export interface Download {
  readonly filename: string;
  readonly zip: Uint8Array;
  readonly manifest: DownloadManifest;
}

/**
 * The zip for a download: `inbox.db` (the stripped copy), `manifest.json` and `README.txt`. The copy
 * comes from `snapshot`, which a runtime with a database file of its own provides.
 */
export async function buildDownload(
  snapshot: SqliteSnapshot,
  info: { readonly now: number; readonly business: string; readonly address: string | null; readonly version: string },
): Promise<Download> {
  const copy = await snapshot(downloadStrip(info.now));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.bytes as BufferSource));
  const manifest: DownloadManifest = {
    format: "surfingdog-inbox-download/1",
    created_at: new Date(info.now).toISOString(),
    inbox_version: info.version,
    business: { name: info.business, address: info.address },
    database: {
      file: "inbox.db",
      bytes: copy.bytes.length,
      sha256: [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""),
      schema_version: Math.max(0, ...MIGRATIONS.map((m) => m.version)),
    },
    tables: copy.tables.map((t) => {
      const leftOut = DOWNLOAD_TABLES[t.name]?.leftOut;
      return { name: t.name, rows: t.rows, ...(leftOut ? { left_out: leftOut } : {}) };
    }),
  };
  const encoder = new TextEncoder();
  const files = [
    { name: "README.txt", data: encoder.encode(readme(manifest)) },
    { name: "manifest.json", data: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: "inbox.db", data: copy.bytes },
  ];
  const day = manifest.created_at.slice(0, 10);
  return {
    filename: `${slug(info.business) || "inbox"}-${day}.zip`,
    zip: await zip(files, new Date(info.now)),
    manifest,
  };
}

/** What the zip holds and how to open it, for a person: plain text, so it opens anywhere. */
function readme(m: DownloadManifest): string {
  const name = m.business.name || "This business";
  const when = new Date(m.created_at);
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(when);
  const time = m.created_at.slice(11, 16);
  const leftOut = m.tables.filter((t) => t.left_out);
  const width = Math.max(...m.tables.map((t) => t.name.length), 10);
  const tables = m.tables.map((t) => {
    const note = t.left_out
      ? "part left out, see above"
      : SEARCH_TABLES.test(t.name)
        ? "the search index"
        : DOWNLOAD_TABLES[t.name]?.note;
    const rows = `${t.rows} ${t.rows === 1 ? "row" : "rows"}`;
    return `  ${t.name.padEnd(width)}  ${rows.padStart(11)}${note ? `   ${note}` : ""}`;
  });
  return [
    `${name}: a copy of its inbox`,
    `Downloaded ${day} at ${time} UTC${m.business.address ? ` from ${m.business.address}` : ""}.`,
    "",
    "inbox.db is the inbox as one SQLite file: every request and conversation, the customers, the",
    "services, the opening hours, the rules and the settings. manifest.json says the same for a",
    "program, with the file's SHA-256.",
    "",
    "To run it yourself",
    "",
    "1. Install Surfing Dog Inbox on a server of your own: https://github.com/surfingdogai/inbox",
    "2. Point INBOX_DB at inbox.db.",
    "3. Set INBOX_PUBLIC_URL to the address it will answer at, and a new INBOX_SECRET_KEY",
    "   (openssl rand -base64 32). The old one is not needed: nothing in the copy is sealed with it.",
    "4. Start it and sign in with your email address.",
    "",
    `It needs version ${m.inbox_version} of the inbox or a later one.`,
    "",
    "Left out of the copy",
    "",
    ...leftOut.map((t) => `- ${t.name}: ${t.left_out}`),
    "",
    "Every table in inbox.db",
    "",
    ...tables,
    "",
  ].join("\n");
}

/** A file name from the business's name: plain letters and digits, joined by hyphens. */
function slug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
