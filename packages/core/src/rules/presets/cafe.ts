import { OFFER_A_CODE, type PresetSpec } from "./common";
import { KITCHEN_INSTANT, KITCHEN_WAITS } from "./food";

/**
 * Cafés (ADR-040): order ahead for a short pickup slot. An order inside the slot's places, with nothing
 * sold out and every allergen confirmed, is accepted at once when the café chose so; anything else waits
 * for a person. Nothing here refuses anybody.
 */
export const cafe: PresetSpec<"cafe"> = {
  key: "cafe",
  name: "Café & order-ahead",
  rules: [KITCHEN_INSTANT, KITCHEN_WAITS, OFFER_A_CODE],
};
