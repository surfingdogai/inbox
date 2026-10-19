import type { InboxClient } from "./client";
import type { Native } from "./native";

/**
 * Notifications for one inbox (ADR-026): the phone's push token and, made on the phone for that inbox,
 * an ECDH key and an authentication secret. The inbox registers the token with the relay and encrypts
 * every notification to the key; the private half never leaves the phone's native code.
 *
 * Registered again only when something changed (a new token), so opening the app is not a call to
 * the relay each time.
 */
export type PushSetup = "on" | "denied" | "unavailable" | "error";

export async function setUpPush(
  native: Native,
  client: InboxClient,
  alias: string,
  ask: boolean,
  force = false,
): Promise<PushSetup> {
  try {
    const status = await native.pushStatus();
    if (!status.available) return "unavailable";
    let permission = status.permission;
    if (permission === "prompt" && ask) permission = await native.requestPushPermission();
    if (permission !== "granted") return "denied";
    const token = await native.pushToken();
    if (!token) return "unavailable";
    const sentKey = `push.${alias}`;
    if (!force && (await native.secureGet(sentKey)) === token) return "on";
    const keys = await native.pushKeys(alias);
    const r = await client.registerPush({ token, ...keys });
    if (r.push !== "on") return r.push === "unavailable" ? "unavailable" : "error";
    await native.secureSet(sentKey, token);
    return "on";
  } catch {
    return "error";
  }
}
