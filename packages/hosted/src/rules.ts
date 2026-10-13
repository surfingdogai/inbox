import { isOwnerPage, ownerVerdict, readOnlyAllows } from "./allowlist";
import type { Resolved } from "./types";

/** The paths the router answers itself, for any tenant, at either of its names. */
export const SECURITY_TXT_PATH = "/.well-known/security.txt";
export const ROBOTS_PATH = "/robots.txt";
/** "Report this inbox": a page that says where to write, served by the router for every tenant. */
export const REPORT_PATH = "/report-inbox";
export const MANIFEST = "/.well-known/agent-inbox.json";
export const JWKS = "/.well-known/jwks.json";

/** What the router does with one request, once it knows the tenant. */
export type Decision =
  /** To the tenant's shard; `readOnly` when only reads (and sign-in, and the download) may pass. */
  | { readonly kind: "proxy"; readonly readOnly: boolean }
  /** The router's own page that names nobody: "This inbox is being set up." */
  | { readonly kind: "neutral" }
  | { readonly kind: "redirect"; readonly location: string }
  /** 404; `movedTo` when the inbox is now at its own name (a slug host after going live). */
  | { readonly kind: "not_found"; readonly movedTo?: string | undefined }
  /** 410: the inbox has closed. */
  | { readonly kind: "gone" }
  /** The public keys a closed inbox signed with, which keep serving. */
  | { readonly kind: "jwks" }
  /** 423: suspended, or read-only and this is a write. */
  | { readonly kind: "locked"; readonly why: "suspended" | "read_only" }
  /** 503: the certificate for its own name is still being issued. */
  | { readonly kind: "connecting" };

export interface RouterRequest {
  readonly method: string;
  /** Normalised (dot segments resolved), without the query. */
  readonly path: string;
  /** `?…` or empty. */
  readonly search: string;
  readonly cookie?: string | null | undefined;
  readonly authorization?: string | null | undefined;
}

/**
 * The host rules (C1.4), for a request whose host the resolver found. The state a suspended or
 * closing tenant came from decides what it is otherwise; a closing one is read-only on top.
 *
 * A slug host never serves agents. Below level 2 it serves the owner allowlist; at level 2 an owner
 * page redirects (308) to the inbox's own name and everything else is 404, saying where it is now.
 * An own host is everything at level 2, the owner allowlist after its DNS was lost, and a guard
 * while the certificate is issued.
 */
export function decide(r: Resolved, req: RouterRequest): Decision {
  const method = req.method.toUpperCase();
  const from = r.state === "suspended" || r.state === "closing" ? (r.prevState ?? "setup") : r.state;
  const closing = r.state === "closing";
  const suspended = r.state === "suspended";
  const owner = ownerVerdict({ method, path: req.path, cookie: req.cookie, authorization: req.authorization });
  // Below level 2, wherever it is asked for: the owner allowlist, read-only while closing.
  const ownerOnly = (): Decision => {
    if (owner === "refuse") return { kind: "not_found" };
    if (owner === "neutral") return { kind: "neutral" };
    if (closing && !readOnlyAllows(method, req.path)) return { kind: "locked", why: "read_only" };
    return { kind: "proxy", readOnly: closing };
  };

  if (r.state === "closed") {
    if (r.kind === "own" && req.path === JWKS && (method === "GET" || method === "HEAD")) return { kind: "jwks" };
    return { kind: "gone" };
  }

  if (r.kind === "slug") {
    if (r.level === 2) {
      const moved = r.ownHost ? `https://${r.ownHost}` : undefined;
      // The owner's pages move to the inbox's own name. Sign-in links and the API do not follow:
      // a sign-in names the host it was made for, and the owner signs in again at the new one.
      const page = req.path === "/" || isOwnerPage(req.path);
      if (moved && page && (method === "GET" || method === "HEAD")) {
        return { kind: "redirect", location: `${moved}${req.path}${req.search}` };
      }
      return { kind: "not_found", movedTo: moved };
    }
    return ownerOnly();
  }

  // Its own name.
  if (from === "cert_pending" && !suspended && !closing) return { kind: "connecting" };
  if (from === "live") {
    if (suspended) {
      // The owner can still sign in, read why and take a copy; nobody else gets anything.
      if (owner === "allow") return { kind: "proxy", readOnly: false };
      return { kind: "locked", why: "suspended" };
    }
    if (closing) {
      if (!readOnlyAllows(method, req.path)) return { kind: "locked", why: "read_only" };
      return { kind: "proxy", readOnly: true };
    }
    return { kind: "proxy", readOnly: false };
  }
  // Below level 2 at its own name (the record was lost, or anything else not live): owner only.
  return ownerOnly();
}
