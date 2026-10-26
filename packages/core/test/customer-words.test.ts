import { describe, expect, it } from "vitest";
import { customerCopyProblems, customerWordsIn } from "../src/i18n/customer-words";

/** The customer copy lint (ADR-032): what a business's customers read never names the plumbing. */
describe("words customers never read", () => {
  it("finds the plumbing's names as whole words, in any case", () => {
    expect(customerWordsIn("Powered by Surfing Dog")).toEqual(["surfing dog"]);
    expect(customerWordsIn("Your receipt is on the network")).toEqual(["network", "receipt"]);
    expect(customerWordsIn("Keep this pass and your KEY")).toEqual(["pass", "key"]);
    expect(customerWordsIn("Reply to this inbox")).toEqual(["inbox"]);
    // Words that only contain them are someone else's.
    expect(customerWordsIn("Bring your passport; the turkey is a keynote at the passage")).toEqual([]);
  });

  it("checks each language's words, and English in every language", () => {
    expect(customerWordsIn("Su recibo y su clave", "es")).toEqual(["recibo", "clave"]);
    expect(customerWordsIn("Votre réputation sur le réseau", "fr-CA")).toEqual(["réseau", "réputation"]);
    expect(customerWordsIn("Ihr Schlüssel im Netzwerk", "de")).toEqual(["netzwerk", "schlüssel"]);
    expect(customerWordsIn("La tua ricevuta nella rete", "it")).toEqual(["rete", "ricevuta"]);
    expect(customerWordsIn("O seu recibo na rede", "pt-BR")).toEqual(["rede", "recibo"]);
    expect(customerWordsIn("Votre reçu: nous avons reçu votre demande", "fr")).toEqual([]);
    expect(customerWordsIn("Ihre Buchung im inbox", "de")).toEqual(["inbox"]);
  });

  it("says which string holds what, for a track's templates", () => {
    expect(
      customerCopyProblems({ confirmed: "You're booked.", footer: "Sent by the inbox", pay: "Pay the deposit" }),
    ).toEqual(['footer: "inbox"']);
    expect(customerCopyProblems(["Hasta pronto", "Su pase"], "es")).toEqual(['1: "pase"']);
  });
});
