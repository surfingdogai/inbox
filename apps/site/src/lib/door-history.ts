/**
 * A door's history (ADR-020), as the site describes it. The network keeps a line a day of what its own reads found at
 * each door, and works out, for a door it reads every day, the share of days every check answered; it shows that share
 * only once it is switched on there (ADR-020 §5). While DOOR_SHARE_SHOWN is false the site says only what listings and
 * results show today: the days each door was seen answering. Switching it on is this constant, in the same release as
 * the network's own switch, and nothing else: every line below that depends on it has its words for both states.
 */
export const DOOR_SHARE_SHOWN = false;

/** /network's door history panel: what listings and results show. */
export function doorHistoryShows(shareShown: boolean): string {
  return shareShown
    ? "Listings and check results show the days each door was seen answering and, for a door read every day, from 14 " +
        "days checked, the share of days every check answered, rounded down: 199 of 200 is 99%. A day with a failed " +
        "or refused check is never an answered one."
    : "Listings and check results show the days each door was seen answering.";
}

/** The privacy page's line of what is public of a door's history. */
export function doorHistoryPublic(shareShown: boolean): string {
  return shareShown
    ? "The days a door was seen answering, and for doors we read every day the share of days every check answered, " +
        "are public with the business's listing and result."
    : "The days a door was seen answering are public with the business's listing and result.";
}
