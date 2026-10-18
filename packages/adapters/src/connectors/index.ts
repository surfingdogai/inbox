import type { ConnectorDefinition, OAuthClient } from "@surfingdog/core";
import { calcomConnector } from "./calcom";
import { caldavConnector } from "./caldav/index";
import { googleCalendarConnector } from "./google";

export { AUTO as CALCOM_AUTO, CALCOM_API, calcomConnector, calcomForm } from "./calcom";
export { buildEvent as buildICalEvent, busyFromICal, parseICal } from "./caldav/ical";
export { CALDAV_PRESETS, caldavConnector, caldavForm, isOwnUid, ownUid } from "./caldav/index";
export { expandRRule, parseRRule } from "./caldav/rrule";
export { multistatus, parseXml } from "./caldav/xml";
export { resolveZone, zonedToUtc } from "./caldav/zones";
export { lookupPath, lookupSrv } from "./dns";
export { GOOGLE_SCOPES, googleCalendarConnector, googleEventId } from "./google";
export { basicAuth, connectorHttp, siteOf } from "./http";

/** The OAuth clients an instance may hold, from its environment: each platform's id and secret. */
export interface OAuthClients {
  readonly google?: OAuthClient | null | undefined;
}

/**
 * Every connector this release ships, as the host offers them: Cal.com and CalDAV need nothing of
 * the host; Google needs the instance's OAuth client and is "Soon" without one.
 */
export function builtInConnectors(opts: { readonly oauth?: OAuthClients | undefined } = {}): ConnectorDefinition[] {
  return [calcomConnector(), caldavConnector(), googleCalendarConnector(opts.oauth?.google ?? null)];
}
