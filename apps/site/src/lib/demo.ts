/**
 * The public demo shop: an instance running with INBOX_DEMO=1, which anyone's AI can book with.
 * It emails no one who uses it, calls no network, and is wiped every night. One place, so the Try page, the
 * home page and the README point at the same address.
 */
export const DEMO_URL = "https://demo.surfingdog.ai";
export const DEMO_MCP = `${DEMO_URL}/mcp`;
export const DEMO_LIVE = `${DEMO_URL}/demo/live`;
export const DEMO_FEED = `${DEMO_URL}/demo/live.json`;
export const DEMO_PROMPT = "Book a bike service with Oficina Maré on Saturday morning";
