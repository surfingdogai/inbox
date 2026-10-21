import type { ConnectorDefinition, OAuthClient } from "@surfingdog/core";
import { calcomConnector } from "./calcom";
import { caldavConnector } from "./caldav/index";
import { googleCalendarConnector } from "./google";
import { icsConnector } from "./ics";
import { mollieConnector } from "./mollie";
import { stripeConnector } from "./stripe";
import { fergusConnector } from "./work/fergus";
import { housecallproConnector } from "./work/housecallpro";
import { jobberConnector } from "./work/jobber";
import { servicem8Connector } from "./work/servicem8";

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
export { multipart, uuidFrom } from "./work/common";
export { FERGUS_API, FERGUS_SOURCE, FERGUS_TOKEN_DAYS, fergusConnector, fergusForm } from "./work/fergus";
export { HOUSECALLPRO_API, housecallproConnector, housecallproForm, leadTag } from "./work/housecallpro";
export { JOBBER_API, JOBBER_GRAPHQL, JOBBER_TEMPLATE_VERSION, type JobberApp, jobberConnector } from "./work/jobber";
export {
  SERVICEM8_API,
  SERVICEM8_SCOPES,
  SERVICEM8_WEBHOOKS,
  servicem8Connector,
  servicem8Form,
} from "./work/servicem8";

/**
 * The OAuth clients an instance may hold, from its environment: each platform's id and secret
 * (`GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`, `SHOPIFY_CLIENT_ID`/`_SECRET`, `SQUARE_CLIENT_ID`/`_SECRET`,
 * `CALENDLY_CLIENT_ID`/`_SECRET`). Each is the app of whoever runs the server, for a one-click sign-in
 * beside the way that needs none (ADR-026 §5): without it, that way says "set up" on one's own server
 * and "Soon" on a hosted inbox.
 */
export interface OAuthClients {
  readonly google?: OAuthClient | null | undefined;
  readonly shopify?: OAuthClient | null | undefined;
  readonly square?: OAuthClient | null | undefined;
  readonly calendly?: OAuthClient | null | undefined;
  /**
   * Job tools (ADR-034): ServiceM8's Public Application (`SERVICEM8_CLIENT_ID`/`_SECRET`, Development
   * Partner) for its one-click sign-in beside the owner's API key, and Jobber's app
   * (`JOBBER_CLIENT_ID`/`_SECRET`, reviewed by Jobber), its only way in.
   */
  readonly servicem8?: OAuthClient | null | undefined;
  readonly jobber?: OAuthClient | null | undefined;
}

/**
 * What whoever runs the server switched on of the job tools (ADR-034 §5): the Jobber API version its
 * app was checked against (`JOBBER_API_VERSION`), and the tools whose API terms they cleared for this
 * use (`JOB_TOOLS_CLEARED=housecallpro,fergus`). Absent, those say "set up".
 */
export interface JobToolSwitches {
  readonly jobberApiVersion?: string | undefined;
  readonly cleared?: readonly string[] | undefined;
}

/** What the host says of itself to the connectors it offers. */
export interface ConnectorHostOptions {
  readonly oauth?: OAuthClients | undefined;
  readonly jobTools?: JobToolSwitches | undefined;
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
 * A connector added here takes one import, one export line and one entry below (ADR-026 §7), in the
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
    // Job tools (ADR-034): the owner's own key for ServiceM8; Housecall Pro and Fergus with it too, once
    // their API terms are cleared here; Jobber only through a reviewed app and a version checked for it.
    servicem8Connector(opts.oauth?.servicem8 ?? null),
    housecallproConnector({ cleared: opts.jobTools?.cleared?.includes("housecallpro") }),
    fergusConnector({ cleared: opts.jobTools?.cleared?.includes("fergus") }),
    jobberConnector(opts.oauth?.jobber ?? null, { apiVersion: opts.jobTools?.jobberApiVersion }),
  ];
}
