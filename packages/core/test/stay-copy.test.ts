import { LODGING_VOCABULARY } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import { customerCopyProblems } from "../src/i18n/customer-words";
import { STAY_COPY, STAY_LANGS, sampleStayStrings } from "../src/stays/copy";
import { extraWordsOf, renderStayMail } from "../src/stays/mail";
import { samplePageStrings } from "../src/stays/page";
import { sampleProblemStrings } from "../src/stays/problems";
import { transitionItem } from "../src/write/index";
import { clock, contact, guest, owner, ryokanHoshi } from "./stay-fixtures";

/**
 * What a guest reads, in each of the six languages (ADR-037 §10, §12): never a word of ours — not
 * "Surfing Dog", "network", "receipt", "pass", "key", "reputation" or "inbox" — in any template, page,
 * problem or email; every template in every language; and extras that are on-property items only, so a
 * stay never bundles another trader's travel service.
 */
describe("the stays copy", () => {
  it("has every template in all six languages", () => {
    const shape = (o: unknown): string[] =>
      o && typeof o === "object"
        ? Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? shape(v).map((s) => `${k}.${s}`) : [k]))
        : [];
    const en = shape(STAY_COPY.en).sort();
    for (const lang of STAY_LANGS) expect(shape(STAY_COPY[lang]).sort(), lang).toEqual(en);
  });

  for (const lang of STAY_LANGS) {
    it(`never names us to a guest, in ${lang}`, () => {
      expect(customerCopyProblems(sampleStayStrings(lang), lang)).toEqual([]);
      expect(customerCopyProblems(sampleProblemStrings(lang), lang)).toEqual([]);
      expect(customerCopyProblems(samplePageStrings(lang), lang)).toEqual([]);
      expect(customerCopyProblems(extraWordsOf(lang), lang)).toEqual([]);
    });
  }

  it("never names us in a rendered email either, in any language", async () => {
    clock.now = Date.parse("2026-11-02T01:00:00Z");
    const r = await ryokanHoshi();
    const made = await r.caps.stays.request(guest(), {
      check_in: "2026-12-12",
      check_out: "2026-12-15",
      rooms: [{ room_type_id: r.rooms.japanese, adults: 2 }],
      contact,
      consent: true,
    });
    const quoted = await transitionItem(r.db, owner, {
      itemId: made.view.item.id,
      event: "quote",
      input: { from: "rates" },
    });
    for (const lang of STAY_LANGS) {
      for (const event of ["create", "quote", "stay_before", "stay_arrival", "stay_thanks"]) {
        const mail = await renderStayMail(r.db, {
          item: quoted.view.item,
          event,
          lang,
          words: null,
          automated: true,
          replies: true,
          links: null,
          pay: [],
          fromState: null,
          now: clock.now,
        });
        if (!mail) continue;
        expect(customerCopyProblems({ subject: mail.subject, text: mail.text }, lang), `${lang} ${event}`).toEqual([]);
      }
    }
  });

  it("offers on-property extras only: no transfer, tour or car hire", () => {
    const travel =
      /transfer|shuttle|taxi|tour|excursion|car|rental|flight|train|ticket|traslado|navette|ausflug|noleggio|passeio/i;
    for (const [token, labels] of Object.entries(LODGING_VOCABULARY.extras)) {
      expect(token).not.toMatch(travel);
      for (const label of Object.values(labels)) expect(label, token).not.toMatch(travel);
    }
  });
});
