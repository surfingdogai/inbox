import { DEFAULT_REPORT_NETWORK } from "./doors.js";
import type { AgentKeyInput } from "./keys.js";
import { signRequest } from "./sign.js";

/**
 * A `fetch` that signs the requests it sends to a network (sdi-agent/1 with your key, or Web Bot Auth as
 * your platform), for clients that take a `fetch` of their own: the MCP TypeScript SDK's
 * `StreamableHTTPClientTransport({ fetch })`, an OpenAPI client, or plain calls. Signed, your reads of
 * a network count against your own allowance once your signed door reports made you a contributor
 * (protocol §4.15), and a report sent through its MCP server is yours.
 *
 *   const transport = new StreamableHTTPClientTransport(new URL("https://surfingdog.ai/mcp"), {
 *     fetch: signingFetch({ key }),
 *   });
 *
 * It signs only requests to `origins`: by default the default network's, `https://network.surfingdog.ai`
 * and `https://surfingdog.ai` (which serves the same doors). Every other request goes unsigned, so that
 * no business you call sees one key across all of them. Add a business's origin only for an Inbox door
 * that verifies sdi-agent/1 (ADR-017 §2.4), where it tells the business whose agent called.
 *
 * The body is read once to sign its digest and sent as read. A URL that carries a credential is refused
 * (`SigningError`), as `signRequest` refuses it.
 */

/** The origins `signingFetch` signs for by default: the default network's two hosts. */
const DEFAULT_SIGNED_ORIGINS = [`https://${DEFAULT_REPORT_NETWORK}`, "https://surfingdog.ai"];

export interface SigningFetchOptions {
  readonly key: AgentKeyInput;
  /** Web Bot Auth: the platform whose key directory lists your key. Without it, your own key's sdi-agent/1. */
  readonly platform?: string | undefined;
  /** Pass references to carry in `Sdi-Pass`, signed. */
  readonly passes?: readonly string[] | undefined;
  /**
   * The origins whose requests are signed; the default network's by default (`https://network.surfingdog.ai`,
   * `https://surfingdog.ai`). Requests to any other origin go unsigned.
   */
  readonly origins?: readonly string[] | undefined;
  /** The `fetch` that sends; the global one by default. */
  readonly fetch?: typeof fetch | undefined;
}

export function signingFetch(opts: SigningFetchOptions): typeof fetch {
  const send = opts.fetch ?? fetch;
  const origins = (opts.origins ?? DEFAULT_SIGNED_ORIGINS).map((o) => new URL(o).origin);
  const signed = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    if (!origins.includes(new URL(req.url).origin)) return send(req);
    const body = req.body ? new Uint8Array(await req.arrayBuffer()) : undefined;
    const sig = await signRequest({
      method: req.method,
      url: req.url,
      body,
      key: opts.key,
      ...(opts.platform ? { platform: opts.platform } : {}),
      ...(opts.passes && opts.passes.length > 0 ? { passes: opts.passes } : {}),
    });
    const headers = new Headers(req.headers);
    for (const [name, value] of Object.entries(sig.headers)) headers.set(name, value);
    return send(req.url, {
      method: req.method,
      headers,
      ...(body ? { body } : {}),
      redirect: req.redirect,
      signal: req.signal,
      ...(init?.keepalive ? { keepalive: true } : {}),
    });
  };
  return signed as typeof fetch;
}
