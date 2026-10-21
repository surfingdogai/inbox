import type { RuleDefinition } from "../schema";

/** One rule of a preset: its name as the owner reads it, its priority and its definition. */
export type Preset = {
  name: string;
  priority: number;
  definition: RuleDefinition;
  /** Off until the owner switches it on (a stays preset's "accept date changes", R5). On when absent. */
  enabled?: boolean;
};

/**
 * A kind of business's starting rules (ADR-032): one file per key in this folder, and one line in
 * `index.ts`. A record only ever speeds things up or asks a person (R25): nothing here refuses anybody.
 */
export interface PresetSpec<K extends string = string> {
  readonly key: K;
  /** As the owner app and the plan's sentences name it. */
  readonly name: string;
  readonly rules: readonly Preset[];
}

/**
 * Every vertical (ADR-017 §8.3): a customer who gives the email of one the business knows, and
 * nothing that proves it, and asks to cancel, change or see earlier items, is offered a one-time
 * code first — never refused, and never shown someone else's history.
 */
export const OFFER_A_CODE: Preset = {
  name: "Offer a code to a possible known customer asking about earlier items",
  priority: 60,
  definition: {
    on: ["item.created", "thread.inbound"],
    if: {
      all: [
        { path: "customer.match", op: "eq", value: "weak" },
        {
          fn: "text_has_keywords",
          args: {
            keywords: ["cancel", "change", "reschedule", "move my", "earlier", "previous", "past order", "history"],
          },
        },
      ],
    },
    actions: [
      // Emailed to the customer, so the business speaks and names no tool: an assistant learns how
      // to ask for the code from `identity.verify` in its own answer.
      {
        action: "reply",
        template:
          "We may know you already. To see, change or cancel an earlier booking or order, confirm it is you: ask for the one-time code we email to the address we have for you, then send it back.",
        internal: false,
      },
      { action: "set_flags", needsHuman: true },
    ],
    stop: false,
    maxRunsPerItem: 1,
  },
};

/** A booking that is a request again: the customer sent the details asked for, or picked another time. */
export const BACK_TO_US = ["item.transitioned:provide_info", "item.transitioned:counter"];

/**
 * The code offer's reply as the business's customers read it: in the business's first language
 * (the rule is saved with its words, so it is chosen when the preset is applied), and listening for
 * the words its customers would use.
 */
export const OFFER_A_CODE_PT: Preset = {
  ...OFFER_A_CODE,
  definition: {
    ...OFFER_A_CODE.definition,
    if: {
      all: [
        { path: "customer.match", op: "eq", value: "weak" },
        {
          fn: "text_has_keywords",
          args: {
            keywords: [
              "cancel",
              "change",
              "reschedule",
              "move my",
              "earlier",
              "previous",
              "past order",
              "history",
              "cancelar",
              "alterar",
              "mudar",
              "remarcar",
              "anterior",
              "histórico",
            ],
          },
        },
      ],
    },
    actions: [
      {
        action: "reply",
        template:
          "Talvez já o conheçamos. Para ver, alterar ou cancelar uma marcação ou encomenda anterior, confirme que é você: peça o código de uso único que enviamos para o email que temos registado e envie-nos esse código.",
        internal: false,
      },
      { action: "set_flags", needsHuman: true },
    ],
  },
};
