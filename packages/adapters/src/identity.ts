import {
  type AgentSeen,
  agentKeyOf,
  type Capabilities,
  canonicalNetworkOrigin,
  type Db,
  ensureJob,
  IDENTITY_ISSUE_KIND,
  type IdentityPort,
  type IssueResult,
  isEd25519PublicJwk,
  isPublicHost,
  issuanceStatements,
  issueJobKey,
  itemStopped,
  type JobHandler,
  mayReceiveEmails,
  normaliseEmail,
  PENDING_TTL_MS,
  type Presentation,
  type PresentNote,
  type PresentResult,
  parseCredential,
  parsePassHeader,
  passRefOf,
  platformRecognised,
  readSettings,
  type Settings,
  secretHash,
  signInstanceRequest,
  thumbprint,
  valueHash,
  verifiedNetworks,
  verifyAgentRequest,
} from "@surfingdog/core";
import { z } from "zod";
import { clientAddress, consume } from "./limits";
import { instanceDomain } from "./network";
import { readCapped } from "./safe-fetch";

/**
 * People at the doors (ADR-017 §2, §8.1): the inbox's side of the network protocol.
 *
 * - `createIdentityPort` makes the two calls an inbox makes about a person, both signed
 *   sdi-instance/1 with the receipt key: `POST /v1/presentations` (what an agent carried) and
 *   `POST /v1/persons` (a first contact). Every call is time-boxed at 3 s, runs in parallel across
 *   networks, and fails open; after three failures in a row a network is skipped for a minute.
 *   Answers are cached by hash only (`network_cache`): a presentation for an hour (or a shorter
 *   `max-age`), a revoked pass likewise, a `person_exists` for a day; an acknowledgement never.
 *   Only while a network is unreachable does a stored link stand in, by the pass's hash.
 * - `agentFromRequest` verifies an agent's signature (sdi-agent/1, Web Bot Auth compatible),
 *   keeps each signature once (`sig_nonces`), and reads `Sdi-Pass`.
 * - `identityIssueHandler` asks again for a first contact the request could not finish.
 */
const CALL_TIMEOUT_MS = 3_000;
const BREAKER_FAILURES = 3;
const BREAKER_MS = 60_000;
const CACHE_TTL_S = 3_600;
const EXISTS_TTL_MS = 24 * 3_600_000;
const MAX_BODY = 16 * 1024;
/** Web Bot Auth directories (§2.4): 5 s, 64 KB, cached between five minutes and a day, failures five minutes. */
const DIRECTORY_TIMEOUT_MS = 5_000;
const DIRECTORY_MAX_BYTES = 64 * 1024;
const DIRECTORY_MIN_S = 300;
const DIRECTORY_MAX_S = 86_400;

export interface IdentityDeps {
  readonly db: Db;
  readonly caps: Capabilities;
  readonly baseUrl?: string | undefined;
  readonly version: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

type CallResult =
  | { readonly status: number; readonly text: string; readonly maxAge: number | null }
  | { readonly error: string };

const standingSchema = z.looseObject({
  tier: z.enum(["new", "building", "trusted"]).catch("new"),
  score: z.number().min(0).max(1).catch(0),
  kept: z.number().catch(0),
  broken: z.number().catch(0),
  businesses: z.number().catch(0),
  email_proven: z.boolean().catch(false),
  since: z.string().catch(""),
  unusual_use: z.boolean().catch(false),
  rules: z.number().catch(1),
});
const presentedSchema = z.looseObject({
  presentation: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  ppid: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  person: standingSchema,
  pass: z.string().max(200).optional(),
  email_match: z.enum(["proven", "unproven", "no"]).optional(),
});
const issuedSchema = z.looseObject({
  key: z.string().max(200),
  pass: z.string().max(200),
  presentation: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  ppid: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  person: standingSchema,
});

export function createIdentityPort(deps: IdentityDeps): IdentityPort {
  const breaker = new Map<string, { fails: number; until: number }>();
  const down = (network: string) => (breaker.get(network)?.until ?? 0) > Date.now();
  const failed = (network: string) => {
    const b = breaker.get(network) ?? { fails: 0, until: 0 };
    b.fails++;
    if (b.fails >= BREAKER_FAILURES) b.until = Date.now() + BREAKER_MS;
    breaker.set(network, b);
  };
  const answered = (network: string) => breaker.delete(network);

  const instance = async (): Promise<string | null> => {
    if (!deps.caps.secrets) return null;
    const settings = await readSettings(deps.db);
    const d = instanceDomain(deps, settings);
    return "domain" in d ? `https://${d.domain}` : null;
  };

  /** One signed POST to a network, time-boxed end to end, no redirects, only to a network origin. */
  const post = async (network: string, path: string, body: unknown): Promise<CallResult> => {
    const origin = await instance();
    if (!origin) return { error: "this inbox cannot sign: it needs INBOX_SECRET_KEY and a public address" };
    if (canonicalNetworkOrigin(network) !== network) return { error: `${network} is not a network origin` };
    const url = `${network}${path}`;
    const text = JSON.stringify(body);
    const key = await deps.caps.receipts.keys.active();
    // Signed with the real clock: the network checks `created` against its own.
    const signed = await signInstanceRequest({
      method: "POST",
      url,
      body: text,
      instance: origin,
      key: { kid: key.kid, privateJwk: key.privateJwk },
    });
    const controller = new AbortController();
    const timeoutMs = deps.timeoutMs ?? CALL_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await (deps.fetchImpl ?? fetch)(url, {
        method: "POST",
        body: text,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          ...signed.headers,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": `surfingdog-inbox/${deps.version}`,
        },
      });
      const out = (await readCapped(res, MAX_BODY)) ?? "";
      return { status: res.status, text: out, maxAge: maxAgeOf(res.headers.get("cache-control")) };
    } catch (error) {
      return {
        error: controller.signal.aborted
          ? `no answer within ${timeoutMs} ms`
          : `could not connect: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const cacheGet = async (network: string, kind: string, key: string, now: number): Promise<unknown> => {
    const { rows } = await deps.db.client.query({
      sql: "SELECT value FROM network_cache WHERE network = ? AND kind = ? AND key = ? AND expires_at > ?",
      params: [network, kind, key, now],
      method: "all",
    });
    const v = rows[0]?.[0];
    if (typeof v !== "string") return undefined;
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  };
  const cachePut = async (network: string, kind: string, key: string, value: unknown, ttlMs: number, now: number) => {
    await deps.db.client.query({
      sql: `INSERT INTO network_cache (network, kind, key, value, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (network, kind, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      params: [network, kind, key, JSON.stringify(value), now + ttlMs, now],
      method: "run",
    });
  };

  /** While a network cannot be reached, a pass whose hash a link here holds stands in, with the last standing. */
  const fallback = async (network: string, passHash: string | undefined): Promise<Presentation | null> => {
    if (!passHash) return null;
    const { rows } = await deps.db.client.query({
      sql: "SELECT ppid, person FROM person_links WHERE network = ? AND pass_hash = ? LIMIT 1",
      params: [network, passHash],
      method: "all",
    });
    const r = rows[0];
    if (!r) return null;
    const person = standingSchema.safeParse(typeof r[1] === "string" ? JSON.parse(r[1]) : {});
    return {
      network,
      presentationId: "",
      ppid: String(r[0]),
      person: (person.success ? person.data : standingSchema.parse({})) as Presentation["person"],
      passHash,
      via: "fallback",
    };
  };

  const presentOne = async (
    raw: string,
    input: Parameters<IdentityPort["present"]>[0],
    settings: Settings,
    verified: ReadonlySet<string>,
  ): Promise<{ presentation?: Presentation; note?: { network: string; note: PresentNote } }> => {
    const c = parseCredential(raw);
    if (!c) return {};
    const network = `https://${c.host}`;
    const note = (n: PresentNote) => ({ note: { network, note: n } });
    if (!settings.networks[network]?.enabled) return note("not_enabled");
    const signature = input.agent.signature;
    // What goes to the network: a pass as it is, a key to exchange, or — for a pass reference, or
    // any acknowledgement — the agent's own signature, forwarded (§7.2).
    let credential: Record<string, unknown>;
    if (input.purpose === "ack" || c.kind === "pass_ref") {
      if (!signature) return note("pass_requires_signature");
      const ref = passRefOf(raw);
      if (!ref) return note("malformed");
      // The base travels as signed, so one that holds a secret — the item's access token in the
      // URL, another pass or key in a signed Sdi-Pass, a covered X-Access-Token, Authorization or
      // Cookie header — would hand it to this network. Not sent.
      if (!forwardable(signature.components) || carriesSecret(signature.signatureBase)) return note("carries_secret");
      credential = { agent_key: agentKeyOf(signature, ref) };
    } else if (c.kind === "key") {
      credential = { key: raw };
    } else {
      credential = { pass: raw };
    }
    const passHash = c.kind === "pass" ? await secretHash(raw) : undefined;
    // The customer's address goes beside the pass only to a network that has verified this inbox
    // (or the default one); another still sees the pass, and learns nothing of the address.
    const email = input.email && mayReceiveEmails(network, verified) ? normaliseEmail(input.email) : null;
    const cacheKey = passHash && input.purpose === "request" ? await secretHash(`${raw}|${email ?? ""}`) : undefined;
    if (cacheKey) {
      const hit = (await cacheGet(network, "presentation", cacheKey, input.now)) as
        | { revoked?: boolean; presentation?: string; ppid?: string; person?: unknown; email_match?: string }
        | undefined;
      if (hit?.revoked) return note("revoked");
      const parsed = presentedSchema.safeParse(hit);
      if (hit && parsed.success) return { presentation: toPresentation(network, parsed.data, "cache", passHash) };
    }
    if (down(network)) {
      const f = await fallback(network, passHash);
      return f ? { presentation: f } : note("unreachable");
    }
    const res = await post(network, "/v1/presentations", {
      ...credential,
      purpose: input.purpose,
      ...(input.purpose === "ack" && input.sha ? { sha: input.sha } : {}),
      ...(input.purpose === "request" && email ? { email } : {}),
      ...agentField(input.agent),
    });
    if (!("status" in res)) {
      failed(network);
      const f = await fallback(network, passHash);
      return f ? { presentation: f } : note("unreachable");
    }
    if (res.status >= 500 || res.status === 429 || res.status === 408) {
      if (res.status !== 429) failed(network);
      const f = await fallback(network, passHash);
      return f ? { presentation: f } : note(res.status === 429 ? "rate_limited" : "unreachable");
    }
    answered(network);
    const code = problemCode(res.text);
    if (res.status === 200 || res.status === 201) {
      const parsed = presentedSchema.safeParse(safeJson(res.text));
      if (!parsed.success) return note("malformed");
      // A pass made from a key goes back to the agent: only a pass of this network, nothing else.
      if (parsed.data.pass !== undefined && !isCredentialOf(parsed.data.pass, "pass", network))
        return note("malformed");
      if (cacheKey) {
        const ttl = Math.min(CACHE_TTL_S, res.maxAge ?? CACHE_TTL_S) * 1000;
        if (ttl > 0) await cachePut(network, "presentation", cacheKey, parsed.data, ttl, input.now);
      }
      const via = c.kind === "key" ? "key" : c.kind === "pass" && input.purpose === "request" ? "pass" : "agent_key";
      return { presentation: toPresentation(network, parsed.data, via, passHash) };
    }
    if (res.status === 410 || code === "revoked") {
      if (cacheKey) await cachePut(network, "presentation", cacheKey, { revoked: true }, CACHE_TTL_S * 1000, input.now);
      return note("revoked");
    }
    if (code === "pass_requires_signature" || res.status === 403) return note("pass_requires_signature");
    if (code === "unknown_pass" || res.status === 404) return note("unknown_pass");
    return note("malformed");
  };

  return {
    async canSign() {
      return (await instance()) !== null;
    },

    async present(input): Promise<PresentResult> {
      const settings = await readSettings(deps.db);
      if (!(await instance())) {
        return {
          presentations: [],
          notes: input.credentials
            .map((s) => parseCredential(s))
            .filter((c) => c !== null)
            .map((c) => ({ network: `https://${c.host}`, note: "cannot_sign" as const })),
        };
      }
      const verified = input.email ? await verifiedNetworks(deps.db) : new Set<string>();
      const results = await Promise.all(input.credentials.map((raw) => presentOne(raw, input, settings, verified)));
      return {
        presentations: results.flatMap((r) => (r.presentation ? [r.presentation] : [])),
        notes: results.flatMap((r) => (r.note ? [r.note] : [])),
      };
    },

    async issue(input): Promise<IssueResult[]> {
      const email = normaliseEmail(input.email);
      return Promise.all(
        input.networks.map(async (network): Promise<IssueResult> => {
          if (!email)
            return { network, outcome: "refused", error: "the email cannot be normalised: no email, no issuance" };
          const emailKey = await valueHash("email", email);
          if (await cacheGet(network, "person_exists", emailKey, input.now))
            return { network, outcome: "person_exists" };
          if (down(network)) return { network, outcome: "unreachable", error: "not answering; asked again later" };
          const res = await post(network, "/v1/persons", {
            request_id: input.itemId,
            email: input.email.trim(),
            ...agentField(input.agent),
          });
          if (!("status" in res)) {
            failed(network);
            return { network, outcome: "unreachable", error: res.error };
          }
          if (res.status >= 500 || res.status === 408) {
            failed(network);
            return { network, outcome: "unreachable", error: `HTTP ${res.status}` };
          }
          answered(network);
          const code = problemCode(res.text);
          if (res.status === 201 || res.status === 200) {
            const parsed = issuedSchema.safeParse(safeJson(res.text));
            if (!parsed.success) return { network, outcome: "refused", error: "the network's answer did not parse" };
            const d = parsed.data;
            // The key rides on an email from the business and the pass goes to the agent: each must be
            // exactly this network's key or pass, never text of the network's choosing.
            if (!isCredentialOf(d.key, "key", network) || !isCredentialOf(d.pass, "pass", network)) {
              return { network, outcome: "refused", error: "the network's key or pass is not one of its own" };
            }
            return {
              network,
              outcome: "issued",
              key: d.key,
              pass: d.pass,
              presentation: {
                network,
                presentationId: d.presentation,
                ppid: d.ppid,
                person: d.person as Presentation["person"],
                passHash: await secretHash(d.pass),
                via: "issuance",
              },
            };
          }
          if (res.status === 409 || code === "person_exists") {
            await cachePut(network, "person_exists", emailKey, { at: input.now }, EXISTS_TTL_MS, input.now);
            return { network, outcome: "person_exists" };
          }
          if (res.status === 429) return { network, outcome: "rate_limited" };
          // Not listed yet, or our key not known yet: the network's state, asked again later.
          if (res.status === 401 || res.status === 404) {
            return { network, outcome: "unreachable", error: `HTTP ${res.status}${code ? ` ${code}` : ""}` };
          }
          return { network, outcome: "refused", error: `HTTP ${res.status}${code ? ` ${code}` : ""}` };
        }),
      );
    },
  };
}

/** Whether `s` is a key (or a pass, with its secret) issued by the network at `origin`. */
function isCredentialOf(s: string, kind: "key" | "pass", origin: string): boolean {
  const c = parseCredential(s);
  return c !== null && c.kind === kind && `https://${c.host}` === origin;
}

function toPresentation(
  network: string,
  d: z.infer<typeof presentedSchema>,
  via: Presentation["via"],
  passHash: string | undefined,
): Presentation {
  return {
    network,
    presentationId: d.presentation,
    ppid: d.ppid,
    person: d.person as Presentation["person"],
    ...(d.email_match ? { emailMatch: d.email_match } : {}),
    ...(passHash ? { passHash } : {}),
    ...(d.pass ? { pass: d.pass } : {}),
    via,
  };
}

/**
 * Whether a signature base holds something no network may see: a key, a pass with its secret or a
 * session (in a signed `Sdi-Pass`, say), or an `access_token` in the signed query. A forwarded
 * signature carries its base whole (§7.2), so such a signature is never forwarded; the agent's
 * guide says to send the token in `X-Access-Token` and to sign only pass references.
 */
export function carriesSecret(base: string): boolean {
  if (/sd(?:key|pass)1_[a-z0-9.-]+_[a-z2-7]{16}_[a-z2-7]{32}/.test(base) || /sdps_[a-z2-7]{32}/.test(base)) return true;
  const query = /^"@query": \?(.*)$/m.exec(base)?.[1] ?? "";
  return query.split("&").some((p) => {
    let name = p.split("=")[0] ?? "";
    try {
      name = decodeURIComponent(name.replace(/\+/g, " "));
    } catch {
      // A name that does not decode is compared as it is.
    }
    return name.toLowerCase() === "access_token";
  });
}

/**
 * The components a forwarded signature may cover: the ones sdi-agent/1 requires, and `Content-Type`.
 * Any other covered header would travel to the network whole, and headers carry secrets (an item's
 * `X-Access-Token`, an API key in `Authorization`, a `Cookie`), so such a signature is not forwarded.
 */
const FORWARDABLE = new Set(["@method", "@authority", "@path", "@query", "content-digest", "content-type", "sdi-pass"]);
const FORWARDABLE_KEYED = new Set(["sdi-agent-key", "signature-agent"]);

export function forwardable(components: readonly { readonly name: string; readonly key?: string }[]): boolean {
  return components.every((c) =>
    c.key === undefined ? FORWARDABLE.has(c.name) || c.name === "signature-agent" : FORWARDABLE_KEYED.has(c.name),
  );
}

/** The carrying agent as a network records it: a label for the pass, its key, its platform (§7.1). */
function agentField(agent: AgentSeen): { agent?: Record<string, string> } {
  const out: Record<string, string> = {};
  const label = agent.label
    ?.replace(/[\p{Cc}]/gu, "")
    .trim()
    .slice(0, 64);
  if (label) out.label = label;
  if (agent.thumbprint && /^[A-Za-z0-9_-]{43}$/.test(agent.thumbprint)) out.jkt = agent.thumbprint;
  if (agent.platform && /^https:\/\//.test(agent.platform) && agent.platform.length <= 512)
    out.directory = agent.platform;
  return Object.keys(out).length ? { agent: out } : {};
}

function maxAgeOf(header: string | null): number | null {
  const m = header ? /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(header) : null;
  return m ? Number(m[1]) : null;
}

function problemCode(text: string): string | null {
  const body = safeJson(text) as { code?: unknown } | null;
  return typeof body?.code === "string" && body.code.length <= 64 ? body.code : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---- the signature on an agent's request ------------------------------------------------------

export interface AgentOptions {
  readonly baseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: number | undefined;
  /**
   * Who sends the request and the `Idempotency-Key` header it carries: kept with a signature the
   * first time it is seen, so that the same signature again counts as a retry only from the same
   * sender with the same key (a key in the body is covered by the signature's digest already).
   */
  readonly retryAs?: string | undefined;
}

export interface AgentOnRequest {
  readonly agent: AgentSeen;
  /** What `Sdi-Pass` carried: at most eight strings. */
  readonly carried: string[];
  /** The same signature was seen before, on a request that changes something. */
  readonly replayed: boolean;
  /**
   * For a `replayed` signature: the first request came from the same sender with the same
   * `Idempotency-Key` header, so this may be its retry. Anything else is a copy.
   */
  readonly retry?: boolean | undefined;
  /** `Sdi-Signature: invalid; reason="…"` for a signature that did not verify. */
  readonly header?: string | undefined;
}

/**
 * The agent behind a request (§2.4): unsigned is `none`; a signature that fails counts as unsigned,
 * said in `Sdi-Signature`; one that verifies is `vouched` when a platform's directory lists the key
 * **and** a network this inbox reports to recognises that platform (§4), and otherwise `self`: a
 * directory anyone can publish vouches for nothing on its own. `platform` names the directory
 * either way, for the record and the platform's rate limit. A signature on a request that changes
 * something is kept until it expires, so a copy of it is seen (`replayed`); the door answers it
 * from the idempotency key it carries, or refuses it.
 */
export async function agentFromRequest(db: Db, request: Request, opts: AgentOptions = {}): Promise<AgentOnRequest> {
  const now = opts.now ?? Date.now();
  const passHeader = request.headers.get("sdi-pass");
  const carried = passHeader ? (parsePassHeader(passHeader) ?? []) : [];
  const label = labelOf(request);
  if (request.headers.get("signature-input") === null) {
    return { agent: { level: "none", ...(label ? { label } : {}) }, carried, replayed: false };
  }
  const settings = await readSettings(db);
  const body =
    request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(await request.clone().arrayBuffer());
  const v = await verifyAgentRequest({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body,
    authorities: authoritiesOf(opts.baseUrl, settings),
    now,
    platformKey: (origin, keyid) => platformKey(db, origin, keyid, clientAddress(request), opts),
  });
  if (v.status === "none") return { agent: { level: "none", ...(label ? { label } : {}) }, carried, replayed: false };
  if (v.status === "invalid") {
    return {
      agent: { level: "none", invalid: v.code, ...(label ? { label } : {}) },
      carried,
      replayed: false,
      header: `invalid; reason="${v.code}"`,
    };
  }
  let replayed = false;
  let retry = false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    // The signature, and beside it (only the first time: the batch is atomic) who sent it with
    // which idempotency key. A copy sent by anyone else, or with another key, is not a retry.
    const binding = `retry:${v.replayKey}`;
    const sender = await secretHash(`retry|${opts.retryAs ?? ""}`);
    const [first] = await db.batch([
      {
        sql: "INSERT OR IGNORE INTO sig_nonces (keyid, nonce, expires_at) VALUES (?, ?, ?)",
        params: [v.keyid, v.replayKey, v.replayUntil * 1000],
        method: "run",
      },
      {
        sql: `INSERT INTO sig_nonces (keyid, nonce, expires_at)
              SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM sig_nonces WHERE keyid = ?)`,
        params: [binding, sender, v.replayUntil * 1000, binding],
        method: "run",
      },
    ]);
    replayed = first?.changes === 0;
    if (replayed && opts.retryAs !== undefined) {
      const { rows } = await db.client.query({
        sql: "SELECT 1 FROM sig_nonces WHERE keyid = ? AND nonce = ?",
        params: [binding, sender],
        method: "all",
      });
      retry = rows.length > 0;
    }
  }
  const platformLabel = v.platform ? new URL(v.platform).host : undefined;
  const level =
    v.level === "vouched" && !(v.platform && (await platformRecognised(db, settings, v.platform))) ? "self" : v.level;
  return {
    agent: {
      level,
      thumbprint: v.keyid,
      ...(v.platform ? { platform: v.platform } : {}),
      ...((platformLabel ?? label) ? { label: platformLabel ?? label } : {}),
      signature: v,
    },
    carried,
    replayed,
    ...(replayed ? { retry } : {}),
  };
}

/** The hosts a signature may name (§2.4): `INBOX_PUBLIC_URL`'s, else the Inbox address's, and any extra. */
export function authoritiesOf(baseUrl: string | undefined, settings: Settings): string[] {
  const out: string[] = [];
  const base = baseUrl ?? settings.notifications.appUrl;
  if (base) {
    try {
      out.push(new URL(base).host);
    } catch {
      // Not a URL: no host of its own to answer on.
    }
  }
  for (const h of settings.identity.extraAuthorities) if (!out.includes(h)) out.push(h);
  return out;
}

/** A label for the pass a network mints for this agent: the first product of its User-Agent. */
function labelOf(request: Request): string | undefined {
  const ua = request.headers.get("user-agent")?.trim();
  const first = ua ? /^[A-Za-z0-9._ -]{1,64}?(?=\/|\s|$)/.exec(ua)?.[0]?.trim() : undefined;
  return first ? first.slice(0, 64) : undefined;
}

/**
 * A platform's Web Bot Auth directory (§2.4): fetched from a public host over https, at most 64 KB
 * in 5 s, following at most two redirects on the same host; kept for its `max-age` between five
 * minutes and a day, a failure for five minutes; and a new origin at most once a minute per
 * client address, so made-up platforms cannot drive fetches.
 */
async function platformKey(
  db: Db,
  origin: string,
  keyid: string,
  address: string,
  opts: AgentOptions,
): Promise<{ kty: "OKP"; crv: "Ed25519"; x: string } | null> {
  const now = opts.now ?? Date.now();
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !isPublicHost(url.hostname)) return null;
  const { rows } = await db.client.query({
    sql: "SELECT jwks, failures, expires_at FROM key_directories WHERE origin = ?",
    params: [url.origin],
    method: "all",
  });
  const cached = rows[0];
  let keys: unknown[] | null = null;
  if (cached && Number(cached[2]) > now) {
    if (Number(cached[1]) > 0) return null;
    keys = keysOf(typeof cached[0] === "string" ? safeJson(cached[0]) : cached[0]);
  } else {
    if (!cached) {
      const v = await consume(db, "directory", address, now);
      if (!v.allowed) return null;
    }
    const fetched = await fetchDirectory(url, opts.fetchImpl ?? fetch);
    const ttl = fetched
      ? Math.min(DIRECTORY_MAX_S, Math.max(DIRECTORY_MIN_S, fetched.maxAge ?? DIRECTORY_MIN_S))
      : DIRECTORY_MIN_S;
    await db.client.query({
      sql: `INSERT INTO key_directories (origin, jwks, etag, fetched_at, expires_at, failures) VALUES (?, ?, NULL, ?, ?, ?)
            ON CONFLICT (origin) DO UPDATE SET jwks = excluded.jwks, fetched_at = excluded.fetched_at,
              expires_at = excluded.expires_at, failures = excluded.failures`,
      params: [url.origin, JSON.stringify(fetched?.body ?? {}), now, now + ttl * 1000, fetched ? 0 : 1],
      method: "run",
    });
    if (!fetched) return null;
    keys = keysOf(fetched.body);
  }
  for (const k of keys ?? []) {
    if (!isEd25519PublicJwk(k)) continue;
    if ((await thumbprint(k)) === keyid) return { kty: "OKP", crv: "Ed25519", x: k.x };
  }
  return null;
}

function keysOf(body: unknown): unknown[] {
  const keys = (body as { keys?: unknown } | null)?.keys;
  return Array.isArray(keys) ? keys.slice(0, 64) : [];
}

async function fetchDirectory(
  url: URL,
  fetchImpl: typeof fetch,
): Promise<{ body: unknown; maxAge: number | null } | null> {
  const start = new URL("/.well-known/http-message-signatures-directory", url);
  // One deadline for the whole fetch, redirects included: it runs inside an agent's request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECTORY_TIMEOUT_MS);
  try {
    return await fetchDirectoryWithin(start, url, fetchImpl, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDirectoryWithin(
  start: URL,
  url: URL,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ body: unknown; maxAge: number | null } | null> {
  let current = start;
  for (let hop = 0; hop <= 2; hop++) {
    try {
      const res = await fetchImpl(current.href, {
        redirect: "manual",
        signal,
        headers: { accept: "application/http-message-signatures-directory+json, application/json" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        const next = new URL(loc, current);
        if (next.protocol !== "https:" || next.host !== url.host) return null;
        current = next;
        continue;
      }
      if (!res.ok) return null;
      const text = await readCapped(res, DIRECTORY_MAX_BYTES);
      if (text === null) return null;
      const body = safeJson(text);
      return body ? { body, maxAge: maxAgeOf(res.headers.get("cache-control")) } : null;
    } catch {
      return null;
    }
  }
  return null;
}

// ---- a first contact asked again ---------------------------------------------------------------

/**
 * A first contact the request could not finish (§2.1): asked again, with the same `request_id`, so
 * the network replays its answer if it gave one. No answer: again, backing off to six hours; the
 * network's daily limit: again tomorrow; after seven days, given up. The pass the network then
 * issues is handed back by the status door, and the key rides on the next email to the customer.
 */
export function identityIssueHandler(deps: IdentityDeps & { port: IdentityPort }): JobHandler {
  return async (job, { db, now }) => {
    const { itemId, network } = job.payload as { itemId: string; network: string };
    const { rows } = await db.client.query({
      sql: `SELECT p.state, p.attempts, p.created_at, i.party_id, json_extract(pa.contact, '$.email'),
                   i.agent_thumbprint, i.agent_level, i.agent_directory, a.label, p.updated_at, i.customer_match,
                   COALESCE(i.sandbox, 0)
              FROM pending_identity p JOIN items i ON i.id = p.item_id JOIN parties pa ON pa.id = i.party_id
              LEFT JOIN carrying_agents a ON a.thumbprint = i.agent_thumbprint
             WHERE p.item_id = ? AND p.network = ?`,
      params: [itemId, network],
      method: "all",
    });
    const r = rows[0];
    if (!r) return { note: "nothing pending for this item and network" };
    const state = String(r[0]);
    if (state !== "asking" && state !== "limited") return { note: `already ${state}` };
    const attempts = Number(r[1] ?? 0);
    if (Number(r[2]) < now - PENDING_TTL_MS) {
      await db.client.query({
        sql: "UPDATE pending_identity SET state = 'gave_up', updated_at = ? WHERE item_id = ? AND network = ?",
        params: [now, itemId, network],
        method: "run",
      });
      return { note: "gave up after seven days" };
    }
    // The network's daily limit: asked again a day after it said so, not before.
    const limitedAt = Number(r[9] ?? 0);
    if (state === "limited" && limitedAt + 24 * 3_600_000 > now) {
      await ensureJob(db, IDENTITY_ISSUE_KIND, issueJobKey(itemId, network, attempts + 1), {
        now,
        runAt: limitedAt + 24 * 3_600_000,
        payload: { itemId, network },
      });
      return { note: `${new URL(network).host} reached its issuance limit for today; asking again tomorrow` };
    }
    const settings = await readSettings(db);
    const entry = settings.networks[network];
    if (!entry?.enabled || !entry.issue) return { note: `${network} no longer issues through this inbox` };
    // Asked again, it is judged again: never for a test item, and the address goes only to a
    // network that has verified this inbox. Either way nothing is asked of it for this item again.
    const test = Number(r[11] ?? 0) === 1;
    // The customer asked the business not to use booking networks since: nothing more is asked.
    if (await itemStopped(db, itemId)) {
      await db.client.query({
        sql: "DELETE FROM pending_identity WHERE item_id = ?",
        params: [itemId],
        method: "run",
      });
      return { note: "the customer asked us not to use booking networks; no network is asked" };
    }
    if (test || !mayReceiveEmails(network, await verifiedNetworks(db))) {
      await db.client.query({
        sql: "UPDATE pending_identity SET state = 'gave_up', updated_at = ? WHERE item_id = ? AND network = ?",
        params: [now, itemId, network],
        method: "run",
      });
      return {
        note: test
          ? "a test item: no network is asked"
          : `${new URL(network).host} has not verified this inbox; no email address goes to it`,
      };
    }
    const email = r[4];
    if (typeof email !== "string" || !email) return { note: "the customer has no email any more" };
    const agent: AgentSeen = {
      level: r[6] === "vouched" || r[6] === "self" ? r[6] : "none",
      ...(r[5] ? { thumbprint: String(r[5]) } : {}),
      ...(r[7] ? { platform: String(r[7]) } : {}),
      ...(r[8] ? { label: String(r[8]) } : {}),
    };
    const [result] = await deps.port.issue({ itemId, email, agent, networks: [network], now });
    if (!result) return { note: "no answer" };
    const box = deps.caps.secrets;
    if (!box) return { note: "this inbox has no INBOX_SECRET_KEY; nothing issued" };
    // A weak match's person is linked by the code that proves it, not here (§8.2).
    const partyId = r[10] === "weak" ? null : String(r[3]);
    await db.batch(await issuanceStatements(box, itemId, partyId, [result], now));
    if (result.outcome === "unreachable" || result.outcome === "rate_limited") {
      const delay =
        result.outcome === "rate_limited"
          ? 24 * 3_600_000
          : Math.min(6 * 3_600_000, 60_000 * 2 ** Math.min(attempts, 10));
      await ensureJob(db, IDENTITY_ISSUE_KIND, issueJobKey(itemId, network, attempts + 1), {
        now,
        runAt: now + delay,
        payload: { itemId, network },
      });
      return {
        note:
          result.outcome === "rate_limited"
            ? `${new URL(network).host} reached its issuance limit for today; asking again tomorrow`
            : `${new URL(network).host} did not answer (${result.error}); asking again later`,
      };
    }
    return { note: `${new URL(network).host}: ${result.outcome}` };
  };
}

/** The hourly housekeeping (§8): expired signatures, cached answers and directories, old codes. */
export async function pruneIdentity(db: Db, now: number): Promise<void> {
  await db.batch([
    { sql: "DELETE FROM sig_nonces WHERE expires_at < ?", params: [now], method: "run" },
    { sql: "DELETE FROM network_cache WHERE expires_at < ?", params: [now], method: "run" },
    { sql: "DELETE FROM key_directories WHERE expires_at < ?", params: [now - 86_400_000], method: "run" },
    { sql: "DELETE FROM customer_codes WHERE created_at < ?", params: [now - 86_400_000], method: "run" },
  ]);
}
