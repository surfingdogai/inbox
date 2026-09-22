/**
 * @surfingdog/sdk — MIT, so that verifying an Inbox's events costs no one an AGPL dependency.
 *
 * Today it carries the webhook verifier and the event types (ADR-015). The typed REST client will
 * be generated from the OpenAPI document and land beside them.
 */

export type {
  EventMessage,
  EventParty,
  FullEventData,
  FullInboxEvent,
  InboxEvent,
  InboxEventEnvelope,
  InboxEventType,
  InboxItem,
  InboxItemType,
  ThinEventData,
  ThinInboxEvent,
} from "./webhooks/events.js";
export { isFullEvent, isTestEvent, TEST_EVENT_TYPE } from "./webhooks/events.js";
export { isAcceptedStatus, isRetryableStatus, RETRY_SCHEDULE_SECONDS } from "./webhooks/status.js";
export type { HeadersLike, VerifyWebhookInput, WebhookVerificationCode } from "./webhooks/verify.js";
export {
  DEFAULT_TOLERANCE_SECONDS,
  verifyWebhook,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WebhookVerificationError,
} from "./webhooks/verify.js";

export const SDK_VERSION = "0.1.1";
