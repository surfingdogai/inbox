import { builtInConnectors, connectorHttp, createApiKey } from "@surfingdog/adapters";
import type { Caller, Db } from "@surfingdog/core";
import { type LogMailOut, logMailOut } from "@surfingdog/platform";
import { expect } from "vitest";
import type { genericPropertySystem } from "../../../packages/adapters/test/fakes/property/generic";
import { STRIPE_LIVE_KEY } from "../../../packages/adapters/test/fixtures/payments";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";
import { stripePlatform } from "./pay-platforms";

/**
 * A place to stay's inbox for the stays tests (ADR-037): the whole app over a fresh database, Stripe
 * as a fake, a property system as a fake when asked for, an owner key, and a clock the test moves.
 */
export const BASE = "https://inbox.example.com";
const SECRET_KEY = "stay-harness-secret-0123456789abcdef0123";
export const HOUR = 3_600_000;

export interface Setup {
  readonly db: Db;
  readonly inbox: ReturnType<typeof createInbox>;
  readonly mail: LogMailOut;
  readonly clock: { now: number };
  owner(method: string, path: string, body?: unknown): Response | Promise<Response>;
  guest(method: string, path: string, body?: unknown, token?: string): Response | Promise<Response>;
  drain(): Promise<void>;
}

export async function setup(opts: {
  name: string;
  timezone: string;
  currency: string;
  property?: ReturnType<typeof genericPropertySystem>;
  /** UCP Lodging's booking sessions, as INBOX_UCP_LODGING=on opens them. */
  ucpLodging?: boolean;
}): Promise<Setup & { stripe: ReturnType<typeof stripePlatform> }> {
  const db = await freshDb();
  const clock = { now: Date.now() };
  const mail = logMailOut();
  const stripe = stripePlatform(STRIPE_LIVE_KEY, BASE);
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(input instanceof Request ? input.url : input)).host;
    if (opts.property && host === "api.stays.example.com") return opts.property.platform.fetch(input, init);
    return stripe.fetch(input, init);
  }) as typeof fetch;
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    mailOut: mail,
    secretKey: SECRET_KEY,
    baseUrl: BASE,
    eventSettleMs: 0,
    background: (work) => void pending.push(work.catch(() => {})),
    fetchImpl,
    now: () => clock.now,
    ...(opts.ucpLodging ? { ucpLodging: true } : {}),
  });
  if (opts.property) {
    inbox.caps.connectors.attach({
      definitions: [...builtInConnectors({}), opts.property.definition],
      http: connectorHttp({ fetchImpl }),
    });
  }
  const key = (await createApiKey(db, { kind: "owner", name: "cli" })).key;
  const req = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    inbox.app.request(
      new Request(`${BASE}${path}`, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const owner = (method: string, path: string, body?: unknown) =>
    req(method, path, { authorization: `Bearer ${key}` }, body);
  const guest = (method: string, path: string, body?: unknown, token?: string) =>
    req(method, path, token ? { "x-access-token": token } : {}, body);
  const drain = async () => {
    for (let i = 0; i < 30; i++) {
      // What a request started in the background first, then what is due.
      while (pending.length) await pending.shift();
      const at = Math.max(clock.now, Date.now());
      if ((await inbox.runner.runDue(db, { limit: 100, now: at, join: false })).claimed === 0 && !pending.length)
        return;
    }
  };
  const settings = await owner("PUT", "/v1/owner/settings", {
    doc: {
      business: { name: opts.name, currency: opts.currency, timezone: opts.timezone },
      email: { fromAddress: "stays@example.org" },
      notifications: { ownerEmail: "owner@example.org", appUrl: BASE },
    },
  });
  expect(settings.status, await settings.clone().text()).toBe(200);
  return { db, inbox, mail, clock, owner, guest, drain, stripe };
}

export async function ok<T>(res: Promise<Response> | Response, status = 200): Promise<T> {
  const r = await res;
  const text = await r.clone().text();
  expect(r.status, text).toBe(status);
  return JSON.parse(text) as T;
}

export const OWNER: Caller["actor"] = { kind: "owner", id: "user_1", channel: "owner_ui" };
export const GUEST: Caller["actor"] = { kind: "customer_agent", id: "agent:test", channel: "rest" };

/** A caller on the test's clock: what the REST doors do with the real one. */
export function at(s: Setup, actor: Caller["actor"]): Caller {
  return {
    actor,
    tier: actor.kind === "owner" ? "verified_principal" : "anonymous",
    sandbox: false,
    now: () => s.clock.now,
  };
}
