/**
 * Why a kitchen's order waits for a person, in the owner's words (`payload.kitchen.hold`, ADR-040).
 * Pure, so the phone's screens say it as the owner app does.
 */
export const HOLD_WORDS: Readonly<Record<string, string>> = {
  allergens_unconfirmed:
    "Allergens on this order are not confirmed yet: check them with the kitchen before you accept.",
  over_cap: "Over what you set aside for this slot or day: accept only if the kitchen can make it.",
  made_to_order: "Made to order: you decide on each one.",
  owner_accepts: "You accept each order (Settings → Kitchen).",
};
