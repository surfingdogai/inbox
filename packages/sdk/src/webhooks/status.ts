/**
 * What your endpoint answers, and what we make of it (ADR-015 §5).
 *
 * The commonest integration bug by a distance is answering a redirect: a framework that quietly
 * sends `301` from `/hooks` to `/hooks/`, or a tunnel that bounces http to https, and the owner
 * sees eight failed deliveries for an endpoint that "works in the browser". We do not follow
 * redirects on a delivery — a webhook URL that can be pointed somewhere else by its own answer is
 * a server-side request forgery waiting to be used — so a 3xx is a failure like any other.
 */

/** 2xx, and only 2xx, is a delivery. Everything else is retried on the schedule. */
export function isAcceptedStatus(status: number): boolean {
  return Number.isFinite(status) && status >= 200 && status < 300;
}

/** The inverse, named for the question a receiver actually asks: will they try me again? */
export function isRetryableStatus(status: number): boolean {
  return !isAcceptedStatus(status);
}

/**
 * How long we wait before each of the eight attempts, in seconds, each delay carrying a tenth of
 * jitter. The last attempt lands a little over a day after the event.
 */
export const RETRY_SCHEDULE_SECONDS: readonly number[] = [0, 5, 300, 1_800, 7_200, 18_000, 36_000, 36_000];
