/**
 * Mews Connector API answers for the Mews connector's tests (ADR-033 §8.4), written after the
 * documentation's own examples, read 20 October 2026 (saved copies in the build's notes, never fetched
 * with a token):
 *
 * - requests and their body: https://docs.mews.com/connector-api/guidelines/requests
 * - tokens: https://docs.mews.com/connector-api/guidelines/authentication
 * - environments and limits (200 per access token in 30 s, `Retry-After`):
 *   https://docs.mews.com/connector-api/guidelines/environments
 * - answers and their codes: https://docs.mews.com/connector-api/guidelines/responses
 * - configuration/get: https://docs.mews.com/connector-api/operations/configuration
 * - services/getAll, services/getAvailability: https://docs.mews.com/connector-api/operations/services
 * - resourceCategories/getAll, resourceCategoryAssignments/getAll:
 *   https://docs.mews.com/connector-api/operations/resourcecategories
 * - rates/getAll, rates/getPricing: https://docs.mews.com/connector-api/operations/rates
 * - ageCategories/getAll: https://docs.mews.com/connector-api/operations/agecategories
 * - reservations/add, getAll (2023-06-06), update, confirm, cancel, price, updateCustomer:
 *   https://docs.mews.com/connector-api/operations/reservations
 * - serviceOrderNotes/getAll: https://docs.mews.com/connector-api/operations/serviceordernotes
 * - orderItems/getAll (`ServiceOrderIds`, each item's `Amount.GrossValue`, `AccountingState`):
 *   https://docs.mews.com/connector-api/operations/orderitems
 * - customers/add, customers/getAll: https://docs.mews.com/connector-api/operations/customers
 * - time units and offsets: https://docs.mews.com/connector-api/concepts/time-units
 * - general webhooks, one address for a whole integration (why the connector polls for now):
 *   https://docs.mews.com/connector-api/events/wh-general, https://docs.mews.com/connector-api/events/wh-faq
 *
 * The property is made up: Alpenrose Hostel in Innsbruck (EUR, Europe/Vienna, dorm beds and one
 * double). Every id and token here is made up too. The tokens printed in Mews's public documentation are
 * never used, and the demo environment is never called.
 */

/** Made-up tokens, put together at run time so no file holds a string shaped like a real one. */
const fake = (...parts: string[]) => parts.join("");
export const CLIENT_TOKEN = fake("FAKE", "0C11E47A0C11E47A0C11E47A0C11E4", "-", "FAKE0C11E47A0C11E47A0C11E47A0C1");
export const ACCESS_TOKEN = fake("FAKE", "ACCE55ACCE55ACCE55ACCE55ACCE55", "-", "FAKEACCE55ACCE55ACCE55ACCE55ACC");

export const ENTERPRISE = {
  Id: "6a0f1c2e-9b3d-4e5f-8a71-2c3d4e5f6a70",
  Name: "Alpenrose Hostel",
  TimeZoneIdentifier: "Europe/Vienna",
  Currency: "EUR",
  Email: "stay@alpenrose-hostel.example",
  WebsiteUrl: "https://alpenrose-hostel.example",
};

/** The beds and rooms, a bookable service counted in days: a stay starts at 15:00 and ends at 11:00. */
export const SERVICE = {
  Id: "7b1e2d3f-0a4c-4d5e-9f81-3d4e5f6a7b80",
  Name: "Accommodation",
  StartOffset: "PT15H",
  EndOffset: "PT11H",
};
/** Breakfast, a service of another kind: never offered as a property. */
export const BREAKFAST = { Id: "8c2f3e4a-1b5d-4e6f-a092-4e5f6a7b8c90", Name: "Breakfast" };

export const DORM = {
  Id: "1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6",
  Name: "Bed in a six-bed dorm",
  Capacity: 1,
  units: 6,
};
export const DOUBLE = {
  Id: "2e3f4a5b-6c7d-4e8f-9a01-b2c3d4e5f6a7",
  Name: "Private double",
  Capacity: 2,
  units: 1,
};

/** Public and flexible; a private staff rate the inbox never offers. */
export const FLEX = { Id: "3f4a5b6c-7d8e-4f90-ab12-c3d4e5f6a7b8", Name: "Flexible" };
export const STAFF = { Id: "4a5b6c7d-8e9f-4a01-bc23-d4e5f6a7b8c9", Name: "Staff" };

/** Nightly gross prices, as Mews gives them: decimal euros. */
export const PRICES: Readonly<Record<string, number>> = { [DORM.Id]: 32, [DOUBLE.Id]: 89.5 };

export const ADULTS = { Id: "5b6c7d8e-9fa0-4b12-cd34-e5f6a7b8c9d0", Classification: "Adult" };
export const CHILDREN = {
  Id: "6c7d8e9f-a0b1-4c23-de45-f6a7b8c9d0e1",
  Classification: "Child",
  MinimalAge: 0,
  MaximalAge: 17,
};
