import { describe, expect, it } from "vitest";
import { listFrom, publicUrlFrom, secretKeyFrom, senderFrom } from "../src/env";

/**
 * The Deploy to Cloudflare button asks for every value in .dev.vars.example, so each can arrive
 * empty, padded, or as whatever someone typed. None of that may break a request.
 */
describe("the host's settings", () => {
  it("reads an empty INBOX_PUBLIC_URL as none, and one that is not an address as none, saying so", () => {
    const said: string[] = [];
    const log = (line: string) => said.push(line);
    expect(publicUrlFrom(undefined, log)).toBeUndefined();
    expect(publicUrlFrom("", log)).toBeUndefined();
    expect(publicUrlFrom("   ", log)).toBeUndefined();
    expect(said).toEqual([]);
    expect(publicUrlFrom("none", log)).toBeUndefined();
    expect(publicUrlFrom("ftp://inbox.example.com", log)).toBeUndefined();
    expect(said).toHaveLength(2);
    expect(said[0]).toContain("INBOX_PUBLIC_URL");
  });

  it("keeps an address as its origin", () => {
    expect(publicUrlFrom(" https://inbox.oficinamare.pt/ ")).toBe("https://inbox.oficinamare.pt");
    expect(publicUrlFrom("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("has no sender without an address, and a name only when one was given", () => {
    expect(senderFrom(undefined, "Oficina Maré")).toBeUndefined();
    expect(senderFrom(" ", undefined)).toBeUndefined();
    expect(senderFrom("inbox@oficinamare.pt", "")).toEqual({ address: "inbox@oficinamare.pt" });
    expect(senderFrom(" inbox@oficinamare.pt ", " Oficina Maré ")).toEqual({
      address: "inbox@oficinamare.pt",
      name: "Oficina Maré",
    });
  });

  it("reads a list with the gaps left out", () => {
    expect(listFrom(undefined)).toEqual([]);
    expect(listFrom("")).toEqual([]);
    expect(listFrom(" a@example.com, ,b@example.com ")).toEqual(["a@example.com", "b@example.com"]);
  });

  it("reads a sender written with its name, and says so when MAIL_FROM is not an address", () => {
    const said: string[] = [];
    const log = (line: string) => said.push(line);
    expect(senderFrom("Oficina Maré <inbox@oficinamare.pt>", undefined, log)).toEqual({
      address: "inbox@oficinamare.pt",
      name: "Oficina Maré",
    });
    // MAIL_FROM_NAME wins over the name written into MAIL_FROM.
    expect(senderFrom('"Oficina" <inbox@oficinamare.pt>', "Oficina Maré", log)).toEqual({
      address: "inbox@oficinamare.pt",
      name: "Oficina Maré",
    });
    expect(senderFrom("<inbox@oficinamare.pt>", undefined, log)).toEqual({ address: "inbox@oficinamare.pt" });
    expect(said).toEqual([]);
    // A placeholder typed into the deploy form is no sender: the sign-in link then goes to the log
    // with that reason, instead of every email failing against an address that cannot exist.
    expect(senderFrom("none", undefined, log)).toBeUndefined();
    expect(senderFrom("inbox@", undefined, log)).toBeUndefined();
    expect(said).toHaveLength(2);
    expect(said[0]).toContain("MAIL_FROM");
  });

  it("uses INBOX_SECRET_KEY as given, and says so when the newest key is too short to be safe", () => {
    const said: string[] = [];
    const log = (line: string) => said.push(line);
    const strong = "q2JtC8yJX5m1Vv8b0mH3m6sQ2cQ9k3n1W0yJ7f8hX2c=";
    expect(secretKeyFrom(undefined, log)).toBeUndefined();
    expect(secretKeyFrom("  ", log)).toBeUndefined();
    expect(secretKeyFrom(` ${strong}\n`, log)).toBe(strong);
    expect(secretKeyFrom(`${strong},short`, log)).toBe(`${strong},short`);
    expect(said).toEqual([]);
    // Still used, since secrets already sealed with it must keep opening, but never silently.
    expect(secretKeyFrom("changeme", log)).toBe("changeme");
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("INBOX_SECRET_KEY");
    expect(said[0]).not.toContain("changeme");
  });
});
