import type { Statement } from "@surfingdog/platform";
import type { PingCatalogueAnswer } from "@surfingdog/spec";

/**
 * What a network lists of the business's products, as the `catalogue` block of its answer to a signed
 * ping says it (ADR-029, protocol §4.18): how many it lists, what it holds back and why, with a few by
 * name, and when it last checked. Kept on the network's `network_status` row for the owner alone: the
 * status line under "Your products on networks", and each held product's reason beside it. Read
 * leniently, as `doors.ts` and `carried.ts` read theirs: a reason that does not read is left out, and a
 * block without `listed` and `offers_live` is none.
 */

const MAX_HELD = 20;
const MAX_SAMPLE = 5;

const count = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) < 1e9 ? (x as number) : null);
const words = (x: unknown, max: number) => (typeof x === "string" && x.trim() !== "" ? x.trim().slice(0, max) : null);

export function readPingCatalogue(value: unknown): PingCatalogueAnswer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const live = count(v.offers_live);
  if (typeof v.listed !== "boolean" || live === null) return null;
  const held: PingCatalogueAnswer["held"][number][] = [];
  for (const h of Array.isArray(v.held) ? v.held.slice(0, MAX_HELD) : []) {
    if (typeof h !== "object" || h === null) continue;
    const r = h as Record<string, unknown>;
    const why = words(r.why, 200);
    const n = count(r.count);
    if (!why || !n) continue;
    const sample: { id: string; name: string }[] = [];
    for (const s of Array.isArray(r.sample) ? r.sample.slice(0, MAX_SAMPLE) : []) {
      const id = words((s as Record<string, unknown> | null)?.id, 64);
      const name = words((s as Record<string, unknown> | null)?.name, 150);
      if (id && name) sample.push({ id, name });
    }
    held.push({ why, count: n, sample });
  }
  const at = typeof v.checked_at === "string" && Number.isFinite(Date.parse(v.checked_at)) ? v.checked_at : null;
  return { listed: v.listed, offers_live: live, held, checked_at: at };
}

/** Keeps a signed ping's `catalogue` block; a ping whose answer carries none keeps the last. */
export function networkCatalogueAnswerStatement(network: string, now: number, answer: PingCatalogueAnswer): Statement {
  return {
    sql: "UPDATE network_status SET catalogue_count = ?, catalogue_held = ?, catalogue_at = ?, updated_at = ? WHERE network = ?",
    params: [
      answer.offers_live,
      JSON.stringify({ listed: answer.listed, held: answer.held, checked_at: answer.checked_at }),
      now,
      now,
      network,
    ],
    method: "run",
  };
}

/** A stored block, read as leniently as it was written. */
export function storedPingCatalogue(text: unknown, count: unknown): PingCatalogueAnswer | null {
  if (typeof text !== "string") return null;
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    return readPingCatalogue({ ...v, offers_live: count });
  } catch {
    return null;
  }
}
