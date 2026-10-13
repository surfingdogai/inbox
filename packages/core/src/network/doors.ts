import type { Statement } from "@surfingdog/platform";
import { type PingDoors, pingDoorsSchema } from "@surfingdog/spec";
import { z } from "zod";

/**
 * How agents got on at the business's own doors (network protocol §4.15): the `doors` block a
 * network adds to its answer to a signed ping, kept per network for the owner. It is read leniently:
 * a door, a count, an incident or a line that does not read is left out, and the rest is kept, so a
 * network that says a little more or a little differently never costs the owner the whole picture.
 */

const S = pingDoorsSchema.shape;
const doorSchema = S.doors.element;
const reportRowSchema = doorSchema.shape.reports.element;

function each<T>(list: unknown, schema: z.ZodType<T>, max: number): T[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, max).flatMap((x) => {
    const r = schema.safeParse(x);
    return r.success ? [r.data] : [];
  });
}

/** A network's `doors` block, read leniently; null when it has no day the counts run to. */
export function readPingDoors(value: unknown): PingDoors | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const asOf = S.as_of.safeParse(v.as_of);
  if (!asOf.success) return null;
  const doors = (Array.isArray(v.doors) ? v.doors : []).slice(0, 50).flatMap((d) => {
    if (typeof d !== "object" || d === null) return [];
    const door = d as Record<string, unknown>;
    const r = doorSchema.safeParse({
      ...door,
      checked: door.checked === undefined ? null : door.checked,
      reports: each(door.reports, reportRowSchema, 500),
      platforms: each(door.platforms, z.string().max(253), 50),
    });
    return r.success ? [r.data] : [];
  });
  return {
    as_of: asOf.data,
    doors,
    incidents: each(v.incidents, S.incidents.element, 50),
    trouble: each(v.trouble, S.trouble.element, 50),
    fixes: each(v.fixes, S.fixes.element, 50),
  };
}

/** A stored block, as `networkDoorsStatement` wrote it; null when there is none or it does not read. */
export function storedPingDoors(text: unknown): PingDoors | null {
  if (typeof text !== "string") return null;
  try {
    return readPingDoors(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Keeps the block a signed ping's answer carried, and when; a ping that carried none keeps the last. */
export function networkDoorsStatement(network: string, now: number, doors: PingDoors): Statement {
  return {
    sql: "UPDATE network_status SET doors = ?, doors_at = ? WHERE network = ?",
    params: [JSON.stringify(doors), now, network],
    method: "run",
  };
}
