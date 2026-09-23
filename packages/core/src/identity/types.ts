import type { PersonStanding } from "@surfingdog/spec";
import type { SignatureFailureCode, VerifiedSignature } from "../protocol/httpsig";

/**
 * People carried by their agents (ADR-017 §2, §8). A person is a record at a network; this inbox
 * never sees it, only what the agent carries (a key, a pass, a signature) and what each network
 * answers when those are presented: a pairwise id for this business (`ppid`) and a standing.
 *
 * The calls to networks are made by an `IdentityPort` the host plugs in (`@surfingdog/adapters`
 * implements it); everything written about what they answered is written here, in the batches of
 * the write path, so a create never waits on anything but its own presentations.
 */

/** The agent guide every answer and the manifest link to (R26). */
export const AGENT_GUIDE_URL = "https://surfingdog.ai/for-agents.md";

/** How the inbox saw the agent that made a request (§2.4): a signature is recorded, never required. */
export interface AgentSeen {
  /**
   * `vouched`: a platform's directory lists the key and a network this inbox reports to recognises
   * the platform (§4); `self`: the agent's own key, or a platform's no network recognises; `none`:
   * unsigned or failed.
   */
  readonly level: "vouched" | "self" | "none";
  /** The signing key's RFC 7638 thumbprint. */
  readonly thumbprint?: string | undefined;
  /** The origin of the platform whose directory listed the key: recorded, and trusted only when `vouched`. */
  readonly platform?: string | undefined;
  /** A label for the pass a network mints for this agent ("ChatGPT"), when the request names one. */
  readonly label?: string | undefined;
  /** The signature that verified, for forwarding as `agent_key` (§7.2). */
  readonly signature?: VerifiedSignature | undefined;
  /** Why a signature was there and did not verify; the request then counts as unsigned. */
  readonly invalid?: SignatureFailureCode | undefined;
}

export const NO_AGENT: AgentSeen = { level: "none" };

/** What a network answered about a presented person, as this inbox keeps it. */
export interface Presentation {
  /** The network's origin, as in `settings.networks`. */
  readonly network: string;
  readonly presentationId: string;
  readonly ppid: string;
  readonly person: PersonStanding;
  /** Whether the item's email is the person's: `proven` (by an emailed code), `unproven`, `no`. */
  readonly emailMatch?: "proven" | "unproven" | "no" | undefined;
  /** SHA-256 (hex) of the pass presented, when it was one: what stands in while the network is down. */
  readonly passHash?: string | undefined;
  /** A pass a key was exchanged for: handed back to the agent once, never stored. */
  readonly pass?: string | undefined;
  /**
   * How it was obtained: presented now (`pass`, `key`, `agent_key`), read from the cache, stood in
   * for by a stored link while the network was unreachable (`fallback`), or issued at first contact.
   */
  readonly via: "pass" | "key" | "agent_key" | "cache" | "fallback" | "issuance";
}

/** Why something the agent carried was not presented, per network, for the answer. */
export type PresentNote =
  | "unknown_pass"
  | "revoked"
  | "pass_requires_signature"
  | "not_enabled"
  | "unreachable"
  | "rate_limited"
  | "cannot_sign"
  /** A signature that would hand the network a secret (an access token in the URL, another pass): not forwarded. */
  | "carries_secret"
  | "malformed";

export interface PresentResult {
  readonly presentations: readonly Presentation[];
  readonly notes: readonly { readonly network: string; readonly note: PresentNote }[];
}

/** One network's answer to a first contact (`POST /v1/persons`). */
export type IssueResult =
  | {
      readonly network: string;
      readonly outcome: "issued";
      readonly key: string;
      readonly pass: string;
      readonly presentation: Presentation;
    }
  | { readonly network: string; readonly outcome: "person_exists" }
  | { readonly network: string; readonly outcome: "rate_limited" }
  | { readonly network: string; readonly outcome: "unreachable" | "refused"; readonly error: string };

/**
 * The calls to networks, plugged in by the host. Every one is time-boxed and fails open: a network
 * that cannot be reached leaves the customer `new` there, never refused (R25).
 */
export interface IdentityPort {
  /**
   * Presents what the agent carried to the enabled networks that issued it, first string per
   * network, in parallel: a pass, a key (exchanged for a pass), or a pass reference in a request
   * the agent signed (forwarded as `agent_key`).
   */
  present(input: {
    readonly credentials: readonly string[];
    readonly agent: AgentSeen;
    /** The item's contact email, so the answer says whether it is the person's. */
    readonly email?: string | undefined;
    readonly purpose: "request" | "ack";
    /** With `ack`: the receipt's sha. */
    readonly sha?: string | undefined;
    readonly now: number;
  }): Promise<PresentResult>;
  /** First contact (§2.1): asks each network for a key and a pass for the person at `email`. */
  issue(input: {
    readonly itemId: string;
    readonly email: string;
    readonly agent: AgentSeen;
    readonly networks: readonly string[];
    readonly now: number;
  }): Promise<IssueResult[]>;
  /** Whether this instance can sign its calls at all (it needs `INBOX_SECRET_KEY` and a public address). */
  canSign(): Promise<boolean>;
}

/** What the doors add to a create or status answer (§8.4). */
export interface IdentityAnswer {
  /** How sure the inbox is that this is a customer it knows. */
  readonly recognised: "strong" | "weak" | "none";
  /** Passes to keep, one per network: the first pass of a first contact, or the one a key became. */
  readonly passes: readonly { readonly network: string; readonly pass: string }[];
  /** On a weak match with an address to send it to: a one-time code proves the customer. */
  readonly verify: { readonly available: boolean; readonly sent_to: string | null };
  /** Per network, what happened to the person there. */
  readonly networks: readonly { readonly network: string; readonly state: string }[];
  readonly guide: string;
}
