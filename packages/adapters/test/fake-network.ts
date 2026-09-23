import {
  formatKey,
  formatPass,
  formatPassRef,
  normaliseEmail,
  type PublicJwk,
  parseCredential,
  verifyForwardedSignature,
  verifyInstanceRequest,
} from "@surfingdog/core";

/**
 * A network as ADR-017 §7 describes it, in memory, for the inbox's tests: it checks every call's
 * sdi-instance/1 signature against the instance's published keys (so the inbox's signing is tested
 * end to end), issues a person per email (201, replayed per request_id, 409 for a known email),
 * presents passes and keys, and verifies forwarded signatures against the keys delegated to a pass.
 */
export interface FakePerson {
  readonly id: string;
  readonly email: string;
  tier: "new" | "building" | "trusted";
  score: number;
  kept: number;
  emailProven: boolean;
  /** key id → secret */
  keys: Map<string, string>;
  /** pass id → { secret, revoked, delegated x by jkt } */
  passes: Map<string, { secret: string; revoked: boolean; delegated: Map<string, string> }>;
}

export interface FakeCall {
  readonly path: string;
  readonly body: Record<string, unknown> | null;
  readonly verified: boolean;
  readonly error?: string;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rand = (n: number) => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => B32[b % 32]).join("");
};

export function fakeNetwork(opts: {
  host: string;
  /** The instance's published receipt keys (the manifest's `receipt_keys`). */
  keys: () => Promise<readonly PublicJwk[]>;
  /** The instance's domain, which every signed call must name. */
  instanceDomain: string;
  /** Overrides an answer: return a Response to use it instead. */
  intercept?: (path: string, body: Record<string, unknown> | null, n: number) => Response | undefined;
}) {
  const persons: FakePerson[] = [];
  const requests = new Map<string, { status: number; body: unknown; email: string }>();
  const calls: FakeCall[] = [];
  const usedSignatures = new Set<string>();
  let presentations = 0;
  const origin = `https://${opts.host}`;

  const standing = (p: FakePerson) => ({
    tier: p.tier,
    score: p.score,
    kept: p.kept,
    broken: 0,
    businesses: p.kept ? 1 : 0,
    email_proven: p.emailProven,
    since: "2026-09-01T00:00:00Z",
    unusual_use: false,
    rules: 3,
  });
  const ppidOf = (p: FakePerson) => `pp_${p.id}_${opts.instanceDomain.length}`.padEnd(22, "x").slice(0, 22);
  const presentationId = () => `pr${String(++presentations).padStart(20, "0")}`;

  const newPass = (p: FakePerson): string => {
    const id = rand(16);
    const secret = rand(32);
    p.passes.set(id, { secret, revoked: false, delegated: new Map() });
    return formatPass(opts.host, id, secret);
  };

  /** A person the network already knows (as if issued by another business). */
  const addPerson = (
    email: string,
    over: Partial<FakePerson> = {},
  ): { person: FakePerson; key: string; pass: string } => {
    const person: FakePerson = {
      id: rand(8),
      email: normaliseEmail(email) ?? email,
      tier: "new",
      score: 0,
      kept: 0,
      emailProven: false,
      keys: new Map(),
      passes: new Map(),
      ...over,
    };
    persons.push(person);
    const keyId = rand(16);
    const keySecret = rand(32);
    person.keys.set(keyId, keySecret);
    return { person, key: formatKey(opts.host, keyId, keySecret), pass: newPass(person) };
  };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const problem = (status: number, code: string) =>
    json(status, { type: `https://x/${code}`, title: code, status, code });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== origin) return new Response(null, { status: 404 });
    const text = init?.body ? String(init.body) : "";
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    if (url.pathname === "/v1/ranking") return json(200, { version: 3, next: null });
    if (url.pathname.endsWith("/ping")) return new Response(null, { status: 204 });
    if (url.pathname === "/v1/receipts") return json(201, { ok: true, state: "issued", duplicate: false });
    let verified = true;
    let error: string | undefined;
    try {
      const v = await verifyInstanceRequest({
        method: init?.method ?? "GET",
        url: url.href,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: text,
        authorities: [opts.host],
        now: Date.now(),
        keysFor: async (domain) => (domain === opts.instanceDomain ? opts.keys() : null),
      });
      if (v.domain !== opts.instanceDomain) throw new Error("wrong instance");
    } catch (e) {
      verified = false;
      error = e instanceof Error ? e.message : String(e);
    }
    calls.push({ path: url.pathname, body, verified, ...(error ? { error } : {}) });
    const n = calls.filter((c) => c.path === url.pathname).length;
    const custom = opts.intercept?.(url.pathname, body, n);
    if (custom) return custom;
    if (!verified) return problem(401, "bad_signature");

    if (url.pathname === "/v1/persons" && body) {
      const email = normaliseEmail(String(body.email ?? ""));
      if (!email) return problem(400, "bad_payload");
      const requestId = String(body.request_id);
      const replay = requests.get(requestId);
      if (replay) return replay.status === 201 ? json(201, replay.body) : problem(409, "person_exists");
      if (persons.some((p) => p.email === email)) {
        requests.set(requestId, { status: 409, body: null, email });
        return problem(409, "person_exists");
      }
      const made = addPerson(email);
      const answer = {
        key: made.key,
        pass: made.pass,
        presentation: presentationId(),
        ppid: ppidOf(made.person),
        person: standing(made.person),
      };
      requests.set(requestId, { status: 201, body: answer, email });
      return json(201, answer);
    }

    if (url.pathname === "/v1/presentations" && body) {
      let person: FakePerson | undefined;
      let minted: string | undefined;
      if (typeof body.pass === "string") {
        const c = parseCredential(body.pass);
        if (c?.kind !== "pass" || c.host !== opts.host) return problem(404, "unknown_pass");
        person = persons.find((p) => p.passes.get(c.id)?.secret === c.secret);
        const pass = person?.passes.get(c.id);
        if (!person || !pass) return problem(404, "unknown_pass");
        if (pass.revoked) return problem(410, "revoked");
        if (pass.delegated.size) return problem(403, "pass_requires_signature");
      } else if (typeof body.key === "string") {
        const c = parseCredential(body.key);
        if (c?.kind !== "key") return problem(404, "unknown_pass");
        person = persons.find((p) => p.keys.get(c.id) === c.secret);
        if (!person) return problem(404, "unknown_pass");
        minted = newPass(person);
      } else if (body.agent_key && typeof body.agent_key === "object") {
        const ak = body.agent_key as {
          jkt: string;
          pass_ref: string;
          label: string;
          signature_input: string;
          signature: string;
          signature_base: string;
        };
        const c = parseCredential(ak.pass_ref);
        if (c?.kind !== "pass_ref") return problem(400, "bad_payload");
        person = persons.find((p) => p.passes.has(c.id));
        const x = person?.passes.get(c.id)?.delegated.get(ak.jkt);
        if (!person || !x) return problem(403, "pass_requires_signature");
        try {
          await verifyForwardedSignature(ak, x, opts.instanceDomain, Date.now());
        } catch {
          return problem(403, "pass_requires_signature");
        }
        // Each forwarded signature is used once, as the real network keeps it.
        if (usedSignatures.has(ak.signature)) return problem(403, "pass_requires_signature");
        usedSignatures.add(ak.signature);
      } else {
        return problem(400, "bad_payload");
      }
      const email = typeof body.email === "string" ? normaliseEmail(body.email) : null;
      return json(200, {
        presentation: presentationId(),
        ppid: ppidOf(person),
        person: standing(person),
        ...(minted ? { pass: minted } : {}),
        ...(typeof body.email === "string"
          ? { email_match: email === person.email ? (person.emailProven ? "proven" : "unproven") : "no" }
          : {}),
      });
    }
    return problem(404, "not_found");
  }) as typeof fetch;

  /** Delegates an agent's key to a pass (as `POST /v1/delegations` would, with a session). */
  const delegate = (pass: string, jkt: string, x: string): string => {
    const c = parseCredential(pass);
    if (!c) throw new Error("not a pass");
    const p = persons.find((q) => q.passes.has(c.id));
    p?.passes.get(c.id)?.delegated.set(jkt, x);
    return formatPassRef(opts.host, c.id);
  };

  const revoke = (pass: string) => {
    const c = parseCredential(pass);
    if (!c) return;
    for (const p of persons) {
      const found = p.passes.get(c.id);
      if (found) found.revoked = true;
    }
  };

  return { origin, fetchImpl, calls, persons, addPerson, delegate, revoke, ppidOf };
}
