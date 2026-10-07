/**
 * The home page's example card: a fictional salon on a `.example` domain, as a check would show it. Its states are
 * case `homepage-example` of the spec's `vectors/score.json`, and its score and grade are what the published formula
 * gives for them (72, B); `apps/site/test/site.node.test.ts` holds the two together, so the card can never show a
 * number the rules would not.
 */
export type ExampleState = "yes" | "partial" | "no" | "na";

export const AGENT_EXAMPLE = {
  name: "A hair salon · example",
  domain: "salon.example",
  profile: "appointments",
  profileLabel: "Appointments",
  score: 72,
  grade: "B",
  checked: "2026-10-07",
  /** Every capability that applies to an appointments business, as the check read it. */
  states: {
    find: "yes",
    catalogue: "yes",
    availability: "yes",
    message: "yes",
    book: "yes",
    pay: "partial",
    change: "no",
    cancel: "yes",
    feedback: "no",
    policies: "no",
  } as Record<string, ExampleState>,
  /** The door each lead answer was found at. */
  doors: { message: "A2A", book: "MCP", cancel: "MCP" } as Record<string, string>,
} as const;

/** The five lead capabilities, in the order every result shows them. */
export const LEAD = [
  { id: "message", label: "Message" },
  { id: "book", label: "Book" },
  { id: "order", label: "Order" },
  { id: "cancel", label: "Cancel" },
  { id: "negotiate", label: "Negotiate" },
] as const;

/** A state as a result page words it. */
export function answerOf(state: ExampleState | undefined): "Yes" | "Partly" | "No" | "Not applicable" {
  if (state === "yes") return "Yes";
  if (state === "partial") return "Partly";
  if (state === "no") return "No";
  return "Not applicable";
}

/** The card's props, derived from the example: the five answers, then pay and change. */
export function exampleCard() {
  const e = AGENT_EXAMPLE;
  return {
    name: e.name,
    domain: e.domain,
    profileLabel: e.profileLabel,
    score: e.score,
    grade: e.grade,
    checked: e.checked,
    answers: LEAD.map((l) => ({
      label: l.label,
      answer: answerOf(e.states[l.id]),
      door: e.doors[l.id] ?? "",
      checked: e.states[l.id] === "yes" ? e.checked : "",
    })),
    extra: [
      { label: "Pay", answer: answerOf(e.states.pay) },
      { label: "Change a booking", answer: answerOf(e.states.change) },
    ],
  };
}
