/**
 * A door's history (ADR-020), as the site describes it. The network keeps a line a day of what its own reads found at
 * each door, and works out, for a door it reads every day, the share of days every check answered. The founder decided
 * on 18 October 2026 to show that share publicly (ADR-020 §5), so DOOR_SHARE_SHOWN is true, in the same release as the
 * network's own switch. It stays a switch: were it false, the site would say only that listings and results show the
 * days each door was seen answering. Every line below that depends on it has its words for both states.
 */
export const DOOR_SHARE_SHOWN = true;

/** /network's door history panel: what listings and results show. */
export function doorHistoryShows(shareShown: boolean): string {
  return shareShown
    ? "Listings and check results show the days each door was seen answering and, for a door read every day, from 14 " +
        'days checked, the share of days every check answered, the count first: "answered 41 of 42 days (97%)". The ' +
        "share is rounded down, so 199 of 200 is 99%. A day with a failed or a refused check counts as a missed day, " +
        "and a refused one is shown as refused."
    : "Listings and check results show the days each door was seen answering.";
}

/** The privacy page's line of what is public of a door's history. */
export function doorHistoryPublic(shareShown: boolean): string {
  return shareShown
    ? "The days a door was seen answering, and for doors we read every day the share of days every check answered, " +
        "are public with the business's listing and result."
    : "The days a door was seen answering are public with the business's listing and result.";
}
