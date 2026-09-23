export { audienceFor, type BusinessFacts, businessFacts } from "./audience";
export { COPY, type Copy, type CopyVars, confirmTermsMessage, copyFor, phraseOf, vars as copyVars } from "./copy";
export {
  type Audience as CustomerAudience,
  customerLabel,
  DEFAULT_AUDIENCE,
  nextActions,
  offerSummary,
  statusSentence,
  subjectIn,
  waitingOn,
  whatOf,
} from "./describe";
export { DISCLOSURE, type DisclosureCopy, keyMail, privacyPage, privacyUrl } from "./disclosure";
export { dateText, dayText, localDate, moneyIn, oneLine, shortRef, timeText, whenText, zoneName } from "./format";
export { CUSTOMER_LANGS, type CustomerLang, customerLang, langFromHeader } from "./lang";
export {
  cutLinks,
  detailsSha,
  fillLinks,
  jtiFor,
  LINK_ACTIONS,
  LINK_GRACE_MS,
  type LinkAction,
  type LinkRow,
  linksForEmail,
  linkUrl,
  mintLinks,
  networksLink,
  pruneActionLinks,
  siblingsOf,
  tokenFor,
  verifyLink,
} from "./links";
export {
  AUTOMATED_KINDS,
  answerLines,
  type CustomerMailInput,
  effectiveWrittenBy,
  isAutomated,
  type RenderedMail,
  renderCustomerMail,
} from "./mail";
export { type OfferTerms, type OpenOffer, openOffer, termsSha } from "./offer";
export type { CustomerPage, LinkActResult, PageField, PageForm, PageLink, PageSection } from "./page";
