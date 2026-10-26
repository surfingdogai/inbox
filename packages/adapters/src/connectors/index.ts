import type { ConnectorDefinition, OAuthClient } from "@surfingdog/core";
import { calcomConnector } from "./calcom";
import { caldavConnector } from "./caldav/index";
import { calendlyConnector } from "./calendly";
import { googleCalendarConnector } from "./google";
import { icsConnector } from "./ics";
import { icsFeedConnector } from "./ics-feed";
import { mollieConnector } from "./mollie";
import { cloverConnector } from "./pos/clover";
import type { PartnerClient } from "./pos/common";
import { type DeliverectPartner, deliverectConnector } from "./pos/deliverect";
import { flipdishConnector } from "./pos/flipdish";
import { gloriafoodConnector } from "./pos/gloriafood";
import { lightspeedConnector } from "./pos/lightspeed";
import { type ToastPartner, toastConnector } from "./pos/toast";
import { apaleoConnector } from "./property/apaleo";
import { beds24Connector } from "./property/beds24";
import { cloudbedsConnector } from "./property/cloudbeds";
import { hostawayConnector } from "./property/hostaway";
import { type MewsPartner, mewsConnector } from "./property/mews";
import { smoobuConnector } from "./property/smoobu";
import { shopifyConnector } from "./shopify/index";
import { squareConnector } from "./square/index";
import { stripeConnector } from "./stripe";
import { woocommerceConnector } from "./woocommerce/index";
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
export { CLOVER_REGIONS, cloverConnector, cloverOrderBody, cloverSnapshot } from "./pos/clover";
export { allergenCodesOf, minorOf, type PartnerClient } from "./pos/common";
export {
  DELIVERECT_API,
  type DeliverectPartner,
  deliverectConnector,
  deliverectOrderBody,
  deliverectState,
} from "./pos/deliverect";
export { FLIPDISH_API, FLIPDISH_TOKEN_URL, flipdishConnector, flipdishHours, flipdishSnapshot } from "./pos/flipdish";
export { GLORIAFOOD_API, gloriafoodConnector, gloriafoodOrder, gloriafoodSnapshot } from "./pos/gloriafood";
export {
  LIGHTSPEED_API,
  LIGHTSPEED_AUTH,
  lightspeedConnector,
  lightspeedOrderBody,
  lightspeedSnapshot,
} from "./pos/lightspeed";
export { type ToastPartner, toastConnector, toastOrderBody, toastSnapshot, toastState } from "./pos/toast";
export { APALEO_HOSTS, APALEO_SCOPES, apaleoConnector } from "./property/apaleo";
export { CLOUDBEDS_HOSTS, cloudbedsConnector } from "./property/cloudbeds";
export { MEWS_HOSTS, type MewsPartner, mewsConnector } from "./property/mews";
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
 * beside the way that needs none (ADR-030 §5): without it, that way says "set up" on one's own server
 * and "Soon" on a hosted inbox.
 */
export interface OAuthClients {
  readonly google?: OAuthClient | null | undefined;
  readonly shopify?: OAuthClient | null | undefined;
  readonly square?: OAuthClient | null | undefined;
  readonly calendly?: OAuthClient | null | undefined;
  /**
   * Job tools (ADR-039): ServiceM8's Public Application (`SERVICEM8_CLIENT_ID`/`_SECRET`, Development
   * Partner) for its one-click sign-in beside the owner's API key, and Jobber's app
   * (`JOBBER_CLIENT_ID`/`_SECRET`, reviewed by Jobber), its only way in.
   */
  readonly servicem8?: OAuthClient | null | undefined;
  readonly jobber?: OAuthClient | null | undefined;
}

/**
 * What whoever runs the server switched on of the job tools (ADR-039 §5): the Jobber API version its
 * app was checked against (`JOBBER_API_VERSION`), and the tools whose API terms they cleared for this
 * use (`JOB_TOOLS_CLEARED=housecallpro,fergus`). Absent, those say "set up".
 */
export interface JobToolSwitches {
  readonly jobberApiVersion?: string | undefined;
  readonly cleared?: readonly string[] | undefined;
}

/**
 * What a server's operator holds for the property systems that need a partner account (ADR-037 §8.4):
 * Mews's client token, apaleo's connect client, Cloudbeds' partner app; and its switches for a property's
 * own credentials (apaleo's simple client, a key made in Cloudbeds), both off by default. Nothing here is
 * read from the environment yet: until a partnership exists and its operator sets it, each is "Soon" on a
 * hosted inbox and "Needs setup" on one's own server, with nothing to press either way.
 */
export interface PropertyPartners {
  readonly mews?: MewsPartner | null | undefined;
  readonly apaleo?: OAuthClient | null | undefined;
  readonly apaleoOwnClient?: boolean | undefined;
  readonly cloudbeds?: OAuthClient | null | undefined;
  readonly cloudbedsPropertyKey?: boolean | undefined;
}

/**
 * The partner apps of the food tills whoever runs the server holds (ADR-040): Toast's client and API
 * host (`TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET`, `TOAST_API_HOST`), Lightspeed's and Clover's OAuth
 * clients (`LIGHTSPEED_CLIENT_ID`/`_SECRET`, `CLOVER_CLIENT_ID`/`_SECRET`), and Deliverect's channel
 * (`DELIVERECT_CLIENT_ID`, `DELIVERECT_CLIENT_SECRET`, `DELIVERECT_CHANNEL`, `DELIVERECT_STAGING=1`). Absent,
 * each says "Needs setup".
 */
export interface PosPartners {
  readonly toast?: ToastPartner | null | undefined;
  readonly lightspeed?: PartnerClient | null | undefined;
  readonly clover?: PartnerClient | null | undefined;
  readonly deliverect?: DeliverectPartner | null | undefined;
}

/** What the host says of itself to the connectors it offers. */
export interface ConnectorHostOptions {
  readonly oauth?: OAuthClients | undefined;
  readonly jobTools?: JobToolSwitches | undefined;
  readonly pos?: PosPartners | undefined;
  /** A hosted inbox, whose OAuth clients are the host's own and on their way: "Soon" rather than "set up". */
  readonly hosted?: boolean | undefined;
  /**
   * The Google client is still in Google's Testing mode (`GOOGLE_OAUTH_TESTING=1`): only its test users
   * can sign in, so Google says "Soon" rather than a button that fails for everyone else.
   */
  readonly googleTesting?: boolean | undefined;
  /** Partner credentials for property systems (`PropertyPartners`); none, and they say "Needs setup". */
  readonly partners?: PropertyPartners | undefined;
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
    beds24Connector(),
    hostawayConnector(),
    mewsConnector(opts.partners?.mews, { hosted: opts.hosted }),
    apaleoConnector(opts.partners?.apaleo, { hosted: opts.hosted, ownClient: opts.partners?.apaleoOwnClient }),
    cloudbedsConnector(opts.partners?.cloudbeds, {
      hosted: opts.hosted,
      propertyKey: opts.partners?.cloudbedsPropertyKey,
    }),
    smoobuConnector(),
    // Job tools (ADR-039): the owner's own key for ServiceM8; Housecall Pro and Fergus with it too, once
    // their API terms are cleared here; Jobber only through a reviewed app and a version checked for it.
    servicem8Connector(opts.oauth?.servicem8 ?? null),
    housecallproConnector({ cleared: opts.jobTools?.cleared?.includes("housecallpro") }),
    fergusConnector({ cleared: opts.jobTools?.cleared?.includes("fergus") }),
    jobberConnector(opts.oauth?.jobber ?? null, { apiVersion: opts.jobTools?.jobberApiVersion }),
    // A kitchen's own systems (ADR-040): GloriaFood and Flipdish with what the owner makes in their own
    // account; Toast, Lightspeed, Clover and Deliverect only through the server's partner apps.
    gloriafoodConnector(),
    flipdishConnector(),
    toastConnector(opts.pos?.toast ?? null),
    lightspeedConnector(opts.pos?.lightspeed ?? null),
    cloverConnector(opts.pos?.clover ?? null),
    deliverectConnector(opts.pos?.deliverect ?? null),
  ];
}
