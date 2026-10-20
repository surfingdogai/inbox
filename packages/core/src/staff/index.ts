/** Salons, barbers and beauty (ADR-035): staff, their times and terms, deposits, policies, a booking system written first. */
export { DEPOSIT_WINDOW_MS, type PreparedBooking, prepareBooking, termsFor } from "./booking";
export {
  type ImportSetupInput,
  importSetupInput,
  StaffCapabilities,
  type StaffInput,
  staffInput,
  type UpdateStaffInput,
  updateStaffInput,
} from "./capability";
export { type DayBooking, type DayColumn, dayByStaff, type StaffDay } from "./day";
export { bookingSchedules, depositLeft } from "./deposits";
export { bookingFeeAt, type CancelFee, cancelFeeOf } from "./fee";
export { cleanPhoto, PHOTO_MAX_BYTES, photoBytes, stripJpegMetadata } from "./photo";
export { heldForCheck, type Requires, type RequiresAnswer, requiresMet } from "./requires";
export { ANY, addOnsOf, findStaffSlots, fromSystem, pickStaff, type StaffSlot } from "./slots";
export {
  firstName,
  hasStaff,
  isStaffed,
  readStaff,
  type StaffRow,
  type StaffService,
  type StaffView,
  staffById,
  staffForService,
  staffViews,
} from "./store";
export { everyStaffLine, staffWords } from "./words";
export { bookFirstInSystem, bookingWriteResolver, type FirstOutcome, registerBookingResolver } from "./write";
