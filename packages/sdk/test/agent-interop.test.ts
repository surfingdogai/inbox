import { describe, expect, it } from "vitest";
// The receivers, imported from the Inbox itself, as interop.test.ts does for webhooks. The shipped SDK
// never imports them: @surfingdog/sdk is MIT, and the point here is that the two sides are PROVEN to
// agree — the inbox's doors, the forwarding a network checks again, and the acknowledgement door.
import { carriesSecret } from "../../adapters/src/identity";
import { agentKeyOf, verifyAgentRequest, verifyForwardedSignature } from "../../core/src/protocol/httpsig";
import { generateKeyPair, signReceipt, verifyAck } from "../../core/src/receipts/sign";
import {
  delegate,
  generateAgentKey,
  keepPasses,
  NetworkCallError,
  passFromKey,
  receiptSha,
  requestSignInCode,
  signAck,
  signIn,
  signRequest,
  verifyReceipt,
} from "../src/index";

/**
 * The SDK an agent uses against the code an inbox and a network run: a request it signs verifies
 * at the inbox's door and again when forwarded to a network, carries no secret into anything
 * forwarded, an acknowledgement it signs is taken by the acknowledge door, a receipt the inbox
 * signs verifies here, and the setup calls reach a network in the shape it reads. Node and workerd.
 */
const INBOX = "inbox.example.com";
const NETWORK = "network.example.com";
const PASS = "sdpass1_network.example.com_jw2i4xgq523v6wfb_krieilymhdwjhq26zhroiy7oi54pnzgc";
const REF = "sdpass1_network.example.com_jw2i4xgq523v6wfb";
const KEY = "sdkey1_network.example.com_lzas5slnihwsguys_tdgamtpwh53bebf7yxm74iwkrwpyupiz";
const SESSION = "sdps_wssj4wb5rdeybyci3b462iw727ttf4tp";

async function atInbox(
  signed: Awaited<ReturnType<typeof signRequest>>,
  method: string,
  url: string,
  body: string | null,
) {
  return verifyAgentRequest({
    method,
    url,
    headers: signed.headers,
    body,
    authorities: [INBOX],
    now: Date.now(),
    platformKey: async () => null,
  });
}

describe("a request the SDK signs", () => {
  it("verifies at the inbox's door, and again at a network when the inbox forwards it", async () => {
    const key = await generateAgentKey();
    const url = `https://${INBOX}/v1/bookings`;
    const body = JSON.stringify({ contact: { name: "Rita", email: "rita@example.com" } });
    const signed = await signRequest({ method: "POST", url, body, key, passes: [REF] });
    const v = await atInbox(signed, "POST", url, body);
    expect(v).toMatchObject({ status: "verified", level: "self", keyid: key.thumbprint });
    if (v.status !== "verified") throw new Error("not verified");
    // What the inbox forwards is the agent's own base, which carries nothing secret.
    expect(carriesSecret(v.signatureBase)).toBe(false);
    const forwarded = agentKeyOf(v, REF);
    await expect(verifyForwardedSignature(forwarded, key.publicJwk.x, INBOX, Date.now())).resolves.toBeDefined();
    // A body changed after signing is no longer this signature.
    const changed = await atInbox(signed, "POST", url, body.replace("Rita", "Ana"));
    expect(changed.status).toBe("invalid");
  });

  it("signs a GET with the access token in X-Access-Token, never in the URL", async () => {
    const key = await generateAgentKey();
    const url = `https://${INBOX}/v1/items/01M34AVYNXTNSE2RC495H3W8QS`;
    const signed = await signRequest({
      method: "GET",
      url,
      key,
      passes: [REF],
      headers: { "X-Access-Token": "at_secret_value" },
    });
    const v = await atInbox(signed, "GET", url, null);
    expect(v.status).toBe("verified");
    if (v.status === "verified") expect(carriesSecret(v.signatureBase)).toBe(false);
    expect(signed.signatureBase).not.toContain("at_secret_value");
    await expect(
      signRequest({ method: "GET", url: `${url}?access_token=at_secret_value`, key, passes: [REF] }),
    ).rejects.toMatchObject({ code: "secret_in_url" });
    await expect(signRequest({ method: "GET", url: `${url}?pass=${PASS}`, key })).rejects.toMatchObject({
      code: "secret_in_url",
    });
  });

  it("gives two identical requests in the same second two signatures, so neither is a replay", async () => {
    const key = await generateAgentKey();
    const url = `https://${INBOX}/v1/bookings`;
    const now = Date.now();
    const a = await signRequest({ method: "POST", url, body: "{}", key, now });
    const b = await signRequest({ method: "POST", url, body: "{}", key, now });
    expect(a.signature).not.toBe(b.signature);
  });
});

describe("receipts between an inbox and the SDK", () => {
  it("verifies a receipt the inbox signs, and the acknowledge door takes the SDK's counter-signature", async () => {
    const issuer = await generateKeyPair();
    const iat = Math.floor(Date.now() / 1000);
    const jws = await signReceipt(
      {
        iss: `https://${INBOX}`,
        sub: "0wWorHT-zGDpWTirCnd5ixnX05zWga0OGKCyrQ6VfB0",
        itm: "01M34AVYNXTNSE2RC495H3W8QS",
        typ: "booking",
        knd: "confirmed",
        iat,
        nonce: "0123456789abcdef0123456789abcdef",
        ver: 2,
        due: iat + 86_400,
      },
      issuer,
    );
    const v = await verifyReceipt(jws, { keys: [issuer.publicJwk] }, { issuer: `https://${INBOX}` });
    expect(v).toMatchObject({ version: 2, claims: { knd: "confirmed", due: iat + 86_400 } });
    const agent = await generateAgentKey();
    const ack = await signAck({ receipt: jws, receiptId: "rcpt_1", key: agent, passRef: REF });
    const checked = await verifyAck(ack, { receiptId: "rcpt_1", receiptJws: jws, now: Date.now() });
    expect(checked.agentKid).toBe(agent.thumbprint);
    expect(checked.payload).toMatchObject({ rcp: "rcpt_1", sha: await receiptSha(jws), pas: REF });
  });
});

describe("setting up at the network", () => {
  /** A network that answers the three setup calls, checking each as it would. */
  function network() {
    const calls: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const text = String(init?.body ?? "");
      const headers = new Headers(init?.headers);
      calls.push({ path: url.pathname, body: JSON.parse(text) as Record<string, unknown>, headers });
      switch (url.pathname) {
        case "/v1/passes":
          return Response.json({ pass: PASS }, { status: 201 });
        case "/v1/recovery/start":
          return new Response(null, { status: 202 });
        case "/v1/recovery/finish":
          return JSON.parse(text).code === "123456"
            ? Response.json({ session: SESSION, expires_at: "2026-09-24T12:00:00Z" })
            : Response.json({ code: "bad_code", detail: "that code is not right" }, { status: 422 });
        case "/v1/delegations": {
          if (headers.get("authorization") !== `Bearer ${SESSION}`) {
            return Response.json({ code: "not_signed_in" }, { status: 401 });
          }
          const v = await verifyAgentRequest({
            method: "POST",
            url: url.href,
            headers,
            body: text,
            authorities: [NETWORK],
            now: Date.now(),
            platformKey: async () => null,
          });
          if (v.status !== "verified" || v.level !== "self")
            return Response.json({ code: "bad_signature" }, { status: 401 });
          return Response.json({ pass_ref: REF, jkt: v.keyid, bound: true }, { status: 201 });
        }
        default:
          return new Response(null, { status: 404 });
      }
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it("trades a key for a pass, signs in with an emailed code, and delegates the agent's key to the pass", async () => {
    const net = network();
    const { pass } = await passFromKey({ key: KEY, label: "Travel assistant", fetch: net.fetchImpl });
    expect(pass).toBe(PASS);
    expect(keepPasses([], [{ pass }])).toEqual([PASS]);
    await requestSignInCode({ network: NETWORK, email: "rita@example.com", fetch: net.fetchImpl });
    await expect(
      signIn({ network: NETWORK, email: "rita@example.com", code: "000000", fetch: net.fetchImpl }),
    ).rejects.toMatchObject({ status: 422, code: "bad_code" });
    const { session } = await signIn({
      network: NETWORK,
      email: "rita@example.com",
      code: "123456",
      fetch: net.fetchImpl,
    });
    const key = await generateAgentKey();
    const d = await delegate({ session, pass, key, fetch: net.fetchImpl });
    expect(d).toEqual({ pass_ref: REF, jkt: key.thumbprint, bound: true });
    expect(net.calls.map((c) => c.path)).toEqual([
      "/v1/passes",
      "/v1/recovery/start",
      "/v1/recovery/finish",
      "/v1/recovery/finish",
      "/v1/delegations",
    ]);
    expect(net.calls[0]?.body).toEqual({ key: KEY, label: "Travel assistant" });
    expect(net.calls[1]?.body).toEqual({ email: "rita@example.com", purpose: "sign_in" });
    // From now on the agent carries the reference: the pass it held gives way to it.
    expect(keepPasses([pass], [{ pass: d.pass_ref }])).toEqual([REF]);
  });

  it("says what a network refused, by its code", async () => {
    const key = await generateAgentKey();
    const refuse = (async () =>
      Response.json({ code: "not_signed_in", detail: "sign in first" }, { status: 401 })) as unknown as typeof fetch;
    const err = await delegate({ session: SESSION, pass: PASS, key, fetch: refuse }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkCallError);
    expect(err).toMatchObject({ status: 401, code: "not_signed_in", message: "sign in first" });
  });
});
