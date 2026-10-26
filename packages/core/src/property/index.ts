/**
 * A place to stay's own system (ADR-033 §4.5, §8): the availability cache, its polls and credit budget,
 * calendar links as night hints, and stays written to the system first.
 */
export { type AriCell, ariCells, ariCovers, ariStatements, ariVerdict, cachedNights, staleStatement } from "./ari";
export { hintedNights, mapCalendar, type NightHint } from "./hints";
export {
  ARI_LONG_MS,
  ARI_SHORT_MS,
  ariSyncHandler,
  CREDIT_RESERVE,
  ensureAriSync,
  mayPoll,
  STAY_ARI_SYNC_KIND,
  syncAri,
} from "./sync";
export { outboundOf, registerStayResolver, runStayWrite, stayKey, stayWriteHandler } from "./write";
