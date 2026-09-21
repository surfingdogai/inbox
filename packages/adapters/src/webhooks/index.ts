/**
 * Outbound webhooks (ADR-015 §3–§5): signed with Standard Webhooks, retried for a day, replayable
 * for thirty. A developer points Zapier, n8n, Make, a Slack bot or their own server at an inbox
 * and receives every booking, order, quote and message — with no platform, no OAuth and nothing to
 * register.
 */
export * from "./deliver";
export * from "./fanout";
export * from "./sign";
