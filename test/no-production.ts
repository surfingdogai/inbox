/**
 * No test reaches our production services. Settings name the public network by default, so an
 * inbox under test that closes a promise would post its receipt to network.surfingdog.ai (about ten
 * a day arrived from "inbox.test" before this). A request to surfingdog.ai or any of its hosts
 * fails here as a network error does, which every caller already handles.
 */
const real = globalThis.fetch;

export function production(url: string | URL): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "surfingdog.ai" || host.endsWith(".surfingdog.ai");
  } catch {
    return false;
  }
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" || input instanceof URL ? input : input.url;
  if (production(url)) throw new TypeError(`fetch failed: tests never reach production (${new URL(url).hostname})`);
  return real(input, init);
}) as typeof fetch;
