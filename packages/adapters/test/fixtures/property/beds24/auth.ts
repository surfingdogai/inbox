/**
 * Beds24 authentication, as documented. Sources:
 * - https://beds24.com/api/v2/apiV2.yaml (saved copy: scratchpad ext-beds24/apiV2.yaml), paths
 *   `/authentication/setup` (GET, header `code`, optional header `deviceName`; answer schema
 *   `refreshToken`: token, expiresIn, refreshToken), `/authentication/token` (GET with header
 *   `refreshToken`, answer schema `token`; DELETE gives the refresh token back) and
 *   `/authentication/details` (answer schema `tokenDetails`: validToken, token.ownerId, token.scopes…).
 * - https://wiki.beds24.com/index.php/API_V2.0: scopes as `read:`, `write:` or `all:` (every method,
 *   deleting too) on bookings, bookings-personal, bookings-financial, inventory, properties;
 *   "Invite codes expire after 24 hours", "Tokens generated
 *   from refresh tokens expire after 24 hours", "Unused refresh tokens expire after 30 days"; its FAQ
 *   names POST /authentication/setup, which the OpenAPI file does not.
 * Values are made up for these tests; the shapes are the documented ones. Error texts are not given by
 * the documentation beyond the `UnsuccessfulApiResponse` shape, except "Token is missing", which is
 * Beds24's own answer to a call with no token (scratchpad ext-beds24/v2.json).
 */

export const INVITE_CODE = "inv-RH-7c1e2b9d4a6f0835";
export const OWNER_ID = 880_214;

/** `GET /authentication/setup` → 200, schema `refreshToken`. */
export const setupAnswer = {
  token: "tok-RH-0001",
  expiresIn: 86_400,
  refreshToken: "rft-RH-5b8e0c2a91d7f346",
};

/** `GET /authentication/token` → 200, schema `token`. */
export const tokenAnswer = { token: "tok-RH-0002", expiresIn: 86_400 };

/** `GET /authentication/details` → 200, schema `tokenDetails`, with the scopes this connection asks for. */
export const detailsAnswer = {
  validToken: true,
  token: {
    ownerId: OWNER_ID,
    expiresIn: 86_400,
    created: "2026-10-20T08:00:00Z",
    scopes: [
      "read:bookings",
      "write:bookings",
      "read:bookings-personal",
      "read:bookings-financial",
      "write:bookings-financial",
      "read:inventory",
      "read:properties",
    ],
    deviceName: "Inbox",
    linkedProperties: false,
    onlyPropertyId: null,
    whiteListOnly: false,
    whiteList: [],
  },
  diagnostics: { requestIp: "203.0.113.24" },
};

/** Schema `UnsuccessfulApiResponse` (success, type, code, error). */
export const invalidCodeAnswer = { success: false, type: "error", code: 400, error: "Invalid code" };
/** Beds24's own answer to a call without a token (recorded unauthenticated, scratchpad ext-beds24/v2.json). */
export const tokenMissingAnswer = { success: false, code: 401, error: "Token is missing" };
