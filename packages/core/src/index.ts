/**
 * @surfingdog/core — domain model, state machines, rules engine, receipts.
 * Web-standard APIs only; runtimes plug in through @surfingdog/platform.
 */

export type {
  DatedPolicy,
  DoorElsewhere,
  Manifest,
  PaymentSchedule,
  PaymentTerms,
  Policy,
  PolicyFee,
} from "@surfingdog/spec";
export {
  type BookingDeposit,
  CARD_BRANDS,
  currencyCodeProblem,
  type DepositRule,
  datedPolicySchema,
  depositFor,
  depositRuleSchema,
  decimalOf,
  discoverySnippets,
  ISO_4217_FUNDS,
  ISO_4217_MINOR_UNITS,
  isPaymentToken,
  MANIFEST_PATH,
  manifestSchema,
  minorUnits,
  PAYMENT_TOKENS,
  PAYMENTS_VOCABULARY,
  parseDecimal,
  paymentLabel,
  paymentScheduleSchema,
  paymentTermsSchema,
  paymentToken,
  policySchema,
  publishedPayments,
  readDoorsElsewhere,
  type ServiceAddOn,
  type StaffMember,
  serviceAddOnSchema,
  shareOf,
  staffMemberSchema,
} from "@surfingdog/spec";
export * from "./access/index";
export * from "./capabilities/index";
export * from "./connectors/index";
export * from "./customer/index";
export { createDb, type Db, type Orm, schema } from "./db";
export * from "./domain/types";
export * from "./feeds/parse";
export { CUSTOMER_FORBIDDEN_WORDS, customerCopyProblems, customerWordsIn } from "./i18n/customer-words";
export * from "./identity/index";
export { isUlid, randomToken, ulid } from "./ids";
export * from "./jobs/index";
export * from "./machine/machine";
export * from "./machine/outcomes";
export * from "./machine/tables";
export { buildManifest } from "./manifest";
export type { FloorKind, FloorView } from "./negotiation/catalogue";
export {
  amendmentsSendable,
  itemAmended,
  RECEIPT_AMENDMENTS_ISSUED_SQL,
  RECEIPT_NOT_AMENDED_SQL,
} from "./negotiation/changes";
export type { DraftView } from "./negotiation/drafts";
export {
  BREACHES,
  type Breach,
  checkAccept,
  checkOffer,
  effectiveFloor,
  type LimitLine,
} from "./negotiation/limits";
export {
  legacyOfferId,
  OFFER_STATUSES,
  type OfferRow,
  type OfferSide,
  type OfferStatus,
  type OfferView,
  offerRows,
  offerView,
  REASON_CODES,
  type ReasonCode,
} from "./negotiation/offers";
export {
  MAX_REWARDS,
  type Reward,
  rewardConditionProblem,
  rewardFor,
  rewardPrice,
  rewardProblems,
  rewardsOf,
  type Standing,
} from "./negotiation/rewards";
export * from "./network/index";
export * from "./policy/index";
export * from "./protocol/index";
export * from "./receipts/index";
export * from "./rules/index";
export { MIGRATIONS } from "./schema/migrations.generated";
export {
  createSecretBox,
  type MacPurpose,
  parseSecretKeys,
  requireSecretBox,
  type SecretBox,
  type SecretPurpose,
} from "./secrets/box";
export { mergeSettings } from "./settings/merge";
export {
  type HostHome,
  type HostPolicy,
  hostPolicyFor,
  joinPatch,
  SET_BY_HOST,
  type SettingsPatch,
} from "./settings/policy";
export * from "./settings/schema";
export * from "./staff/index";
export { canonicalNetworkOrigin } from "./util/hosts";
export { canonicalLanguages, currencyProblem, isHundredthsCurrency, isMoneyCurrency } from "./util/locale";
export { formatMinor, moneyText, servicePriceText } from "./util/money";
export { crc32, type ZipFile, zip } from "./util/zip";
export {
  addDays as addLocalDays,
  dateIn,
  daysBetween,
  instantOf,
  isLocalDate,
  isoIn,
  isoWeekday,
} from "./util/zoned";
export { USER_AGENT, VERSION } from "./version";
export * from "./write/index";
