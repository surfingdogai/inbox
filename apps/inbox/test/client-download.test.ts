import { describe, expect, it } from "vitest";
import { attachmentName } from "../client/src/lib/download";

/** The name the owner app saves a download under: the one the inbox gives it, when it is a plain name. */
describe("a download's file name", () => {
  it("is the one the answer gives, and nothing that could be a path", () => {
    expect(attachmentName('attachment; filename="salao-rosa-2026-10-12.zip"', "inbox.zip")).toBe(
      "salao-rosa-2026-10-12.zip",
    );
    expect(attachmentName(null, "inbox.zip")).toBe("inbox.zip");
    expect(attachmentName("attachment", "inbox.zip")).toBe("inbox.zip");
    expect(attachmentName('attachment; filename="../../etc/passwd"', "inbox.zip")).toBe("inbox.zip");
    expect(attachmentName('attachment; filename="a b.zip"', "inbox.zip")).toBe("inbox.zip");
  });
});
