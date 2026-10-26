/**
 * A place to stay in its own inbox (ADR-037): the property and its rooms, rates, policies, taxes and
 * fees; stays as items with night claims; quotes, holds and bookings written to the property's own
 * system first; the guest's pages and emails; the jobs that keep it all moving.
 */
export {
  type NightsGrid,
  type OwnerSetup,
  StayCapabilities,
  type StayTerms,
  type TodayRow,
  type TodayView,
} from "./capability";
export { allotmentsFor, closedNights, insideAllotment, nightsFree, planNightClaims, wantedRooms } from "./claims";
export {
  lodgingWord,
  STAY_COPY,
  STAY_LANGS,
  type StayCopy,
  type StayLang,
  sampleStayStrings,
  stayCopy,
  stayLang,
} from "./copy";
export { prepareStay, STAY_SERVER_FIELDS, STAY_SWEEP_PERIOD_MS, staySweepKey } from "./create";
export * as stayInputs from "./inputs";
export { stayMessageHandler, staySweepHandler, sweepStays } from "./jobs";
export { checkDates, nightsOf, stayTimes } from "./nights";
export { BALANCE_LINK_AHEAD_MS, staySchedules } from "./payments";
export { localeOf, planFor, quoteFromRates, scheduleFor } from "./price";
export { STAY_PROBLEMS, sampleProblemStrings, stayProblems } from "./problems";
export {
  availability,
  confirmationKind,
  confirmationSentence,
  ESTIMATE_WORDS,
  judgeStay,
  lodgingJsonLd,
  lodgingProfile,
  OFFER_VALID_MS,
  offerMaker,
  propertyPublic,
  shareGuests,
  stayDoor,
  stayDoorOf,
  termsSummary,
} from "./public";
export { openArrival, systemProven } from "./setup";
export {
  listProperties,
  type PropertyRow,
  type PropertySetup,
  propertyFor,
  type RatePlanRow,
  type RoomTypeRow,
  readProperty,
  readSetup,
} from "./store";
export {
  cancellationTerms,
  datesWords,
  dueNow,
  feeSha,
  quoteProblems,
  quoteWords,
  stayTermsSha,
  whenWords,
} from "./terms";
export {
  PAY_GRACE_MS,
  paidOf,
  STAY_MESSAGE_KIND,
  STAY_SWEEP_KIND,
  STAY_WRITE_KIND,
  type StayMessageJob,
  type StayWriteJob,
  stayEventFor,
  WRITE_HOLD_MS,
  writesFirst,
} from "./transition";
