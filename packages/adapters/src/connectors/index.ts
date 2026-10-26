import type { ConnectorDefinition, OAuthClient } from "@surfingdog/core";
import { calcomConnector } from "./calcom";
import { caldavConnector } from "./caldav/index";
import { calendlyConnector } from "./calendly";
import { googleCalendarConnector } from "./google";
import { icsConnector } from "./ics";
import { icsFeedConnector } from "./ics-feed";
import { mollieConnector } from "./mollie";
import { shopifyConnector } from "./shopify/index";
import { squareConnector } from "./square/index";
import { stripeConnector } from "./stripe";
import { woocommerceConnector } from "./woocommerce/index";

export { AUTO as CALCOM_AUTO, CALCOM_API, calcomConnector, calcomForm } from "./calcom";
export { DISCOVERY_BUDGET_MS } from "./caldav/client";
export { buildEvent as buildICalEvent, busyFromICal, parseICal } from "./caldav/ical";
export { CALDAV_PRESETS, caldavConnector, caldavForm, isOwnUid, ownUid } from "./caldav/index";
export { expandRRule, parseRRule } from "./caldav/rrule";
export { multistatus, parseXml } from "./caldav/xml";
export { resolveZone, zonedToUtc } from "./caldav/zones";
export {
  CALENDLY_API,
  CALENDLY_AUTH,
  CALENDLY_AUTO,
  CALENDLY_EVENTS,
  CALENDLY_FREE_NOTE,
  CALENDLY_NO_TYPES_NOTE,
  CALENDLY_SCOPES,
  CALENDLY_TOLERANCE_S,
  type CalendlyOptions,
  calendlyConnector,
  calendlyForm,
} from "./calendly";
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
export { bookingsCalendar, ICS_FEED_AHEAD_DAYS, ICS_FEED_PAST_DAYS, icsFeedConnector } from "./ics-feed";
export {
  MOLLIE_API,
  MOLLIE_DECIMALS,
  MOLLIE_EVENTS,
  MOLLIE_METHODS,
  mollieConnector,
  mollieCurrencyProblem,
  mollieForm,
} from "./mollie";
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
  SQUARE_API,
  SQUARE_SANDBOX_API,
  SQUARE_SCOPES,
  SQUARE_TOPICS,
  SQUARE_VERSION,
  squareConnector,
  squareForm,
} from "./square/index";
export {
  fromStripeAmount,
  STRIPE_API,
  STRIPE_CURRENCIES,
  STRIPE_EVENTS,
  STRIPE_GUARANTEE_PERMISSIONS,
  STRIPE_PERMISSIONS,
  STRIPE_TOLERANCE_S,
  STRIPE_VERSION,
  stripeAmount,
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
 * Calendly takes the owner's token, and its sign-in beside it needs the instance's Calendly app, as
 * Google's does.
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
    calendlyConnector(opts.oauth?.calendly ?? null, { hosted: opts.hosted }),
    icsFeedConnector(),
    squareConnector(opts.oauth?.square ?? null, { hosted: opts.hosted }),
  ];
}
