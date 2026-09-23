import type { RuleDefinition } from "./schema";

type Preset = { name: string; priority: number; definition: RuleDefinition };

/**
 * Every vertical (ADR-017 §8.3): a customer who gives the email of one the business knows, and
 * nothing that proves it, and asks to cancel, change or see earlier items, is offered a one-time
 * code first — never refused, and never shown someone else's history.
 */
const OFFER_A_CODE: Preset = {
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
const BACK_TO_US = ["item.transitioned:provide_info", "item.transitioned:counter"];

/**
 * Per-vertical starting points. Amounts are in minor units. A record only ever speeds things up
 * or asks a person (R25): the caps below are ADR-017 §14's, and nothing here refuses anybody.
 */
export const PRESETS: Record<string, Preset[]> = {
  appointments: [
    {
      name: "Auto-confirm small bookings when the slot is free",
      priority: 100,
      definition: {
        // A request back with us after the customer sent the details or picked another time is a
        // request again (ADR-018 N14), and is judged as a new one would be.
        on: ["item.created", ...BACK_TO_US],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "booking" },
            { path: "item.flags.sandbox", op: "neq", value: true },
            {
              any: [
                { path: "item.payload.totalPrice.value", op: "lt", value: 5_000 },
                { path: "item.payload.totalPrice", op: "empty" },
              ],
            },
            { fn: "slot_is_free" },
            { fn: "within_business_hours" },
          ],
        },
        actions: [
          {
            action: "transition",
            event: "confirm",
            reason: "auto-confirmed: small booking, slot free, within opening hours",
          },
        ],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
    {
      name: "Ask a person about anything else",
      priority: 10,
      definition: {
        on: ["item.created"],
        if: { path: "item.state", op: "in", value: ["requested", "received", "open"] },
        actions: [{ action: "set_flags", needsHuman: true }],
        stop: false,
        maxRunsPerItem: 1,
      },
    },
    {
      name: "Confirm a customer you know, or a trusted one, at once",
      priority: 120,
      definition: {
        on: ["item.created", ...BACK_TO_US],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "booking" },
            { path: "item.flags.sandbox", op: "neq", value: true },
            { fn: "slot_is_free" },
            { fn: "within_business_hours" },
            {
              any: [
                {
                  all: [
                    { fn: "customer_known" },
                    { path: "customer.completed", op: "gte", value: 2 },
                    { path: "customer.no_shows", op: "eq", value: 0 },
                  ],
                },
                {
                  all: [
                    { fn: "person_trusted" },
                    { path: "customer.open_bookings", op: "lte", value: 2 },
                    {
                      any: [
                        { path: "item.payload.totalPrice.value", op: "lte", value: 20_000 },
                        { path: "item.payload.totalPrice", op: "empty" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        actions: [
          {
            action: "transition",
            event: "confirm",
            reason: "auto-confirmed: a customer you know or a trusted one, slot free, within opening hours",
          },
        ],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
    OFFER_A_CODE,
  ],
  trades: [
    {
      name: "Quotes always need a person",
      priority: 100,
      definition: {
        on: ["item.created"],
        if: { path: "item.type", op: "eq", value: "quote_request" },
        actions: [{ action: "set_flags", needsHuman: true, priority: 1 }],
        stop: false,
        maxRunsPerItem: 1,
      },
    },
    {
      name: "Urgent words raise priority",
      priority: 90,
      definition: {
        on: ["item.created", "thread.inbound"],
        if: { fn: "text_has_keywords", args: { keywords: ["urgent", "emergency", "leak", "flood", "asap"] } },
        actions: [{ action: "set_flags", needsHuman: true, priority: 3 }],
        stop: false,
        maxRunsPerItem: 3,
      },
    },
    {
      name: "Trusted customers and customers you know go first",
      priority: 95,
      definition: {
        on: ["item.created"],
        if: { any: [{ fn: "person_trusted" }, { fn: "customer_known" }] },
        actions: [{ action: "set_flags", priority: 2 }],
        stop: false,
        maxRunsPerItem: 1,
      },
    },
    OFFER_A_CODE,
  ],
  shop: [
    {
      name: "Accept small orders and ask for payment, flag large ones",
      priority: 100,
      definition: {
        on: ["item.created"],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "order" },
            { path: "item.payload.totalPrice.value", op: "lte", value: 20_000 },
          ],
        },
        actions: [
          { action: "transition", event: "accept", reason: "auto-accepted: under the approval limit" },
          { action: "transition", event: "request_payment", reason: "a new customer pays as the shop's flow says" },
        ],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
    {
      name: "Large orders need approval",
      priority: 90,
      definition: {
        on: ["item.created"],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "order" },
            { path: "item.payload.totalPrice.value", op: "gt", value: 20_000 },
          ],
        },
        actions: [{ action: "set_flags", needsHuman: true, priority: 2 }],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
    {
      name: "Accept orders within a customer's limit at once",
      priority: 120,
      definition: {
        on: ["item.created"],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "order" },
            { path: "item.flags.sandbox", op: "neq", value: true },
            { fn: "within_customer_limit" },
          ],
        },
        actions: [
          {
            action: "transition",
            event: "accept",
            reason: "auto-accepted: within twice the customer's largest paid order, or a trusted customer's limit",
          },
        ],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
    OFFER_A_CODE,
  ],
};

/**
 * The code offer's reply as the business's customers read it: in the business's first language
 * (the rule is saved with its words, so it is chosen when the preset is applied), and listening for
 * the words its customers would use.
 */
const OFFER_A_CODE_PT: Preset = {
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

/** A vertical's rules, their words in the business's first language (`en` or `pt`). */
export function presetFor(key: string, lang: "en" | "pt"): Preset[] {
  const rules = PRESETS[key] ?? [];
  return lang === "pt" ? rules.map((r) => (r === OFFER_A_CODE ? OFFER_A_CODE_PT : r)) : rules;
}
