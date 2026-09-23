/**
 * Builds the network protocol's test vectors (ADR-017 §7.4) from fixed keys, times and nonces:
 *
 *   packages/spec/vectors/signatures.json   sdi-instance/1 and sdi-agent/1 requests (both tags), forwarded agent_key
 *   packages/spec/vectors/passes.json       key, pass and pass-reference strings, ppid, email_mac, email normalisation
 *   packages/spec/vectors/receipts-v2.json  v2 claims: every promise kind and every inbox outcome, an ack with pas
 *
 * Ed25519 is deterministic and every input here is fixed, so the files are reproducible byte for
 * byte: `gen-network-vectors.ts` writes them and `test/network-vectors.test.ts` rebuilds them on
 * both runtimes and compares. The expectations (`expect`, `normalised`, `code`) are written here by
 * hand from the ADR and the network's decisions, never computed by the code under test; the tests
 * then check that code against them, and the network's own tests check its code.
 *
 * Pure WebCrypto: no Node APIs, so the tests run it inside workerd too. Nothing here is a secret:
 * the instance key is RFC 8037's published test key and the others come from ASCII seeds.
 */
import { OUTCOMES } from "@surfingdog/spec";
import { CUSTOMER_ACTORS } from "../src/domain/types";
import { bookingMachine, orderMachine } from "../src/machine/tables";
import {
  agentKeyOf,
  formatKey,
  formatPass,
  formatPassHeader,
  formatPassRef,
  signInstanceRequest,
  signRequest,
  TAG_AGENT,
  TAG_WEB_BOT_AUTH,
  verifyAgentRequest,
} from "../src/protocol/index";
import { ACK_TYP, ALG, b64u, RECEIPT_TYP, receiptSha, signReceipt, thumbprint } from "../src/receipts/sign";

const enc = new TextEncoder();

export const NETWORK = "network.example.com";
export const INBOX = "inbox.example.com";
export const PLATFORM = "https://platform.example";
/** Every signature below is created at T and checked at NOW, unless a case says otherwise. */
export const T = 1790001000;
export const NOW = T + 30;

type Jwk = { kty: "OKP"; crv: "Ed25519"; x: string; d?: string; kid?: string };
interface VectorKey {
  kid: string;
  public_jwk: Jwk;
  private_jwk: Jwk & { d: string };
}

/** RFC 8037 appendix A.1, the published Ed25519 test key: the instance's receipt key, as in receipts.json. */
const RFC8037 = {
  kty: "OKP",
  crv: "Ed25519",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
} as const;

async function keyFromSeed(seed: string): Promise<VectorKey> {
  const bytes = enc.encode(seed);
  if (bytes.length !== 32) throw new Error(`a seed is 32 bytes: ${seed}`);
  const prefix = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  const priv = await crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array([...prefix, ...bytes]),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", priv)) as { x: string; d: string };
  return fixedKey(jwk.x, jwk.d);
}

async function fixedKey(x: string, d: string): Promise<VectorKey> {
  const kid = await thumbprint({ kty: "OKP", crv: "Ed25519", x });
  return {
    kid,
    public_jwk: { kty: "OKP", crv: "Ed25519", x, kid },
    private_jwk: { kty: "OKP", crv: "Ed25519", x, d },
  };
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text) as BufferSource));
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const std64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** RFC 4648 base32, lowercase, unpadded. */
function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** A fixed base32 string of `n` bytes, from a label. */
async function b32Of(label: string, n: number): Promise<string> {
  return base32((await sha256(label)).slice(0, n));
}

/** A fixed nonce of 32 hex characters, from a label. */
async function nonceOf(label: string): Promise<string> {
  return hex((await sha256(`nonce:${label}`)).slice(0, 16));
}

async function sign(privateJwk: Jwk & { d: string }, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: privateJwk.x, d: privateJwk.d, key_ops: ["sign"], ext: true },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(message) as BufferSource));
}

async function signJws(header: object, payload: object, privateJwk: Jwk & { d: string }): Promise<string> {
  const input = `${b64u(enc.encode(JSON.stringify(header)))}.${b64u(enc.encode(JSON.stringify(payload)))}`;
  return `${input}.${b64u(await sign(privateJwk, input))}`;
}

async function digestOf(body: string): Promise<string> {
  return `sha-256=:${std64(await sha256(body))}:`;
}

/**
 * A signature laid out by hand, line by line, for the refusals: the code under test would never
 * make these, which is the point. `lines` are the covered components' identifiers and values.
 */
async function handSigned(opts: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  lines: [string, string][];
  params: string;
  key: Jwk & { d: string };
  label?: string;
}) {
  const label = opts.label ?? "sig1";
  const signatureInput = `(${opts.lines.map(([id]) => id).join(" ")})${opts.params}`;
  const base = `${opts.lines.map(([id, v]) => `${id}: ${v}`).join("\n")}\n"@signature-params": ${signatureInput}`;
  const sig = std64(await sign(opts.key, base));
  return {
    method: opts.method,
    url: opts.url,
    headers: { ...opts.headers, "Signature-Input": `${label}=${signatureInput}`, Signature: `${label}=:${sig}:` },
    body: opts.body,
  };
}

const params = (keyid: string, tag: string, nonce: string, created = T, expires = T + 300, alg = "ed25519") =>
  `;created=${created};expires=${expires};keyid="${keyid}";alg="${alg}";tag="${tag}";nonce="${nonce}"`;

export async function buildNetworkVectors() {
  const instance = await fixedKey(RFC8037.x, RFC8037.d);
  const agent = await keyFromSeed("surfingdog-inbox-agent-vector-01");
  const platform = await keyFromSeed("surfingdog-inbox-platform-key-01");
  const instanceOrigin = `https://${INBOX}`;

  const passId = await b32Of("vector:pass:id", 10);
  const passSecret = await b32Of("vector:pass:secret", 20);
  const keyId = await b32Of("vector:key:id", 10);
  const keySecret = await b32Of("vector:key:secret", 20);
  const pass = formatPass(NETWORK, passId, passSecret);
  const passRef = formatPassRef(NETWORK, passId);
  const key = formatKey(NETWORK, keyId, keySecret);

  const agentKeyHeader = `sig1=:${std64(enc.encode(JSON.stringify({ kty: "OKP", crv: "Ed25519", x: agent.public_jwk.x })))}:`;
  const directory = { origin: PLATFORM, keys: [platform.public_jwk] };
  const platformKey = async (origin: string, keyid: string) =>
    origin === PLATFORM && keyid === platform.kid ? platform.public_jwk : null;

  // --- valid requests, signed by the code under test ---------------------------------------

  const personsBody = JSON.stringify({
    request_id: "01M34AVYNXTNSE2RC495H3W8QS",
    email: "rita@example.com",
    agent: { label: "Example Assistant" },
  });
  const pingBody = JSON.stringify({
    version: "0.2.0",
    runtime: "workers",
    counts: { bookings: 3, orders: 1, quotes: 0, messages: 2 },
  });
  const bookingBody = JSON.stringify({
    service_id: "haircut",
    start: "2026-10-01T10:00:00Z",
    contact: { name: "Rita Silva", email: "rita@example.com" },
  });

  const signedInstance = async (name: string, method: string, url: string, body: string | null, nonce: string) => {
    const s = await signInstanceRequest({
      method,
      url,
      body,
      instance: instanceOrigin,
      key: { kid: instance.kid, privateJwk: instance.private_jwk },
      now: T * 1000,
      nonce,
    });
    const headers: Record<string, string> = body ? { "Content-Type": "application/json", ...s.headers } : s.headers;
    return {
      name,
      profile: "sdi-instance/1",
      receiver: "network",
      authority: NETWORK,
      now: NOW,
      request: { method, url, headers, body: body ?? "" },
      signature_input: s.signatureInput,
      signature: s.signature,
      signature_base: s.signatureBase,
    };
  };

  const signedAgent = async (
    name: string,
    opts: {
      method: string;
      url: string;
      body: string | null;
      nonce: string;
      authority: string;
      receiver: "inbox" | "network";
      tag: string;
      headers?: Record<string, string>;
      legacy?: boolean;
    },
  ) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const covered: { name: string; key?: string }[] = [];
    let signer = agent;
    if (opts.tag === TAG_AGENT) {
      headers["Sdi-Agent-Key"] = agentKeyHeader;
      covered.push({ name: "sdi-agent-key", key: "sig1" });
    } else {
      signer = platform;
      headers["Signature-Agent"] = opts.legacy ? `"${PLATFORM}"` : `sig1="${PLATFORM}"`;
      covered.push(opts.legacy ? { name: "signature-agent" } : { name: "signature-agent", key: "sig1" });
    }
    if (headers["Sdi-Pass"] !== undefined) covered.push({ name: "sdi-pass" });
    const s = await signRequest({
      method: opts.method,
      url: opts.url,
      body: opts.body,
      headers,
      covered,
      keyid: signer.kid,
      privateJwk: signer.private_jwk,
      tag: opts.tag,
      created: T,
      expires: T + 300,
      nonce: opts.nonce,
    });
    const all: Record<string, string> = opts.body ? { "Content-Type": "application/json", ...s.headers } : s.headers;
    return {
      name,
      profile: "sdi-agent/1",
      receiver: opts.receiver,
      authority: opts.authority,
      now: NOW,
      request: { method: opts.method, url: opts.url, headers: all, body: opts.body ?? "" },
      signature_input: s.signatureInput,
      signature: s.signature,
      signature_base: s.signatureBase,
    };
  };

  const agentPost = await signedAgent("sdi-agent/1, self-held key: POST a booking to an inbox with a pass reference", {
    method: "POST",
    url: `https://${INBOX}/v1/bookings`,
    body: bookingBody,
    nonce: "vector-agent-0001",
    authority: INBOX,
    receiver: "inbox",
    tag: TAG_AGENT,
    headers: { "Sdi-Pass": formatPassHeader([passRef]) },
  });
  const agentGet = await signedAgent("sdi-agent/1, self-held key: GET with a query and Sdi-Pass, no body", {
    method: "GET",
    url: `https://${INBOX}/v1/items/01M34AVYNXTNSE2RC495H3W8QS?access_token=at_example`,
    body: null,
    nonce: "vector-agent-0002",
    authority: INBOX,
    receiver: "inbox",
    tag: TAG_AGENT,
    headers: { "Sdi-Pass": formatPassHeader([passRef]) },
  });
  const agentDelegation = await signedAgent(
    "sdi-agent/1, self-held key: POST /v1/delegations to the network (with the person's session)",
    {
      method: "POST",
      url: `https://${NETWORK}/v1/delegations`,
      body: JSON.stringify({ pass }),
      nonce: "vector-agent-0003",
      authority: NETWORK,
      receiver: "network",
      tag: TAG_AGENT,
      headers: { Authorization: `Bearer sdps_${await b32Of("vector:session", 20)}` },
    },
  );
  const platformPost = await signedAgent("sdi-agent/1, web-bot-auth: Signature-Agent as a dictionary member", {
    method: "POST",
    url: `https://${INBOX}/v1/bookings`,
    body: bookingBody,
    nonce: "vector-platform-0001",
    authority: INBOX,
    receiver: "inbox",
    tag: TAG_WEB_BOT_AUTH,
  });
  const platformLegacy = await signedAgent("sdi-agent/1, web-bot-auth: Signature-Agent in the legacy string form", {
    method: "POST",
    url: `https://${INBOX}/v1/bookings`,
    body: bookingBody,
    nonce: "vector-platform-0002",
    authority: INBOX,
    receiver: "inbox",
    tag: TAG_WEB_BOT_AUTH,
    legacy: true,
  });

  // What an inbox forwards after verifying the agent's signatures (§7.2).
  const forwardOf = async (c: typeof agentPost, ref: string) => {
    const v = await verifyAgentRequest({
      method: c.request.method,
      url: c.request.url,
      headers: c.request.headers,
      body: c.request.body,
      authorities: [INBOX],
      now: NOW * 1000,
      platformKey,
    });
    if (v.status !== "verified") throw new Error(`${c.name} did not verify: ${JSON.stringify(v)}`);
    return agentKeyOf(v, ref);
  };
  const forwardedSelf = await forwardOf(agentPost, passRef);
  const forwardedPlatform = await forwardOf(platformPost, passRef);

  const presentationBody = JSON.stringify({
    agent_key: forwardedSelf,
    purpose: "request",
    email: "rita@example.com",
    agent: { label: "Example Assistant", jkt: agent.kid },
  });

  const valid = [
    {
      ...(await signedInstance(
        "sdi-instance/1: POST /v1/persons (first contact)",
        "POST",
        `https://${NETWORK}/v1/persons`,
        personsBody,
        "vector-instance-0001",
      )),
      expect: { ok: true, domain: INBOX, keyid: instance.kid },
    },
    {
      ...(await signedInstance(
        "sdi-instance/1: POST /v1/presentations forwarding an agent's signature (agent_key)",
        "POST",
        `https://${NETWORK}/v1/presentations`,
        presentationBody,
        "vector-instance-0002",
      )),
      expect: { ok: true, domain: INBOX, keyid: instance.kid },
    },
    {
      ...(await signedInstance(
        "sdi-instance/1: the hourly ping, signed",
        "POST",
        `https://${NETWORK}/v1/instances/${INBOX}/ping`,
        pingBody,
        "vector-instance-0003",
      )),
      expect: { ok: true, domain: INBOX, keyid: instance.kid },
    },
    {
      ...(await signedInstance(
        "sdi-instance/1: a POST with no body covers no content-digest",
        "POST",
        `https://${NETWORK}/v1/instances/${INBOX}/ping`,
        null,
        "vector-instance-0004",
      )),
      expect: { ok: true, domain: INBOX, keyid: instance.kid },
    },
    { ...agentPost, expect: { ok: true, level: "self", keyid: agent.kid } },
    { ...agentGet, expect: { ok: true, level: "self", keyid: agent.kid } },
    { ...agentDelegation, expect: { ok: true, level: "self", keyid: agent.kid } },
    { ...platformPost, expect: { ok: true, level: "vouched", keyid: platform.kid, platform: PLATFORM } },
    { ...platformLegacy, expect: { ok: true, level: "vouched", keyid: platform.kid, platform: PLATFORM } },
  ];

  // --- refusals, laid out by hand -------------------------------------------------------------

  const personsUrl = `https://${NETWORK}/v1/persons`;
  const instLines = async (body: string, authority = NETWORK): Promise<[string, string][]> => [
    ['"@method"', "POST"],
    ['"@authority"', authority],
    ['"@path"', "/v1/persons"],
    ['"content-digest"', await digestOf(body)],
    ['"sdi-instance"', instanceOrigin],
  ];
  const instHeaders = async (body: string, origin = instanceOrigin) => ({
    "Content-Type": "application/json",
    "Sdi-Instance": origin,
    "Content-Digest": await digestOf(body),
  });
  const instanceRefusal = async (
    name: string,
    code: string,
    make: () => Promise<{ method: string; url: string; headers: Record<string, string>; body: string }>,
    now = NOW,
  ) => ({
    name,
    profile: "sdi-instance/1",
    receiver: "network",
    authority: NETWORK,
    now,
    request: await make(),
    expect: { ok: false, code },
  });

  const firstInstance = valid[0] as (typeof valid)[number];
  const refusedInstance = [
    await instanceRefusal("the body changed after signing", "bad_signature", async () => ({
      ...firstInstance.request,
      body: personsBody.replace("rita@example.com", "ana@example.com"),
    })),
    await instanceRefusal(
      "expired: checked 400 s after created (expires + 100)",
      "expired",
      async () => firstInstance.request,
      T + 400,
    ),
    await instanceRefusal(
      "dated in the future: checked 120 s before created",
      "expired",
      async () => firstInstance.request,
      T - 120,
    ),
    await instanceRefusal("expires − created is 301 s", "bad_signature", async () =>
      handSigned({
        method: "POST",
        url: personsUrl,
        headers: await instHeaders(personsBody),
        body: personsBody,
        lines: await instLines(personsBody),
        params: params(instance.kid, "sdi-instance", "vector-refused-0001", T, T + 301),
        key: instance.private_jwk,
      }),
    ),
    await instanceRefusal("content-digest not covered", "bad_signature", async () =>
      handSigned({
        method: "POST",
        url: personsUrl,
        headers: await instHeaders(personsBody),
        body: personsBody,
        lines: (await instLines(personsBody)).filter(([id]) => id !== '"content-digest"'),
        params: params(instance.kid, "sdi-instance", "vector-refused-0002"),
        key: instance.private_jwk,
      }),
    ),
    await instanceRefusal("sdi-instance not covered", "bad_signature", async () =>
      handSigned({
        method: "POST",
        url: personsUrl,
        headers: await instHeaders(personsBody),
        body: personsBody,
        lines: (await instLines(personsBody)).filter(([id]) => id !== '"sdi-instance"'),
        params: params(instance.kid, "sdi-instance", "vector-refused-0003"),
        key: instance.private_jwk,
      }),
    ),
    await instanceRefusal("signed for another network's authority", "bad_signature", async () =>
      handSigned({
        method: "POST",
        url: personsUrl,
        headers: await instHeaders(personsBody),
        body: personsBody,
        lines: await instLines(personsBody, "network.other.example"),
        params: params(instance.kid, "sdi-instance", "vector-refused-0004"),
        key: instance.private_jwk,
      }),
    ),
    await instanceRefusal('alg is not "ed25519"', "bad_signature", async () =>
      handSigned({
        method: "POST",
        url: personsUrl,
        headers: await instHeaders(personsBody),
        body: personsBody,
        lines: await instLines(personsBody),
        params: params(instance.kid, "sdi-instance", "vector-refused-0005", T, T + 300, "rsa-pss-sha512"),
        key: instance.private_jwk,
      }),
    ),
    await instanceRefusal("keyid is no receipt key of the instance's manifest", "bad_signature", async () =>
      handSigned({
        method: "POST",
        url: personsUrl,
        headers: await instHeaders(personsBody),
        body: personsBody,
        lines: await instLines(personsBody),
        params: params(agent.kid, "sdi-instance", "vector-refused-0006"),
        key: agent.private_jwk,
      }),
    ),
    await instanceRefusal("Sdi-Instance names an instance the network does not list", "unknown_instance", async () =>
      handSigned({
        method: "POST",
        url: personsUrl,
        headers: await instHeaders(personsBody, "https://unlisted.example.com"),
        body: personsBody,
        lines: (await instLines(personsBody)).map(([id, v]) =>
          id === '"sdi-instance"' ? [id, "https://unlisted.example.com"] : [id, v],
        ),
        params: params(instance.kid, "sdi-instance", "vector-refused-0007"),
        key: instance.private_jwk,
      }),
    ),
    await instanceRefusal("tagged sdi-agent, not sdi-instance", "bad_signature", async () =>
      handSigned({
        method: "POST",
        url: personsUrl,
        headers: await instHeaders(personsBody),
        body: personsBody,
        lines: await instLines(personsBody),
        params: params(instance.kid, "sdi-agent", "vector-refused-0008"),
        key: instance.private_jwk,
      }),
    ),
  ];

  const bookingsUrl = `https://${INBOX}/v1/bookings`;
  const agentLines = async (extra: [string, string][]): Promise<[string, string][]> => [
    ['"@method"', "POST"],
    ['"@authority"', INBOX],
    ['"@path"', "/v1/bookings"],
    ['"content-digest"', await digestOf(bookingBody)],
    ...extra,
  ];
  const agentRefusal = async (
    name: string,
    code: string,
    request: { method: string; url: string; headers: Record<string, string>; body: string },
  ) => ({
    name,
    profile: "sdi-agent/1",
    receiver: "inbox",
    authority: INBOX,
    now: NOW,
    request,
    expect: { ok: false, code },
  });
  const withD = `sig1=:${std64(enc.encode(JSON.stringify(agent.private_jwk)))}:`;
  const refusedAgent = [
    await agentRefusal(
      "Sdi-Agent-Key carries a private key (d)",
      "bad_signature",
      await handSigned({
        method: "POST",
        url: bookingsUrl,
        headers: {
          "Content-Type": "application/json",
          "Content-Digest": await digestOf(bookingBody),
          "Sdi-Agent-Key": withD,
        },
        body: bookingBody,
        lines: await agentLines([['"sdi-agent-key";key="sig1"', withD.slice(5)]]),
        params: params(agent.kid, "sdi-agent", "vector-refused-0101"),
        key: agent.private_jwk,
      }),
    ),
    await agentRefusal(
      "keyid is not the thumbprint of the key in Sdi-Agent-Key",
      "bad_signature",
      await handSigned({
        method: "POST",
        url: bookingsUrl,
        headers: {
          "Content-Type": "application/json",
          "Content-Digest": await digestOf(bookingBody),
          "Sdi-Agent-Key": agentKeyHeader,
        },
        body: bookingBody,
        lines: await agentLines([['"sdi-agent-key";key="sig1"', agentKeyHeader.slice(5)]]),
        params: params(instance.kid, "sdi-agent", "vector-refused-0102"),
        key: agent.private_jwk,
      }),
    ),
    await agentRefusal(
      "Sdi-Pass is sent but not covered",
      "bad_signature",
      await handSigned({
        method: "POST",
        url: bookingsUrl,
        headers: {
          "Content-Type": "application/json",
          "Content-Digest": await digestOf(bookingBody),
          "Sdi-Agent-Key": agentKeyHeader,
          "Sdi-Pass": formatPassHeader([passRef]),
        },
        body: bookingBody,
        lines: await agentLines([['"sdi-agent-key";key="sig1"', agentKeyHeader.slice(5)]]),
        params: params(agent.kid, "sdi-agent", "vector-refused-0103"),
        key: agent.private_jwk,
      }),
    ),
    await agentRefusal(
      "sdi-agent-key is not covered",
      "bad_signature",
      await handSigned({
        method: "POST",
        url: bookingsUrl,
        headers: {
          "Content-Type": "application/json",
          "Content-Digest": await digestOf(bookingBody),
          "Sdi-Agent-Key": agentKeyHeader,
        },
        body: bookingBody,
        lines: await agentLines([]),
        params: params(agent.kid, "sdi-agent", "vector-refused-0104"),
        key: agent.private_jwk,
      }),
    ),
    await agentRefusal(
      "web-bot-auth: Signature-Agent is not covered",
      "bad_signature",
      await handSigned({
        method: "POST",
        url: bookingsUrl,
        headers: {
          "Content-Type": "application/json",
          "Content-Digest": await digestOf(bookingBody),
          "Signature-Agent": `sig1="${PLATFORM}"`,
        },
        body: bookingBody,
        lines: await agentLines([]),
        params: params(platform.kid, "web-bot-auth", "vector-refused-0105"),
        key: platform.private_jwk,
      }),
    ),
    await agentRefusal(
      "web-bot-auth: the platform's directory does not list the key (inbox only)",
      "unknown_key",
      await handSigned({
        method: "POST",
        url: bookingsUrl,
        headers: {
          "Content-Type": "application/json",
          "Content-Digest": await digestOf(bookingBody),
          "Signature-Agent": `sig1="${PLATFORM}"`,
        },
        body: bookingBody,
        lines: await agentLines([['"signature-agent";key="sig1"', `"${PLATFORM}"`]]),
        params: params(agent.kid, "web-bot-auth", "vector-refused-0106"),
        key: agent.private_jwk,
      }),
    ),
  ];

  // --- forwarded signatures -------------------------------------------------------------------

  const forwarded = [
    {
      name: "a self-held key's signature, forwarded by the instance it was made for",
      agent_key: forwardedSelf,
      x: agent.public_jwk.x,
      instance: INBOX,
      now: NOW,
      expect: { ok: true },
    },
    {
      name: "a platform key's signature (web-bot-auth), forwarded: the form checks (a network also needs the key in a recognised platform's directory)",
      agent_key: forwardedPlatform,
      x: platform.public_jwk.x,
      instance: INBOX,
      now: NOW,
      expect: { ok: true },
    },
    {
      name: "signature_input differs from the base's last line",
      agent_key: { ...forwardedSelf, signature_input: forwardedSelf.signature_input.replace("vector-agent-0001", "x") },
      x: agent.public_jwk.x,
      instance: INBOX,
      now: NOW,
      expect: { ok: false },
    },
    {
      name: "presented by an instance the signature was not made for",
      agent_key: forwardedSelf,
      x: agent.public_jwk.x,
      instance: "other.example.com",
      now: NOW,
      expect: { ok: false },
    },
    {
      name: "created over 300 s before it is presented",
      agent_key: forwardedSelf,
      x: agent.public_jwk.x,
      instance: INBOX,
      now: T + 301,
      expect: { ok: false },
    },
    {
      name: "the signed Sdi-Pass does not carry pass_ref",
      agent_key: { ...forwardedSelf, pass_ref: formatPassRef(NETWORK, await b32Of("vector:other-pass", 10)) },
      x: agent.public_jwk.x,
      instance: INBOX,
      now: NOW,
      expect: { ok: false },
    },
    {
      name: "verified under a key that is not the signer's",
      agent_key: forwardedSelf,
      x: instance.public_jwk.x,
      instance: INBOX,
      now: NOW,
      expect: { ok: false },
    },
  ];

  const signatures = {
    $comment:
      "Test vectors for signed requests (ADR-017 §2.4, §7.2), MIT. Every signature is Ed25519 over the RFC 9421 signature base, so re-signing `signature_base` with the named key reproduces `signature` byte for byte. Keys: `instance` is RFC 8037 A.1 (the receipt key of https://inbox.example.com, as in receipts.json); `agent` has the ASCII seed 'surfingdog-inbox-agent-vector-01'; `platform` has the seed 'surfingdog-inbox-platform-key-01' and is listed in `directory`. `authority` is the receiver's own @authority; check each request at `now` (unix seconds). A replay (the same signature twice) is refused 401 replayed_signature; that needs state, so no vector shows it. Generated by packages/core/scripts/gen-network-vectors.ts.",
    network: NETWORK,
    instance: {
      origin: instanceOrigin,
      kid: instance.kid,
      public_jwk: instance.public_jwk,
      private_jwk: instance.private_jwk,
      manifest_receipt_keys: { keys: [instance.public_jwk] },
    },
    agent: { kid: agent.kid, public_jwk: agent.public_jwk, private_jwk: agent.private_jwk },
    platform: { kid: platform.kid, public_jwk: platform.public_jwk, private_jwk: platform.private_jwk },
    directory,
    pass,
    pass_ref: passRef,
    requests: [...valid, ...refusedInstance, ...refusedAgent],
    forwarded,
  };

  // --- passes.json ----------------------------------------------------------------------------

  const sessionSecret = await b32Of("vector:session", 20);
  const pairwise = hex(await sha256("vector:pairwise-secret"));
  const emailSecret = hex(await sha256("vector:email-secret"));
  const pid = "0b9c4c2e-5d1a-4e3f-9a7b-2c8d6e4f1a3b";
  const hmacHex = async (keyHex: string, message: string) => {
    const k = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(keyHex.match(/../g) ?? [], (h) => Number.parseInt(h, 16)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message) as BufferSource));
  };
  const secretHashOf = async (s: string) => hex(await sha256(s));

  const passes = {
    $comment:
      "Test vectors for the strings a person holds and the values a network derives (ADR-017 §2), MIT. `parse` gives each input's kind, host, id and secret, or null when it is not a key, pass or pass reference. `emails` gives each input's normalised address, or null when the address is refused (no email, no issuance): only ASCII A–Z is lowercased, non-ASCII labels are RFC 3492 punycode with no UTS 46 mapping, and a local part holding any of \" ( ) < > [ ] \\ , ; : @ is refused. A lone UTF-16 surrogate (not valid in these files) reaches a network as U+FFFD, and is normalised as one. Generated by packages/core/scripts/gen-network-vectors.ts.",
    network: NETWORK,
    formats: {
      key: { string: key, host: NETWORK, id: keyId, secret: keySecret },
      pass: { string: pass, host: NETWORK, id: passId, secret: passSecret },
      pass_ref: { string: passRef, host: NETWORK, id: passId },
      session: `sdps_${sessionSecret}`,
      presentation_id: b64u((await sha256("vector:presentation")).slice(0, 16)),
    },
    parse: [
      { input: key, kind: "key", host: NETWORK, id: keyId, secret: keySecret },
      { input: pass, kind: "pass", host: NETWORK, id: passId, secret: passSecret },
      { input: passRef, kind: "pass_ref", host: NETWORK, id: passId },
      {
        input: formatPass("xn--rseau-bsa.example", passId, passSecret),
        kind: "pass",
        host: "xn--rseau-bsa.example",
        id: passId,
        secret: passSecret,
      },
      { input: formatPassRef("localhost", passId), kind: "pass_ref", host: "localhost", id: passId },
      { input: `sdkey1_${NETWORK}_${keyId}`, kind: null },
      { input: `sdpass1_${NETWORK.toUpperCase()}_${passId}_${passSecret}`, kind: null },
      { input: `sdpass1_${NETWORK}_${passId.toUpperCase()}_${passSecret}`, kind: null },
      { input: `sdpass1_${NETWORK}_${passId.slice(1)}_${passSecret}`, kind: null },
      { input: `sdpass1_${NETWORK}_${passId}_${passSecret}a`, kind: null },
      { input: `sdpass1_${NETWORK}_${passId}_${passSecret.slice(0, 31)}1`, kind: null },
      { input: `sdpass1_.${NETWORK}_${passId}_${passSecret}`, kind: null },
      { input: `sdpass1_${NETWORK}._${passId}_${passSecret}`, kind: null },
      { input: `sdpass1__${passId}_${passSecret}`, kind: null },
      { input: `sdpass1_${NETWORK}_${passId}_${passSecret}_extra`, kind: null },
      { input: `sdpass2_${NETWORK}_${passId}_${passSecret}`, kind: null },
      { input: `sdpass1_${"a".repeat(170)}.example_${passId}_${passSecret}`, kind: null },
      { input: `sdps_${sessionSecret}`, kind: null },
      { input: "", kind: null },
    ],
    secret_hash: [
      { secret: passSecret, sha256: await secretHashOf(passSecret) },
      { secret: keySecret, sha256: await secretHashOf(keySecret) },
    ],
    ppid: [
      {
        $comment: "ppid = base64url(HMAC-SHA-256(pairwise secret, '<pid>|https://<business domain>'))[:22]",
        pairwise_secret_hex: pairwise,
        pid,
        business_domain: INBOX,
        ppid: b64u(await hmacHex(pairwise, `${pid}|https://${INBOX}`)).slice(0, 22),
      },
      {
        pairwise_secret_hex: pairwise,
        pid,
        business_domain: "shop.example.org",
        ppid: b64u(await hmacHex(pairwise, `${pid}|https://shop.example.org`)).slice(0, 22),
      },
    ],
    email_mac: [
      {
        $comment: "email_mac = hex(HMAC-SHA-256(email secret, normalised email))",
        email_secret_hex: emailSecret,
        email: "rita@example.com",
        email_mac: hex(await hmacHex(emailSecret, "rita@example.com")),
      },
      {
        email_secret_hex: emailSecret,
        email: "ana@xn--bcher-kva.de",
        email_mac: hex(await hmacHex(emailSecret, "ana@xn--bcher-kva.de")),
      },
    ],
    emails: EMAIL_CASES,
  };

  // --- receipts-v2.json -----------------------------------------------------------------------

  const receiptsV2 = await buildReceiptsV2(instance, agent, passRef);

  return { signatures, passes, receiptsV2 };
}

/** Email normalisation: input → normalised, or null when refused. Written by hand from ADR-017 §2. */
export const EMAIL_CASES: { name: string; input: string; normalised: string | null }[] = [
  { name: "already normal", input: "rita@example.com", normalised: "rita@example.com" },
  {
    name: "ASCII whitespace trimmed, ASCII lowercased; dots and plus kept",
    input: "  Rita.Silva+Tag@Example.COM \t\n",
    normalised: "rita.silva+tag@example.com",
  },
  { name: "one trailing dot dropped", input: "rita@example.com.", normalised: "rita@example.com" },
  { name: "two trailing dots: an empty label", input: "rita@example.com..", normalised: null },
  { name: "IDN domain, RFC 3492", input: "ana@Bücher.DE", normalised: "ana@xn--bcher-kva.de" },
  { name: "ß stays ß (no UTS 46 mapping to ss)", input: "user@straße.de", normalised: "user@xn--strae-oqa.de" },
  {
    name: "uppercase non-ASCII is not lowercased: MÜNCHEN is not münchen",
    input: "Info@MÜNCHEN.de",
    normalised: "info@xn--mnchen-psa.de",
  },
  { name: "lowercase ü for comparison", input: "info@münchen.de", normalised: "info@xn--mnchen-3ya.de" },
  { name: "É is not lowercased before punycode", input: "USER@ÉXAMPLE.pt", normalised: "user@xn--xample-voa.pt" },
  {
    name: "only ASCII A–Z lowercased in the local part",
    input: "ÁLVARO@example.com",
    normalised: "Álvaro@example.com",
  },
  {
    name: "full-width letters are not mapped to ASCII",
    input: "rita@ｅｘａｍｐｌｅ.com",
    normalised: "rita@xn--mi7chab1aes7c.com",
  },
  { name: "a symbol label", input: "a@☕.example", normalised: "a@xn--53h.example" },
  { name: "a single-label domain", input: "rita@localhost", normalised: "rita@localhost" },
  { name: "plus-address kept whole", input: "rita+booking@example.com", normalised: "rita+booking@example.com" },
  { name: "quoted local part", input: '"rita"@example.com', normalised: null },
  { name: "quoted local part with a space", input: '"rita silva"@example.com', normalised: null },
  { name: "a quote inside the local part", input: 'ri"ta@example.com', normalised: null },
  { name: "split at the last @: the local part holds @", input: "a@b@example.com", normalised: null },
  { name: "a second mailbox after a comma", input: "me@evil.example,x@gmail.com", normalised: null },
  { name: "a second mailbox after a semicolon", input: "me@evil.example;x@gmail.com", normalised: null },
  { name: "angle brackets", input: "Me <me@evil.example>@gmail.com", normalised: null },
  { name: "a comment", input: "x(comment)@gmail.com", normalised: null },
  { name: "square brackets", input: "x[1]@gmail.com", normalised: null },
  { name: "a backslash", input: "x\\y@gmail.com", normalised: null },
  { name: "a colon", input: "x:y@gmail.com", normalised: null },
  { name: "a comma in the domain", input: "x@evil.example,gmail.com", normalised: null },
  { name: "an underscore in the domain", input: "x@evil_host.com", normalised: null },
  { name: "an address literal", input: "rita@[192.0.2.1]", normalised: null },
  { name: "a label of 64 characters", input: `x@${"a".repeat(64)}.com`, normalised: null },
  { name: "a label of 63 characters", input: `x@${"a".repeat(63)}.com`, normalised: `x@${"a".repeat(63)}.com` },
  { name: "a space inside", input: "ri ta@example.com", normalised: null },
  { name: "a tab inside", input: "ri\tta@example.com", normalised: null },
  { name: "a NUL", input: "rita@example.com\u0000", normalised: null },
  { name: "a DEL", input: "rita\u007f@example.com", normalised: null },
  { name: "empty", input: "", normalised: null },
  { name: "only whitespace", input: " \t ", normalised: null },
  { name: "no @", input: "rita", normalised: null },
  { name: "no local part", input: "@example.com", normalised: null },
  { name: "no domain", input: "rita@", normalised: null },
  { name: "only a dot for a domain", input: "rita@.", normalised: null },
  { name: "an empty label", input: "rita@example..com", normalised: null },
  { name: "a leading dot", input: "rita@.example.com", normalised: null },
  { name: "over 320 bytes", input: `${"a".repeat(320)}@example.com`, normalised: null },
];

async function buildReceiptsV2(instance: VectorKey, agent: VectorKey, passRef: string) {
  const sub = "0wWorHT-zGDpWTirCnd5ixnX05zWga0OGKCyrQ6VfB0";
  const iss = `https://${INBOX}`;
  const header = { alg: ALG, typ: RECEIPT_TYP, kid: instance.kid };
  const key = { kid: instance.kid, publicJwk: instance.public_jwk, privateJwk: instance.private_jwk };
  const presentation = b64u((await sha256("vector:presentation")).slice(0, 16));
  const DAY = 86_400;

  type Payload = Record<string, unknown>;
  const receipts: { name: string; header: object; payload: Payload; jws: string; sha: string }[] = [];
  const add = async (name: string, payload: Payload) => {
    const jws = await signReceipt(payload as never, key as never);
    receipts.push({ name, header, payload, jws, sha: await receiptSha(jws) });
    return { payload, jws };
  };

  // One item per inbox outcome: its earliest promise, then the outcome that closes it.
  const items: {
    itm: string;
    typ: "booking" | "order";
    knd: "confirmed" | "paid" | "accepted";
    out: string;
    /** When the outcome happened, from the promise's iat, due and end. */
    at: (t: { iat: number; due: number; end: number }) => number;
    aut?: boolean;
    amt?: object;
    pay?: string;
    per?: boolean;
  }[] = [
    {
      itm: "01M3D5K8Z2QX7R4T6V9W0Y1B2C",
      typ: "booking",
      knd: "confirmed",
      out: "booking.completed",
      aut: true,
      per: true,
      amt: { value: 4500, currency: "EUR" },
      at: (t) => t.end + 2 * DAY,
    },
    {
      itm: "01M3D5K8Z2QX7R4T6V9W0Y1B2D",
      typ: "booking",
      knd: "confirmed",
      out: "booking.completed",
      per: true,
      at: (t) => t.end + 600,
    },
    {
      itm: "01M3D5K8Z2QX7R4T6V9W0Y1B2E",
      typ: "booking",
      knd: "confirmed",
      out: "booking.cancelled_by_business",
      at: (t) => t.iat + DAY,
    },
    {
      itm: "01M3D5K8Z2QX7R4T6V9W0Y1B2F",
      typ: "booking",
      knd: "confirmed",
      out: "booking.no_show_customer",
      per: true,
      at: (t) => t.due + 1800,
    },
    {
      itm: "01M3D5K8Z2QX7R4T6V9W0Y1B2G",
      typ: "booking",
      knd: "confirmed",
      out: "booking.cancelled_late_by_customer",
      at: (t) => t.due - 3600,
    },
    {
      itm: "01M3D5K8Z2QX7R4T6V9W0Y1B2H",
      typ: "booking",
      knd: "confirmed",
      out: "booking.cancelled_by_customer",
      at: (t) => t.iat + DAY,
    },
    {
      itm: "01M3D5M0N1P2Q3R4S5T6V7W8X9",
      typ: "order",
      knd: "accepted",
      out: "order.fulfilled",
      per: true,
      at: (t) => t.iat + 3 * DAY,
    },
    {
      itm: "01M3D5M0N1P2Q3R4S5T6V7W8XA",
      typ: "order",
      knd: "paid",
      out: "order.charged_back",
      amt: { value: 2990, currency: "EUR" },
      pay: "card",
      at: (t) => t.iat + 10 * DAY,
    },
    {
      itm: "01M3D5M0N1P2Q3R4S5T6V7W8XB",
      typ: "order",
      knd: "accepted",
      out: "order.not_fulfilled",
      at: (t) => t.iat + 2 * DAY,
    },
    {
      itm: "01M3D5M0N1P2Q3R4S5T6V7W8XC",
      typ: "order",
      knd: "accepted",
      out: "order.payment_failed",
      at: (t) => t.iat + DAY,
    },
    {
      itm: "01M3D5M0N1P2Q3R4S5T6V7W8XD",
      typ: "order",
      knd: "accepted",
      out: "order.lapsed",
      aut: true,
      at: (t) => t.iat + 14 * DAY,
    },
    {
      itm: "01M3D5M0N1P2Q3R4S5T6V7W8XE",
      typ: "order",
      knd: "accepted",
      out: "order.cancelled_by_customer",
      at: (t) => t.iat + DAY,
    },
  ];

  let completed = "";
  let completedIat = 0;
  let i = 0;
  for (const it of items) {
    i++;
    const iat = 1790010000 + i * 1000;
    const due = it.typ === "booking" ? iat + 7 * DAY : iat + 30 * DAY;
    const end = it.typ === "booking" ? due + 3600 : undefined;
    const promiseNonce = await nonceOf(`${it.itm}:promise`);
    const promise: Payload = {
      iss,
      sub,
      itm: it.itm,
      typ: it.typ,
      knd: it.knd,
      iat,
      nonce: promiseNonce,
      ...(it.amt ? { amt: it.amt } : {}),
      ...(it.pay ? { pay: it.pay } : {}),
      ver: 2,
      due,
      ...(end ? { end } : {}),
      ...(it.per ? { per: [{ n: NETWORK, p: presentation }] } : {}),
    };
    await add(`${it.typ} promise (${it.knd}) for ${it.out}`, promise);
    const outIat = it.at({ iat, due, end: end ?? due });
    const outcome: Payload = {
      iss,
      sub,
      itm: it.itm,
      typ: it.typ,
      knd: "outcome",
      iat: outIat,
      nonce: await nonceOf(`${it.itm}:outcome`),
      ver: 2,
      out: it.out,
      ref: promiseNonce,
      due,
      ...(end ? { end } : {}),
      ...(it.aut ? { aut: 1 } : {}),
      ...(it.per ? { per: [{ n: NETWORK, p: presentation }] } : {}),
    };
    const r = await add(`outcome ${it.out}${it.aut ? " (system, aut 1)" : ""}`, outcome);
    if (it.out === "booking.completed" && !it.aut) {
      completed = r.jws;
      completedIat = outIat;
    }
  }

  const ackHeader = { alg: ALG, typ: ACK_TYP, jwk: agent.public_jwk };
  const ackPayload = {
    rcp: "01M3D5RCPT00000000000000CP",
    sha: await receiptSha(completed),
    iat: completedIat + 600,
    pas: passRef,
  };
  const acknowledgements = [
    {
      name: "an acknowledgement of a kept outcome, naming the person's pass by reference (pas)",
      header: ackHeader,
      payload: ackPayload,
      jws: await signJws(ackHeader, ackPayload, agent.private_jwk),
      receipt_jws: completed,
      verify_at: completedIat + 600,
    },
  ];

  // Claims a network refuses. Each is properly signed: only its claims are wrong.
  const base = receipts[0]?.payload as Payload;
  const outcomeBase = receipts[1]?.payload as Payload;
  const orderPromise = receipts[12]?.payload as Payload;
  const refusedClaims: { name: string; payload: Payload; code: string }[] = [
    { name: "ver 3", payload: { ...base, ver: 3 }, code: "bad_payload" },
    {
      name: "v2 about a quote request",
      payload: { ...base, typ: "quote_request", end: undefined },
      code: "bad_payload",
    },
    {
      name: "accepted without ver 2",
      payload: { ...orderPromise, ver: undefined, due: undefined },
      code: "bad_payload",
    },
    { name: "no due", payload: { ...base, due: undefined, end: undefined }, code: "bad_payload" },
    { name: "due beyond 2^37", payload: { ...base, due: 2 ** 37 + 1, end: undefined }, code: "bad_payload" },
    {
      name: "end on an order",
      payload: { ...orderPromise, end: (orderPromise.due as number) + 60 },
      code: "bad_payload",
    },
    { name: "end before due", payload: { ...base, end: (base.due as number) - 1 }, code: "bad_payload" },
    { name: "aut 2", payload: { ...outcomeBase, aut: 2 }, code: "bad_payload" },
    { name: "an outcome without out", payload: { ...outcomeBase, out: undefined }, code: "bad_payload" },
    { name: "an outcome without ref", payload: { ...outcomeBase, ref: undefined }, code: "bad_payload" },
    { name: "out on a promise", payload: { ...base, out: "booking.completed" }, code: "bad_payload" },
    { name: "ref on a promise", payload: { ...base, ref: base.nonce }, code: "bad_payload" },
    {
      name: "promise.unclosed is the network's",
      payload: { ...outcomeBase, out: "promise.unclosed" },
      code: "bad_payload",
    },
    { name: "a report's outcome", payload: { ...outcomeBase, out: "booking.no_show_business" }, code: "bad_payload" },
    {
      name: "an order's outcome on a booking",
      payload: { ...outcomeBase, out: "order.fulfilled" },
      code: "bad_payload",
    },
    {
      name: "per names 9 networks",
      payload: { ...base, per: Array.from({ length: 9 }, (_, k) => ({ n: `n${k}.example.com`, p: presentation })) },
      code: "bad_payload",
    },
    {
      name: "a per entry's presentation id is not 22 base64url",
      payload: { ...base, per: [{ n: NETWORK, p: "short" }] },
      code: "bad_payload",
    },
    {
      name: "a per entry's host is not lowercase",
      payload: { ...base, per: [{ n: "Network.Example.com", p: presentation }] },
      code: "bad_payload",
    },
    { name: "a negative amount", payload: { ...base, amt: { value: -1, currency: "EUR" } }, code: "bad_payload" },
    { name: "iat 301 s ahead of the check", payload: { ...base, iat: RECEIPTS_V2_NOW + 301 }, code: "not_yet" },
  ];
  const refused_receipts = [];
  for (const r of refusedClaims) {
    const payload = JSON.parse(JSON.stringify(r.payload)) as Payload; // drops the undefined claims
    refused_receipts.push({
      name: r.name,
      payload,
      jws: await signJws(header, payload, instance.private_jwk),
      code: r.code,
    });
  }

  return {
    $comment:
      "Test vectors for receipt claims v2 (ADR-017 §3.2), MIT. The instance key is RFC 8037 A.1 (as in receipts.json) and the agent's seed is ASCII 'surfingdog-inbox-agent-vector-01': re-signing `payload` reproduces `jws` byte for byte. Verify every receipt at `now`; each item's outcome follows its earliest promise, whose nonce is its `ref`. `outcomes` is §3's table: the side each outcome writes a row on and its weight `o`; only `by: inbox` outcomes travel in receipts. `refused_receipts` are signed correctly and refused for their claims, with the code a network answers (HTTP 422). `transitions` is every path through the booking and order state machines (event, the state it leaves, the actor) with the outcome it records (`out`, null for none) and `aut`. Generated by packages/core/scripts/gen-network-vectors.ts.",
    spec: "surfingdog-inbox/0",
    now: RECEIPTS_V2_NOW,
    issuer: { kid: instance.kid, public_jwk: instance.public_jwk, private_jwk: instance.private_jwk },
    agent: { kid: agent.kid, public_jwk: agent.public_jwk, private_jwk: agent.private_jwk },
    outcomes: OUTCOMES,
    receipts,
    acknowledgements,
    refused_receipts,
    transitions: transitionPaths(),
  };
}

/**
 * Which outcome each transition records (ADR-017 §3, §3.1), written by hand from the ADR's table:
 * the event, the states it leaves, and whose it is — `customer` for the customer's own, `business`
 * for everyone else (owners, staff, rules, connectors, the system). Anything not listed records none.
 */
const OUTCOME_PATHS: {
  typ: "booking" | "order";
  event: string;
  from: string[];
  by: "customer" | "business";
  out: string;
}[] = [
  { typ: "booking", event: "complete", from: ["confirmed"], by: "business", out: "booking.completed" },
  { typ: "booking", event: "complete", from: ["no_show"], by: "business", out: "booking.completed" },
  {
    typ: "booking",
    event: "no_show",
    from: ["confirmed", "completed"],
    by: "business",
    out: "booking.no_show_customer",
  },
  {
    typ: "booking",
    event: "cancel_by_business",
    from: ["confirmed"],
    by: "business",
    out: "booking.cancelled_by_business",
  },
  { typ: "booking", event: "cancel", from: ["confirmed"], by: "customer", out: "booking.cancelled_by_customer" },
  {
    typ: "booking",
    event: "cancel_late",
    from: ["confirmed"],
    by: "customer",
    out: "booking.cancelled_late_by_customer",
  },
  { typ: "order", event: "fulfil", from: ["accepted", "paid", "fulfilling"], by: "business", out: "order.fulfilled" },
  {
    typ: "order",
    event: "cancel",
    from: ["accepted", "awaiting_payment", "payment_failed"],
    by: "business",
    out: "order.not_fulfilled",
  },
  {
    typ: "order",
    event: "cancel",
    from: ["accepted", "awaiting_payment", "payment_failed"],
    by: "customer",
    out: "order.cancelled_by_customer",
  },
  { typ: "order", event: "payment_failed", from: ["awaiting_payment"], by: "business", out: "order.payment_failed" },
  {
    typ: "order",
    event: "charge_back",
    from: ["paid", "fulfilling", "fulfilled"],
    by: "business",
    out: "order.charged_back",
  },
  { typ: "order", event: "record_charge_back", from: ["completed"], by: "business", out: "order.charged_back" },
  { typ: "order", event: "lapse", from: ["awaiting_payment", "payment_failed"], by: "business", out: "order.lapsed" },
];

/** `aut: 1` when nobody decided it in the moment: the system, or a rule. */
const AUTOMATIC_ACTORS = ["system", "rule"];

/**
 * Every path through the booking and order machines — each event, from each state it leaves, by
 * each actor that may fire it — with the outcome it records, or null.
 */
function transitionPaths() {
  const paths: {
    typ: string;
    event: string;
    from: string;
    to: string;
    actor: string;
    out: string | null;
    aut: 0 | 1;
  }[] = [];
  for (const m of [bookingMachine, orderMachine]) {
    for (const t of m.transitions) {
      for (const from of t.from) {
        for (const actor of t.by) {
          const side = CUSTOMER_ACTORS.includes(actor) ? "customer" : "business";
          const hit = OUTCOME_PATHS.find(
            (p) => p.typ === m.type && p.event === t.event && p.from.includes(from) && p.by === side,
          );
          const out = hit?.out ?? null;
          paths.push({
            typ: m.type,
            event: t.event,
            from,
            to: t.to,
            actor,
            out,
            aut: out && AUTOMATIC_ACTORS.includes(actor) ? 1 : 0,
          });
        }
      }
    }
  }
  return paths;
}

/** The moment every v2 receipt is checked at: after the last one, so none is "not yet". */
export const RECEIPTS_V2_NOW = 1792000000;
