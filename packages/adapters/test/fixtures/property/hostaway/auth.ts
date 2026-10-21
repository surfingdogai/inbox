/**
 * Hostaway access, as its Public API reference documents it. Source:
 * <https://api.hostaway.com/documentation>, sections "Authentication", "Revoke Authentication Token"
 * and "Working with authorization token", read 20 October 2026.
 *
 * Excerpts the adapter is built from:
 * - `POST https://api.hostaway.com/v1/accessTokens`, form-encoded: `grant_type` "Should be
 *   client_credentials", `client_id` "Your Hostaway account ID", `client_secret` "can be obtained in
 *   your Hostaway dashboard", `scope` "Should be general".
 * - Response: `{ "token_type": "Bearer", "expires_in": 15897600, "access_token": "…" }`.
 * - "The token will be valid 1 second after being returned from the API." "Time to live for the
 *   generated access token is 24 months."
 * - "Once you get access denied 403 HTTP code it means your token is no longer valid and probably
 *   expired. You need to refresh it … and store a new refreshed token".
 * - Revoke: `DELETE https://api.hostaway.com/v1/accessTokens?token=…` → `{ "status": "success", "result": [] }`.
 *
 * Not documented, and chosen for the fake only: the answer to a wrong account ID or API key (401 with
 * Hostaway's `fail` envelope). Every id, key and token here is made up, and put together at run time
 * so no file holds a string shaped like a real one.
 */

const fake = (...parts: string[]) => parts.join("");

/** Harbourlight Apartments, Hobart (AUD). */
export const HOBART_ACCOUNT = "70412";
/** A pousada in Paraty (BRL). */
export const PARATY_ACCOUNT = "58133";
/** A guesthouse in Reykjavík (ISK, no minor unit). */
export const REYKJAVIK_ACCOUNT = "91207";
/** Pods in Osaka and a room in Tokyo (JPY, no minor unit). */
export const JAPAN_ACCOUNT = "63318";

/** An API key as the dashboard shows it once: made up, 64 hex characters like the documented one. */
export const CLIENT_SECRET = fake("fa4e", "0000".repeat(14), "c0de");
export const OTHER_SECRET = fake("dead", "1111".repeat(14), "beef");

/** The token answer, as documented (`expires_in` as the example gives it). */
export function tokenAnswer(token: string) {
  return { token_type: "Bearer", expires_in: 15897600, access_token: token };
}

/** A token as the fake issues them: not a JWT, never mistaken for one. */
export function fakeToken(n: number): string {
  return fake("fake-hostaway-token-", String(n).padStart(4, "0"));
}

/** What the fake answers a wrong ID or key with (undocumented: Hostaway's envelope, 401). */
export const WRONG_CREDENTIALS = { status: "fail", result: "Invalid client credentials" };

/** What the fake answers a token that no longer works with: the documented 403. */
export const TOKEN_DENIED = { status: "fail", message: "Access denied" };
