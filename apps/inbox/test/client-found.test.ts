import { discoverySnippets } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import vectors from "../../../packages/spec/vectors/discovery-words.json";
import {
  DNS_RECORD,
  DNS_RECORD_LINE,
  GROUP_OF,
  GROUPS,
  ITEM_WORDS,
  PLATFORMS,
  ROBOTS_LEAD,
  ROBOTS_NOTE,
  shortDetail,
  VERDICTS,
  verdict,
  webPersonEmail,
  webPersonMailto,
} from "../client/src/lib/found";

// Settings → Be found says what a hosted inbox's Connect page and the WordPress plugin say: the spec's
// vectors/discovery-words.json, word for word.
describe("Be found's words", () => {
  it("are the vectors'", () => {
    expect(VERDICTS).toEqual(vectors.verdict);
    expect(ITEM_WORDS).toEqual(vectors.items);
    expect(GROUPS).toEqual(vectors.groups);
    expect(GROUP_OF).toEqual(vectors.group_of);
    expect([ROBOTS_LEAD, ROBOTS_NOTE, DNS_RECORD, DNS_RECORD_LINE]).toEqual([
      vectors.robots_lead,
      vectors.robots_note,
      vectors.dns_record,
      vectors.dns_record_line,
    ]);
    expect(PLATFORMS).toEqual(vectors.platforms);
  });

  it("say an item's detail without its label", () => {
    for (const c of vectors.short_details) expect(shortDetail(c.detail, c.state, c.domain)).toBe(c.short);
  });

  it("never tell an owner to install a plugin that cannot be downloaded", () => {
    for (const p of PLATFORMS) {
      if (p.download) continue;
      for (const st of p.steps) {
        expect(st).not.toMatch(/Upload Plugin|Install the Surfing Dog/);
      }
    }
  });

  it("read a state they do not know as not ready", () => {
    expect(verdict({ state: undefined, ready: false, ways: 2, host: "inbox.x.example" })).toBe(
      "Not yet: 2 of 5 ways in place.",
    );
    expect(verdict({ state: "unreachable", ready: false, ways: 0, host: "inbox.x.example" })).toBe(
      "Not yet: the inbox doesn't answer at inbox.x.example.",
    );
    expect(verdict({ state: "ready", ready: true, ways: 3, host: "inbox.x.example" })).toBe(
      "Your website points agents to your inbox: 3 of 5 ways in place.",
    );
  });

  it("give whoever runs the site one email, to send or to copy", () => {
    const s = discoverySnippets("salon.example", "inbox.salon.example", "Salon");
    const text = webPersonEmail("salon.example", "inbox.salon.example", s);
    expect(text).toContain(s.link_tag);
    expect(text).toContain(s.dns_value);
    expect(
      decodeURIComponent(webPersonMailto("salon.example", "inbox.salon.example", s).split("&body=")[1] ?? ""),
    ).toBe(text);
  });
});
