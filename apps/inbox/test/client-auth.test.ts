import { describe, expect, it } from "vitest";
import { sameSitePath } from "../client/src/lib/auth";

/** `/login?redirect=…` is a link anyone can send the owner: after signing in it may only go to a page here. */
describe("the page the owner app goes back to after sign-in", () => {
  it("is a path on this site", () => {
    expect(sameSitePath("/items/01J?tab=timeline#reply")).toBe("/items/01J?tab=timeline#reply");
    expect(sameSitePath("/")).toBe("/");
  });

  it("is never another site, however it is written", () => {
    for (const value of [
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "https://evil.example/",
      "javascript:alert(1)",
      "evil.example",
      "",
      undefined,
      42,
    ]) {
      expect(sameSitePath(value)).toBeUndefined();
    }
  });
});
