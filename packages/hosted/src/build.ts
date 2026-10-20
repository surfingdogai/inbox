import { serveStatic } from "@hono/node-server/serve-static";
import type { OAuthClients, OwnerEmailChange } from "@surfingdog/adapters";
import { type Db, DEFAULT_NETWORK, type HostPolicy, hostPolicyFor, type RelayRegistrar } from "@surfingdog/core";
import { createInbox, type Inbox } from "@surfingdog/inbox/app";
import { isDoor } from "@surfingdog/inbox/doors";
import { type MailOut, pinnedMailOut } from "@surfingdog/platform";
import { type NodeSqliteClient, nodeSnapshot } from "@surfingdog/platform/node";
import type { Ledger } from "./ledger";
import type { PolicyPayload } from "./types";

/**
 * One inbox, built from its policy (C8.3) the same way every time:
 *
 * - the host policy is `hostPolicyFor({address, site})` with the doors for agents open or closed,
 *   and a new inbox joins the policy's networks (`join_networks`, else the default network) from
 *   its first settings: held until it is live at the business's own address, on from then;
 * - every link points at `address`, the inbox's canonical name;
 * - the owner is `owner_email`;
 * - mail goes from the pinned sender, with the shared ledger deciding what may go (`allowCustomerMail`
 *   and `beforeSend`);
 * - the owner's download is a copy made beside the inbox's file.
 */

/** A host policy with the doors for agents open or closed (absent means open, to an inbox that knows the field). */
export type HostedPolicy = HostPolicy & { readonly agents: "open" | "closed" };

export function hostedPolicy(p: PolicyPayload): HostedPolicy {
  return {
    ...hostPolicyFor({
      address: p.address,
      site: p.site,
      domain: p.domain,
      connectUrl: p.connect_url,
      joins: p.join_networks ?? [DEFAULT_NETWORK],
    }),
    agents: p.agents,
  };
}

export interface BuildDeps {
  readonly tenantId: string;
  readonly policy: PolicyPayload;
  readonly db: Db;
  readonly client: NodeSqliteClient;
  readonly dir: string;
  readonly secretKey: string;
  readonly ledger: Ledger;
  /** The mail transport, for one sender: some transports send only from the address they were made with. */
  readonly transport: (from: { address: string; name: string }) => MailOut;
  readonly fetchImpl?: typeof fetch | undefined;
  /** Where the owner app's files are (the client build); absent, the inbox serves its doors only. */
  readonly clientDir?: string | undefined;
  readonly onOwnerEmailChange?: ((change: OwnerEmailChange) => unknown) | undefined;
  /** The OAuth clients every inbox signs owners in to platforms with (Google Calendar). */
  readonly oauth?: OAuthClients | undefined;
  /** The one redirect address a platform sends every owner back to, through the router (ADR-022). */
  readonly oauthRedirect?: ((kind: string) => string | undefined) | undefined;
  /** How the tenant's phones are registered with the push relay: through the control plane (ADR-026). */
  readonly pushRegistrar?: RelayRegistrar | undefined;
  /** For the internal test as an agent only: the doors open whatever the policy says. Never served. */
  readonly agentsOpen?: boolean | undefined;
  readonly now?: (() => number) | undefined;
}

/** The transport with the ledger's say over what goes, then the pinned sender over that. */
export function tenantMailOut(d: BuildDeps): MailOut {
  const p = d.policy;
  const from = { address: p.mail.from, name: p.mail.from_name };
  const transport = d.transport(from);
  const hooked: MailOut = {
    ...(transport.sender ? { sender: transport.sender } : {}),
    ...(transport.delivers === false ? { delivers: false } : {}),
    send: (mail) => transport.send(mail),
    // No customer is written to below level 2, nor once the cap is zero, nor while sending is paused.
    allowCustomerMail: () => p.mail.customer_mail && p.mail.customer_daily_cap > 0 && !d.ledger.mailPaused(d.tenantId),
    beforeSend: (mail, about) => d.ledger.hold(d.tenantId, mail, about, p.mail.customer_daily_cap),
  };
  return pinnedMailOut(hooked, { from, replyTo: p.mail.reply_to ?? undefined });
}

export function buildInbox(d: BuildDeps): Inbox {
  const p = d.policy;
  const open: HostedPolicy = { ...hostedPolicy(p), ...(d.agentsOpen ? { agents: "open" as const } : {}) };
  // A platform reaches the inbox's webhook doors only once its doors are open (it is live).
  const policy: HostedPolicy = { ...open, hooksLive: open.agents === "open" };
  const inbox = createInbox({
    db: d.db,
    mailOut: tenantMailOut(d),
    baseUrl: p.address,
    ownerEmails: [p.owner_email],
    secretKey: d.secretKey,
    policy,
    fetchImpl: d.fetchImpl,
    // A webhook to a private address is never allowed here (the policy locks it off): the same fetch.
    privateFetchImpl: d.fetchImpl,
    onOwnerEmailChange: d.onOwnerEmailChange,
    snapshot: nodeSnapshot(d.client, d.dir),
    // Closing: the owner's download is the way to keep the inbox, so it starts with the receipt key.
    leaving: p.state === "closing",
    oauth: d.oauth,
    oauthRedirect: d.oauthRedirect,
    pushRegistrar: d.pushRegistrar,
    now: d.now,
  });
  if (d.clientDir) {
    // As the Node server does: the owner app's files, then its page for any path that is not a door.
    inbox.app.use("/*", serveStatic({ root: d.clientDir }));
    const shell = serveStatic({ root: d.clientDir, path: "index.html" });
    inbox.app.get("/*", (c, next) => (isDoor(c.req.path) ? next() : shell(c, next)));
  }
  return inbox;
}
