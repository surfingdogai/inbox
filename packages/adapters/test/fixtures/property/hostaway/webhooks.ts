/**
 * Hostaway's unified webhooks and its limits, as documented. Source:
 * <https://api.hostaway.com/documentation>, sections "Webhook events", "Unified webhooks", "Unified
 * webhook object", "Unified webhook log object", "Webhooks → Source IP addresses", "Rate limits" and
 * the changelog (2026-07-22, 2026-08-20), read 20 October 2026.
 *
 * Excerpts the adapter is built from:
 * - `POST https://api.hostaway.com/v1/webhooks/unifiedWebhooks` with `{ "isEnabled": 1, "url", "login",
 *   "password" }`; `GET`, `PUT` and `DELETE …/unifiedWebhooks/{id}`. "Login for basic auth (if login and
 *   password provided we’ll send basic auth header)". No signature is documented.
 * - "if you receive a webhook with an event that you don’t support yet, just return a 200 response."
 * - "Webhook events may arrive out of order … if your system receives an event that references an
 *   entity it hasn’t seen yet, return an error status code so that the delivery is retried".
 * - Retries: "a server error (5xx), or a “too many requests” (429) … up to 3 times … within roughly one
 *   hour"; "Other client errors (4xx … ) are treated as permanent failures"; "We expect to receive a
 *   response acknowledging successful receipt within 20 seconds"; webhooks that "fail for 5
 *   consecutive days" are disabled; "you can receive more than one notification about the same update".
 * - Events: "reservation created", "reservation updated", "new message received". The delivered body is
 *   not documented field by field; the log object names `accountId`, `listingMapId`, `object`,
 *   `objectId` and `event` ("message.received"). The fake sends those, and the reservation as `data`;
 *   the adapter reads only the event, the object, the account and the ids, and reads the reservation
 *   back. The event strings `reservation.created` and `reservation.updated` are assumed from the
 *   prose: the adapter reads back any delivery about a reservation (`object: "reservation"`, or an
 *   event starting `reservation`), whatever it is called, and leaves only messages alone. The real
 *   strings and body are on the founder's sandbox checklist.
 * - Limits: 200 per 10 seconds per account and per IP; 429 with `X-RateLimit-Limit`,
 *   `X-RateLimit-Remaining`, `X-RateLimit-Retry-After` ("Unix timestamp. Send your next request after
 *   this time.") and `X-RateLimit-Applied`; "These headers appear on 429 responses only."
 */

export const RATE_LIMITED = {
  status: "fail",
  message:
    "This error occurs because a server detects that your application has exceeded the rate limits or has made too many requests in a given period of time.",
};

/** The headers of a 429, as documented: the time to come back as a Unix time in seconds. */
export function rateLimitHeaders(now: number, retryAtMs: number, applied = "account"): Record<string, string> {
  return {
    "content-type": "application/json",
    date: new Date(now).toUTCString(),
    "x-ratelimit-limit": "200",
    "x-ratelimit-remaining": "0",
    "x-ratelimit-retry-after": String(Math.ceil(retryAtMs / 1000)),
    "x-ratelimit-applied": applied,
  };
}

/**
 * A body in the shape of the documented "Unified webhook log object", the one machine-readable example
 * of what a unified webhook is about: its own `id`, the account, the listing, the setting, the address
 * and login (the password masked), the `object` and `objectId`, the `event`, and the answer it got.
 * The documented example is a guest message (`conversationMessage`, `message.received`).
 */
export function unifiedLogObject(d: {
  readonly accountId: number;
  readonly listingMapId: number;
  readonly object: string;
  readonly objectId: number;
  readonly event: string;
}) {
  return JSON.stringify({
    id: 2,
    accountId: d.accountId,
    listingMapId: d.listingMapId,
    webhookNotificationSettingId: 5,
    isEnabled: 1,
    url: "https://inbox.example/v1/hooks/hostaway/x",
    login: "login",
    password: "****",
    object: d.object,
    objectId: d.objectId,
    event: d.event,
    responseStatus: 200,
    responseBody: "",
  });
}

/** A unified webhook delivery's body, as the fake sends it. */
export function deliveryBody(d: {
  readonly event: string;
  readonly accountId: number;
  readonly object: string;
  readonly objectId: number;
  readonly listingMapId: number | null;
  readonly data: unknown;
}) {
  return JSON.stringify(d);
}
