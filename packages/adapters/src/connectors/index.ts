import type { ConnectorDefinition, OAuthClient } from "@surfingdog/core";
import { calcomConnector } from "./calcom";
import { caldavConnector } from "./caldav/index";
import { googleCalendarConnector } from "./google";
import { icsConnector } from "./ics";
import { mollieConnector } from "./mollie";
import { stripeConnector } from "./stripe";

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
export { basicAuth, CREDENTIAL_FAMILIES, connectorHttp, mayCarryCredentials } from "./http";
export { icsConnector, icsForm } from "./ics";
export { MOLLIE_API, MOLLIE_EVENTS, mollieConnector, mollieForm } from "./mollie";
export { constantTimeEqual, hmacSha256Hex } from "./pay-sign";
export {
  STRIPE_API,
  STRIPE_EVENTS,
  STRIPE_PERMISSIONS,
  STRIPE_TOLERANCE_S,
  stripeConnector,
  stripeForm,
} from "./stripe";

/** The OAuth clients an instance may hold, from its environment: each platform's id and secret. */
export interface OAuthClients {
  readonly google?: OAuthClient | null | undefined;
}

/**
 * Every connector this release ships, as the host offers them: Cal.com, CalDAV and a calendar's
 * private link need nothing of the host; Google needs the instance's OAuth client, and without one
 * says "Soon" on a hosted inbox (ours is on its way) and "set up" on one's own server. Stripe and
 * Mollie take the business's own key and need nothing of the host but its public address (ADR-023).
 */
export function builtInConnectors(
  opts: { readonly oauth?: OAuthClients | undefined; readonly hosted?: boolean | undefined } = {},
): ConnectorDefinition[] {
  const google = opts.oauth?.google ?? null;
  return [
    calcomConnector(),
    caldavConnector({ googleReady: Boolean(google?.clientId && google.clientSecret) }),
    googleCalendarConnector(google, { hosted: opts.hosted }),
    icsConnector(),
    stripeConnector(),
    mollieConnector(),
  ];
}
