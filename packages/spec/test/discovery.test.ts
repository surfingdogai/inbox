import { describe, expect, it } from "vitest";
import {
  AI_ASSISTANT_AGENTS,
  AI_ASSISTANT_SEARCH,
  checkDnsInputSchema,
  checkDnsOutputSchema,
  DISCOVERY_DNS_NAME,
  DISCOVERY_REL,
  discoveryResultSchema,
  discoverySnippets,
  scriptJson,
  startInboxOutputSchema,
} from "../src/index";
import vectors from "../vectors/discovery.json";

/**
 * The lines that lead an agent from a business's domain to its inbox (ADR-022), against
 * `vectors/discovery.json`: the network's discovery check and a hosted inbox's Connect page are held
 * to the same file, so the three never say two things.
 */
describe("discovery snippets", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(discoverySnippets(c.domain, c.host, c.business)).toEqual(c.snippets);
    });
  }

  it("name the same assistants as the vectors", () => {
    expect([...AI_ASSISTANT_AGENTS]).toEqual(vectors.assistants);
    expect([...AI_ASSISTANT_SEARCH]).toEqual(vectors.assistant_search);
  });

  it("never let a name close the script it sits in", () => {
    const s = discoverySnippets("salon.example", "inbox.salon.example", "</script><script>alert(1)</script>");
    expect(s.json_ld.indexOf("</script>")).toBe(s.json_ld.length - "</script>".length);
    const inner = s.json_ld.slice('<script type="application/ld+json">'.length, -"</script>".length);
    expect(JSON.parse(inner).name).toBe("</script><script>alert(1)</script>");
    expect(scriptJson({ a: " &" })).toBe('{"a":"\\u2028\\u0026"}');
  });

  it("use the relation and the DNS name ADR-002 names", () => {
    const s = discoverySnippets("example.com", "inbox.example.com");
    expect(s.link_tag).toContain(`rel="${DISCOVERY_REL}"`);
    expect(s.dns_name).toBe(DISCOVERY_DNS_NAME);
    expect(s.dns_value).toBe("v=sdi1; manifest=https://inbox.example.com/.well-known/agent-inbox.json");
  });
});

describe("the discovery check's shapes", () => {
  const result = {
    domain: "example.com",
    host: "inbox.example.com",
    manifest: "https://inbox.example.com/.well-known/agent-inbox.json",
    checked_at: "2026-10-18T12:00:00.123456789Z",
    ready: false,
    ways: 1,
    next: "Add it.",
    items: [
      { id: "cname", need: "required", state: "ok", detail: "inbox.example.com has an address in DNS." },
      {
        id: "robots",
        need: "required",
        state: "blocked",
        detail: "robots.txt keeps out …",
        fix: "User-agent: Claude-User\nAllow: /\n",
      },
    ],
  };

  it("take a network's answer, and refuse one that is not a check", () => {
    expect(discoveryResultSchema.safeParse(result).success).toBe(true);
    expect(checkDnsOutputSchema.safeParse(result).success).toBe(true);
    expect(discoveryResultSchema.safeParse({ ...result, ways: 6 }).success).toBe(false);
    expect(
      discoveryResultSchema.safeParse({
        ...result,
        items: [{ id: "elsewhere", need: "required", state: "ok", detail: "" }],
      }).success,
    ).toBe(false);
  });

  it("check_dns takes a domain, and a host and a target when known", () => {
    expect(checkDnsInputSchema.safeParse({ domain: "example.com" }).success).toBe(true);
    expect(checkDnsInputSchema.safeParse({}).success).toBe(false);
  });

  it("start_inbox answers a link, or why there is none, never an email", () => {
    const ok = startInboxOutputSchema.safeParse({
      domain: "example.com",
      status: "available",
      start_url: "https://app.surfingdog.ai/start?domain=example.com",
      host: "inbox.example.com",
      self_host: "https://github.com/surfingdogai/inbox",
      detail: "Give the owner this link…",
    });
    expect(ok.success).toBe(true);
    expect(Object.keys(startInboxOutputSchema.shape)).not.toContain("email");
  });
});
