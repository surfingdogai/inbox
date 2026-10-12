import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAddressRange } from "../src/addresses";
import { OutboundRefused, pinnedFetch, type ResolvedAddress } from "../src/node/outbound";

/**
 * Every outbound call on Node resolves the name, refuses it when any address is not public, and
 * connects to the address it checked. A local server stands in for whatever a refused call would
 * have reached, so each refusal is also shown to send it nothing.
 */
let server: Server;
let port = 0;
const seen: { url: string; host: string; method: string; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (c) => {
      body += String(c);
    });
    req.on("end", () => {
      seen.push({ url: req.url ?? "", host: req.headers.host ?? "", method: req.method ?? "", body });
      if (req.url === "/stall") {
        // Headers and a little of the body, then nothing: a server that stops half-way.
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("half");
      } else if (req.url === "/gzip") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(gzipSync("unzipped on the way in"));
      } else if (req.url?.startsWith("/to/")) {
        res.writeHead(302, { location: decodeURIComponent(req.url.slice(4)) });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

afterAll(
  () =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    }),
);

/** A resolver that answers from a table, and counts how often it was asked. */
function table(map: Record<string, string[]>) {
  const asked: string[] = [];
  const resolve = async (hostname: string): Promise<ResolvedAddress[]> => {
    asked.push(hostname);
    const all = map[hostname];
    if (!all) throw Object.assign(new Error(`${hostname} not found`), { code: "ENOTFOUND" });
    return all.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { asked, resolve };
}

const range = (text: string) => {
  const r = parseAddressRange(text);
  if (!r) throw new Error(`${text} is not a range`);
  return r;
};

async function refusal(call: Promise<Response>): Promise<Error> {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "the call should have been refused").toBeInstanceOf(Error);
  return error as Error;
}

describe("a call to an address that is not public", () => {
  it("is refused, written into the URL: the admin port on loopback, the metadata service, [::1]", async () => {
    const before = seen.length;
    const outbound = pinnedFetch();
    for (const url of [
      `http://127.0.0.1:${port}/stop`,
      "http://169.254.169.254/latest/meta-data/",
      `http://[::1]:${port}/`,
      `http://2130706433:${port}/`,
      `http://[::ffff:127.0.0.1]:${port}/`,
    ]) {
      const error = await refusal(outbound(url, { method: "POST", body: "{}" }));
      expect(error, url).toBeInstanceOf(OutboundRefused);
      expect(error.message, url).toMatch(/not called$/);
    }
    expect(seen.length).toBe(before);
  });

  it("is refused when a public name resolves to it, before anything is sent", async () => {
    const before = seen.length;
    const dns = table({ "rebind.example.com": ["127.0.0.1"], "metadata.example.com": ["169.254.169.254"] });
    const outbound = pinnedFetch({ resolve: dns.resolve });
    const error = await refusal(outbound(`http://rebind.example.com:${port}/hook`, { method: "POST", body: "{}" }));
    expect(error.message).toBe("rebind.example.com resolves to 127.0.0.1, a loopback address: not called");
    expect((await refusal(outbound("https://metadata.example.com/"))).message).toContain("a link-local address");
    expect(seen.length).toBe(before);
  });

  it("is refused when any one of a name's addresses is not public", async () => {
    const dns = table({ "mixed.example.com": ["93.184.215.14", "10.0.0.5"] });
    const error = await refusal(pinnedFetch({ resolve: dns.resolve })("https://mixed.example.com/"));
    expect(error.message).toContain("10.0.0.5, a private address");
  });

  it("is refused at the host's own addresses (INBOX_OUTBOUND_DENY), even with private targets allowed", async () => {
    const dns = table({ "self.example.com": ["8.8.8.8"] });
    const deny = [range("8.8.8.8/32")];
    for (const allowPrivate of [false, true]) {
      const error = await refusal(
        pinnedFetch({ resolve: dns.resolve, deny, allowPrivate })("https://self.example.com/"),
      );
      expect(error.message).toBe(
        "self.example.com resolves to 8.8.8.8, an address this host does not call: not called",
      );
    }
    const literal = await refusal(pinnedFetch({ deny })("https://8.8.8.8/"));
    expect(literal.message).toBe("8.8.8.8 is an address this host does not call: not called");
    // The same address through NAT64's prefix, as DNS64 on an IPv6-only server answers for it.
    const nat64 = table({ "self6.example.com": ["64:ff9b::808:808"] });
    for (const allowPrivate of [false, true]) {
      const error = await refusal(
        pinnedFetch({ resolve: nat64.resolve, deny, allowPrivate })("https://self6.example.com/"),
      );
      expect(error.message).toContain("an address this host does not call");
    }
  });

  it("is refused through NAT64's prefix too, as the IPv4 address it reaches", async () => {
    const dns = table({ "rebind6.example.com": ["93.184.215.14", "64:ff9b::7f00:1"] });
    const error = await refusal(pinnedFetch({ resolve: dns.resolve })("https://rebind6.example.com/"));
    expect(error.message).toBe("rebind6.example.com resolves to 64:ff9b::7f00:1, a loopback address: not called");
  });
});

describe("a call that is let through", () => {
  it("connects to the address that was checked, with the name the caller used", async () => {
    // The owner's own machine: private targets allowed, and the name resolved by the table alone.
    const dns = table({ "hooks.example.com": ["127.0.0.1"] });
    const outbound = pinnedFetch({ resolve: dns.resolve, allowPrivate: true });
    const res = await outbound(`http://hooks.example.com:${port}/hook`, {
      method: "POST",
      body: JSON.stringify({ hello: "there" }),
      headers: { "content-type": "application/json" },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const last = seen.at(-1);
    expect(last).toMatchObject({ url: "/hook", host: `hooks.example.com:${port}`, method: "POST" });
    expect(last?.body).toBe('{"hello":"there"}');
    // Resolved once, by the check itself: nothing asked again before connecting.
    expect(dns.asked).toEqual(["hooks.example.com"]);
  });

  it("decodes a gzipped body as fetch does", async () => {
    const res = await pinnedFetch({ allowPrivate: true })(`http://127.0.0.1:${port}/gzip`);
    expect(await res.text()).toBe("unzipped on the way in");
  });

  it("hands a redirect back as it is when the caller follows none", async () => {
    const res = await pinnedFetch({ allowPrivate: true })(`http://127.0.0.1:${port}/to/${encodeURIComponent("/x")}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/x");
  });

  it("checks every redirect it follows again", async () => {
    const outbound = pinnedFetch({ allowPrivate: true, deny: [range("127.0.0.2/32")] });
    const onward = await outbound(`http://127.0.0.1:${port}/to/${encodeURIComponent("/landed")}`);
    expect(onward.status).toBe(200);
    expect(seen.at(-1)?.url).toBe("/landed");
    const before = seen.length;
    const away = `http://127.0.0.2:${port}/landed`;
    const error = await refusal(outbound(`http://127.0.0.1:${port}/to/${encodeURIComponent(away)}`));
    expect(error.message).toBe("127.0.0.2 is an address this host does not call: not called");
    expect(seen.length).toBe(before + 1);
  });

  it("closes a connection that has gone quiet, so a stalled server holds no socket", async () => {
    const res = await pinnedFetch({ allowPrivate: true, idleTimeoutMs: 100 })(`http://127.0.0.1:${port}/stall`);
    expect(res.status).toBe(200);
    const error = await res.text().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
  });

  it("stops when its signal does", async () => {
    const controller = new AbortController();
    controller.abort();
    await refusal(pinnedFetch({ allowPrivate: true })(`http://127.0.0.1:${port}/`, { signal: controller.signal }));
  });

  it("says when a name has no address", async () => {
    const dns = table({});
    const error = await refusal(pinnedFetch({ resolve: dns.resolve })("https://nowhere.example.com/"));
    expect(error.message).toContain("nowhere.example.com");
  });
});
