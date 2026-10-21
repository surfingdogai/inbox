/**
 * Smoobu access, as its API reference documents it. Source: <https://docs.smoobu.com/>, sections
 * "Authentication", "HMAC Authentication", "Legacy API Key Authentication", "Get User" and "Change
 * Log", read 20 October 2026.
 *
 * Excerpts the adapter is built from:
 * - "All four headers are required on every request. If any header is missing, the request is rejected
 *   with `401 Unauthorized`": `X-API-Key` ("Your API key"), `X-Timestamp` ("Current UTC time in ISO
 *   8601 format. Must be within 5 minutes of server time."), `X-Nonce` ("A unique value for this
 *   request. Use a UUID v4. Never reuse a nonce."), `X-Signature` ("Base64-encoded HMAC-SHA256
 *   signature").
 * - The canonical string, from the documented example:
 *   `CANONICAL="POST\n/api/reservations\n\n${TIMESTAMP}\n${NONCE}\n${BODY_HASH}\n${API_KEY}"`, with
 *   `BODY_HASH=$(echo -n "$BODY" | openssl dgst -sha256 | awk '{print $2}')` and
 *   `SIGNATURE=$(echo -en "$CANONICAL" | openssl dgst -sha256 -hmac "$API_SECRET" -binary | base64)`.
 *   "GET requests have no body - hash of empty string"; "Sort query params alphabetically: from, to";
 *   "every query parameter key and value must be encoded according to RFC 3986 (for example, a space
 *   becomes `%20`, not `+`, and `[]` becomes `%5B%5D`)".
 * - "Requests with a timestamp more than 5 minutes in the past or future are rejected"; "Each nonce may
 *   only be used once within its 5-minute window. Reusing a nonce causes a `401` even if the signature
 *   is valid."
 * - "Legacy API keys are deprecated and will be sunset on October 31, 2026 … Requests using the legacy
 *   `Api-Key` header will stop working after that date."
 * - `GET https://login.smoobu.com/api/me` → `{ "id": 7, "firstName": "John", "lastName": "Doe",
 *   "email": "…" }`; a failed authentication → 401 `{ "status": 401, "title": "Unauthorized",
 *   "detail": "Authentication required" }`.
 *
 * The two documented examples are pinned below with the signatures the documentation's own commands
 * produce (computed with openssl and checked with a second implementation, 20 October 2026). Their
 * key and secret are the documentation's own placeholders, put together at run time so no file holds a
 * string shaped like a real key, and never sent anywhere. Every other id, key and secret here is made up.
 */

const fake = (...parts: string[]) => parts.join("");

/** The documentation's example inputs, and what its commands sign them as. */
export const DOC_EXAMPLE = {
  apiKey: fake("usr_", "live_", "abc123"),
  apiSecret: fake("your_", "api_", "secret"),
  timestamp: "2026-04-01T12:00:00Z",
  post: {
    method: "POST",
    path: "/api/reservations",
    query: "",
    nonce: "550e8400-e29b-41d4-a716-446655440000",
    body: '{"apartmentId":123,"from":"2026-04-01","to":"2026-04-10"}',
    bodyHash: "c330d36eded5ba48a781e2f2cd95420b89d92e581d779aa86d9ef60a5a6ed53a",
    signature: "64zVmuaX7u9BPPU7J8ruvr5rzoaCcpZtYgFoKGJOdig=",
  },
  get: {
    method: "GET",
    path: "/api/reservations",
    /** As the example sends it (`?to=…&from=…`), and as it signs it, sorted. */
    params: [
      ["to", "2026-04-10"],
      ["from", "2026-04-01"],
    ] as const,
    query: "from=2026-04-01&to=2026-04-10",
    nonce: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    body: "",
    bodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    signature: "Bu2/61pneyRyjQejH7PoCJC2P8iRm3NnC9R6CGFOQho=",
  },
} as const;

/** A key and a secret as Smoobu shows them once: made up, never a real one. */
export function keyPair(n: number): { readonly apiKey: string; readonly apiSecret: string } {
  const tag = String(n).padStart(4, "0");
  return { apiKey: fake("usr_", "test_", "fake", tag), apiSecret: fake("fake-secret-", tag, "-", "0123456789abcdef") };
}

/** Haveli Rang, Jaipur (INR, Asia/Kolkata). */
export const HAVELI_USER = { id: 4127, firstName: "Meera", lastName: "Rathore", email: "stay@haveli-rang.example" };
/** Kijiwe Lodge, near Arusha (TZS, Africa/Dar_es_Salaam). */
export const KIJIWE_USER = { id: 8806, firstName: "Neema", lastName: "Mollel", email: "karibu@kijiwe-lodge.example" };
/** Gîte du Cap-Blanc, Québec City (CAD, America/Toronto, French). */
export const CAPBLANC_USER = {
  id: 3390,
  firstName: "Élise",
  lastName: "Gagnon",
  email: "bonjour@gite-capblanc.example",
};
/** An account with apartments in two towns, and two not finished yet. */
export const MIXED_USER = { id: 9911, firstName: "Baraka", lastName: "Laizer", email: "hello@two-towns.example" };

/** What a refused authentication answers (documented). */
export const UNAUTHORIZED = { status: 401, title: "Unauthorized", detail: "Authentication required" };
