import type { Actor } from "../domain/types";

export type TrustTier = "anonymous" | "signed_agent" | "verified_principal" | "reputed_principal";

/** Who is writing, through which door, with what proof. Built by the adapters, consumed by core. */
export interface Caller {
  readonly actor: Actor;
  readonly tier: TrustTier;
  readonly sandbox: boolean;
  readonly locale?: string;
  /** Present for every agent and API write; adapters derive the scope from the principal and door. */
  readonly idempotency?: { readonly scope: string; readonly key: string };
  /** Capability secret an anonymous creator received with its item. */
  readonly accessToken?: string;
  readonly now?: () => number;
}

export const CUSTOMER_KINDS = new Set(["customer_agent", "customer_human"]);

export function isCustomer(caller: Caller): boolean {
  return CUSTOMER_KINDS.has(caller.actor.kind);
}

export function nowOf(caller: Caller): number {
  return caller.now ? caller.now() : Date.now();
}
