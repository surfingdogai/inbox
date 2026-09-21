/**
 * @surfingdog/sdk — MIT, so that verifying an Inbox's events costs no one an AGPL dependency.
 *
 * Today it carries the webhook verifier and the event types (ADR-015). The typed REST client is
 * generated from the OpenAPI document in the first release and lands beside them.
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
} from "./webhooks/events";
export { isFullEvent, isTestEvent, TEST_EVENT_TYPE } from "./webhooks/events";
export { isAcceptedStatus, isRetryableStatus, RETRY_SCHEDULE_SECONDS } from "./webhooks/status";
export type { HeadersLike, VerifyWebhookInput, WebhookVerificationCode } from "./webhooks/verify";
export {
  DEFAULT_TOLERANCE_SECONDS,
  verifyWebhook,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WebhookVerificationError,
} from "./webhooks/verify";

export const SDK_VERSION = "0.0.0";
