/**
 * @surfingdog/sdk — MIT, so that talking to an Inbox costs no one an AGPL dependency.
 *
 * Two halves, both WebCrypto only:
 * - for a business's own systems: the webhook verifier and the event types (ADR-015);
 * - for a customer's agent (ADR-017 §8.4): hold a person's pass or key, sign requests
 *   (`sdi-agent/1`), delegate the agent's key at setup, verify receipts and counter-sign them.
 *
 * The typed REST client will be generated from the OpenAPI document and land beside them.
 */
export type { Credential, CredentialKind } from "./agent/credentials.js";
export {
  isSecret,
  keepPasses,
  MAX_CREDENTIAL_LENGTH,
  MAX_PASSES,
  networkOf,
  parseCredential,
  passRefOf,
  sdiPassHeader,
} from "./agent/credentials.js";
export type { AgentKey, AgentKeyInput, AgentPrivateJwk, AgentPublicJwk } from "./agent/keys.js";
export { generateAgentKey, thumbprint } from "./agent/keys.js";
export { delegate, NetworkCallError, networkUrl, passFromKey, requestSignInCode, signIn } from "./agent/network.js";
export type {
  ReceiptClaims,
  ReceiptKey,
  ReceiptVerificationCode,
  SignAckInput,
  VerifiedReceipt,
  VerifyReceiptOptions,
} from "./agent/receipts.js";
export {
  ACK_TYP,
  RECEIPT_TYP,
  ReceiptVerificationError,
  receiptSha,
  signAck,
  verifyReceipt,
} from "./agent/receipts.js";
export type { SignedRequest, SigningErrorCode, SignRequestInput } from "./agent/sign.js";
export { contentDigest, MAX_WINDOW_SECONDS, SIGNATURE_LABEL, SigningError, signRequest } from "./agent/sign.js";

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

export const SDK_VERSION = "0.1.2";
