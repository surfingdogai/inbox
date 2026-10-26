import type { ConnectorDefinition, OAuthClient } from "@surfingdog/core";
import { calcomConnector } from "./calcom";
import { caldavConnector } from "./caldav/index";
import { googleCalendarConnector } from "./google";
import { icsConnector } from "./ics";
import { mollieConnector } from "./mollie";
import { shopifyConnector } from "./shopify/index";
import { stripeConnector } from "./stripe";
import { woocommerceConnector } from "./woocommerce/index";

export { AUTO as CALCOM_AUTO, CALCOM_API, calcomConnector, calcomForm } from "./calcom";
export { DISCOVERY_BUDGET_MS } from "./caldav/client";
export { buildEvent as buildICalEvent, busyFromICal, parseICal } from "./caldav/ical";
export { CALDAV_PRESETS, caldavConnector, caldavForm, isOwnUid, ownUid } from "./caldav/index";
export { expandRRule, parseRRule } from "./caldav/rrule";
export { multistatus, parseXml } from "./caldav/xml";
export { resolveZone, zonedToUtc } from "./caldav/zones";
export { lookupMx, lookupPath, lookupSrv } from "./dns";
export {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_SCOPES,
  googleCalendarConnector,
  googleEventId,
  idTokenClaims,
} from "./google";
export { hmacSha256Base64, verifyBase64Hmac, verifyHexHmac } from "./hook-sign";
export { basicAuth, CREDENTIAL_FAMILIES, connectorHttp, mayCarryCredentials } from "./http";
export { ICS_PRESETS, icsConnector, icsForm } from "./ics";
export { MOLLIE_API, MOLLIE_EVENTS, MOLLIE_METHODS, mollieConnector, mollieForm } from "./mollie";
export { constantTimeEqual, hmacSha256Hex } from "./pay-sign";
export {
  SHOPIFY_API_VERSION,
  SHOPIFY_HOOK_FIELDS,
  SHOPIFY_SCOPES,
  SHOPIFY_TOPICS,
  shopDomainOf,
  shopifyConnector,
  shopifyForm,
} from "./shopify/index";
export {
  STRIPE_API,
  STRIPE_EVENTS,
  STRIPE_PERMISSIONS,
  STRIPE_TOLERANCE_S,
  STRIPE_VERSION,
  stripeConnector,
  stripeForm,
} from "./stripe";
export { WOO_METHODS, WOO_TOPICS, woocommerceBefore, woocommerceConnector, woocommerceForm } from "./woocommerce/index";

/**
 * The OAuth clients an instance may hold, from its environment: each platform's id and secret
 * (`GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`, `SHOPIFY_CLIENT_ID`/`_SECRET`, `SQUARE_CLIENT_ID`/`_SECRET`,
 * `CALENDLY_CLIENT_ID`/`_SECRET`). Each is the app of whoever runs the server, for a one-click sign-in
 * beside the way that needs none (ADR-030 §5): without it, that way says "set up" on one's own server
 * and "Soon" on a hosted inbox.
 */
export interface OAuthClients {
  readonly google?: OAuthClient | null | undefined;
  readonly shopify?: OAuthClient | null | undefined;
  readonly square?: OAuthClient | null | undefined;
  readonly calendly?: OAuthClient | null | undefined;
}

/** What the host says of itself to the connectors it offers. */
export interface ConnectorHostOptions {
  readonly oauth?: OAuthClients | undefined;
  /** A hosted inbox, whose OAuth clients are the host's own and on their way: "Soon" rather than "set up". */
  readonly hosted?: boolean | undefined;
  /**
   * The Google client is still in Google's Testing mode (`GOOGLE_OAUTH_TESTING=1`): only its test users
   * can sign in, so Google says "Soon" rather than a button that fails for everyone else.
   */
  readonly googleTesting?: boolean | undefined;
}

/**
 * Every connector this release ships, as the host offers them: Cal.com, CalDAV and a calendar's
 * private link need nothing of the host; Google needs the instance's OAuth client, and without one
 * says "Soon" on a hosted inbox (ours is on its way) and "set up" on one's own server. Stripe and
 * Mollie take the business's own key and need nothing of the host but its public address (ADR-023).
 *
 * A connector added here takes one import, one export line and one entry below (ADR-030 §7), in the
 * order WooCommerce, Shopify, Square, Calendly, the calendar link to share.
 */
export function builtInConnectors(opts: ConnectorHostOptions = {}): ConnectorDefinition[] {
  const google = opts.oauth?.google ?? null;
  return [
    calcomConnector(),
    caldavConnector({ googleReady: Boolean(google?.clientId && google.clientSecret) && !opts.googleTesting }),
    googleCalendarConnector(google, { hosted: opts.hosted, testing: opts.googleTesting }),
    icsConnector(),
    stripeConnector(),
    mollieConnector(),
    shopifyConnector(opts.oauth?.shopify ?? null),
    woocommerceConnector(),
  ];
}
