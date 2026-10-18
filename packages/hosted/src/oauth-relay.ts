import { normalizeHost } from "./host";

/**
 * One address for every hosted inbox's sign-in with Google (ADR-020). Google sends an owner back only
 * to an address registered on the client, one by one, and every inbox has a name of its own; so each
 * inbox asks Google to come back to `https://<relay host>/oauth/google/callback`, puts its own origin
 * at the front of the state (`base64url(origin).<secret>`), and the router sends the owner's browser
 * on to that inbox's own callback with the query as it came. The code is useless without the
 * verifier the inbox keeps, and the relay passes it only to a name the resolver knows as an inbox.
 */
export const RELAY_PATH = "/oauth/google/callback";
const INBOX_CALLBACK = "/oauth/connect/google_calendar/callback";

/** The redirect address an inbox asks Google for, when the host keeps a relay. */
export function relayRedirect(host: string | undefined): ((kind: string) => string | undefined) | undefined {
  if (!host) return undefined;
  return (kind) => (kind === "google_calendar" ? `https://${host}${RELAY_PATH}` : undefined);
}

/** The inbox's host and the address to send the owner on to, or null when the state names none. */
export function relayTarget(search: string): { readonly host: string; readonly location: string } | null {
  const params = new URLSearchParams(search);
  const state = params.get("state") ?? "";
  const dot = state.indexOf(".");
  if (dot <= 0 || dot > 400) return null;
  let origin: string;
  try {
    const b64 = state.slice(0, dot).replaceAll("-", "+").replaceAll("_", "/");
    origin = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash || origin !== url.origin) return null;
  const host = normalizeHost(url.hostname);
  if (!host) return null;
  return { host, location: `https://${host}${INBOX_CALLBACK}${search}` };
}
