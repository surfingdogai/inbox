import type { Actor, ActorKind } from "../domain/types";
import type { AgentSeen } from "../identity/types";

export type TrustTier = "anonymous" | "signed_agent" | "verified_principal" | "reputed_principal";

/**
 * Who stands behind an owner-side caller, as the door established it: how it proved itself, the
 * scopes it holds, and a name the owner recognises in the history. Internal callers (the rules
 * engine, jobs, the command line, tests) carry none and are never narrowed by scopes.
 */
export interface Principal {
  /** How the caller proved itself. */
  readonly via: "session" | "api_key" | "oauth";
  /** The key id, the OAuth client id, or the session id. */
  readonly id: string;
  /** The key's name, the AI app's name, or the signed-in person's address. */
  readonly name: string;
  readonly scopes: readonly string[];
  /** The person behind it, when there is one (sessions and OAuth grants). */
  readonly userId: string | null;
  /**
   * For a key: a full owner key (the command line) or an integration key minted in the product,
   * which is named, scoped and revocable, and acts as its own actor in the history.
   */
  readonly keyKind?: "owner" | "integration" | undefined;
}

/** Who is writing, through which door, with what proof. Built by the adapters, consumed by core. */
export interface Caller {
  /** Who did it: what the history, the event stream and the webhooks record. */
  readonly actor: Actor;
  /**
   * The kind the state machines judge this caller as, when it is not `actor.kind`. The owner's AI
   * (`owner_ai`) and an integration key (`integration`) act with the owner's rights today; what
   * narrows them is their scopes, not the machines, so their writes are allowed exactly as before
   * while the history still says who made them.
   */
  readonly actsAs?: ActorKind | undefined;
  readonly principal?: Principal | undefined;
  readonly tier: TrustTier;
  readonly sandbox: boolean;
  readonly locale?: string;
  /** Present for every agent and API write; adapters derive the scope from the principal and door. */
  readonly idempotency?: { readonly scope: string; readonly key: string };
  /** Capability secret an anonymous creator received with its item. */
  readonly accessToken?: string;
  /**
   * How the agent signed the request (ADR-017 §2.4), as the door verified it: recorded on what it
   * creates, forwarded to a network as `agent_key` when it carries a pass reference. Absent: unsigned.
   */
  readonly agent?: AgentSeen | undefined;
  /** The strings the agent carried in `Sdi-Pass` (passes, pass references), at most eight. */
  readonly carried?: readonly string[] | undefined;
  readonly now?: () => number;
}

export const CUSTOMER_KINDS = new Set(["customer_agent", "customer_human"]);

export function isCustomer(caller: Caller): boolean {
  return CUSTOMER_KINDS.has(caller.actor.kind);
}

export function nowOf(caller: Caller): number {
  return caller.now ? caller.now() : Date.now();
}

/** The actor kind the state machines check: `actsAs` when the door set one, else the actor itself. */
export function permissionKind(caller: Caller): ActorKind {
  return caller.actsAs ?? caller.actor.kind;
}

/**
 * The owner in person: signed in to the owner app, or holding a full owner key from the command
 * line. Not their AI and not a key they handed to another system. Only this caller may change the
 * `security` settings, which is what makes "the owner grants it once" mean the owner.
 */
export function isOwnerInPerson(caller: Caller): boolean {
  if (caller.actor.kind !== "owner") return false;
  const p = caller.principal;
  if (!p) return true;
  return p.via === "session" || (p.via === "api_key" && p.keyKind !== "integration");
}

/**
 * A person at the business: the owner or staff, signed in or with a full owner key — not the owner's
 * AI, not a rule, not a key handed to another system. Only a person may record a yes the customer
 * gave a person (`byPerson` transitions), and only a person may book inside the minimum notice.
 * Whatever comes through the owner's MCP is an assistant's, even with a full owner key: the same
 * test the `security` settings use.
 */
export function isPerson(caller: Caller): boolean {
  if (caller.actor.kind !== "owner" && caller.actor.kind !== "staff") return false;
  if (caller.actor.channel === "mcp_owner") return false;
  return caller.principal?.keyKind !== "integration";
}

/**
 * The owner's AI: an AI app the owner connected (`owner_ai`), or anything that comes through the
 * owner's MCP, even with a full owner key — the test `isPerson` and the `security` settings use.
 * It may do what the owner does with time, never with money (Tiago, 23 September 2026): no promise
 * on a price the customer set, no catalogue price, no quote, no feed. It drafts for the owner instead.
 */
export function isOwnerAssistant(caller: Caller): boolean {
  if (caller.actor.kind === "owner_ai") return true;
  return !isCustomer(caller) && caller.actor.channel === "mcp_owner";
}

/**
 * What goes into an event's `meta` about who made it, beyond the actor kind and id: the name the
 * owner knows a key or an AI app by, the person behind it, and the kind it acted as (`acts_as`,
 * which the rules judge it by, as the state machines do). Never a scope list, never a secret,
 * and never the signed-in person's address: the name travels in events to other systems.
 */
export function actorMeta(caller: Caller): { actor_name?: string; user_id?: string; acts_as?: string } {
  const p = caller.principal;
  const actsAs = caller.actsAs && caller.actsAs !== caller.actor.kind ? { acts_as: caller.actsAs } : {};
  if (!p || isCustomer(caller)) return actsAs;
  return {
    ...(p.via === "session" ? {} : { actor_name: p.name.slice(0, 120) }),
    ...(p.userId ? { user_id: p.userId } : {}),
    ...actsAs,
  };
}

/**
 * The scope an idempotency key lives in. The owner and the owner's AI share one scope — the
 * business — so the same key sent through REST and then through MCP, or by two AI clients of the
 * same owner, is one request, not two. An integration key is another system with keys of its own
 * (an order number, a Zap run id), so it gets a scope of its own on every door: two systems that
 * happen to pick the same key never collide, and neither can learn from a refusal what the other
 * sent. Customers keep a scope of their own per principal and door.
 */
export function idempotencyScope(caller: Caller): string {
  if (caller.principal?.keyKind === "integration") return `integration:${caller.principal.id}`;
  if (!isCustomer(caller)) return "business";
  return caller.idempotency?.scope ?? `${caller.actor.kind}:${caller.actor.id}:${caller.actor.channel}`;
}

/** The caller with an idempotency key attached, in the scope `idempotencyScope` gives it. */
export function withIdempotencyKey(caller: Caller, key: string | undefined): Caller {
  if (!key) return caller;
  return { ...caller, idempotency: { scope: idempotencyScope(caller), key } };
}

/** Who caused an event, as the history, the event stream and the webhooks show it. */
export interface EventActor {
  /** `owner`, `owner_ai`, `integration`, `connector`, `rule`, `system`, `customer_agent`, `customer_human`. */
  readonly kind: string;
  /** The user, AI app (OAuth client) or key id. Null for a customer, and where nobody acted (a receipt). */
  readonly id: string | null;
  /** The name of the key or AI app, as the owner named it. */
  readonly name?: string | undefined;
}

/** Who caused an event. A customer's id is not given out: it is a fingerprint, and events travel. */
export function eventActor(kind: string, id: string | null, name?: string | null): EventActor {
  const customer = CUSTOMER_KINDS.has(kind);
  return { kind, id: customer ? null : id, ...(name && !customer ? { name } : {}) };
}
