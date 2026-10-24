import { z } from "zod";
import type { RuleDefinition } from "../schema";
import { appointments } from "./appointments";
import { OFFER_A_CODE, OFFER_A_CODE_PT, type Preset, type PresetSpec } from "./common";
import { salon } from "./salon";
import { shop } from "./shop";
import { trades } from "./trades";

export type { Preset, PresetSpec } from "./common";

/**
 * Every kind of business's starting rules, one per file (ADR-032): a later track adds its preset with
 * one import and one entry here, and the key schema, the owner app's choice, the plan and the hosted
 * sign-up all follow from this list.
 */
export const PRESET_REGISTRY = [appointments, trades, shop, salon] as const satisfies readonly PresetSpec[];

export type PresetKey = (typeof PRESET_REGISTRY)[number]["key"];

/** The preset keys, in the registry's order. */
export const PRESET_KEYS = PRESET_REGISTRY.map((p) => p.key) as [PresetKey, ...PresetKey[]];

/** A preset key, as every door takes one. */
export const presetKeySchema = z.enum(PRESET_KEYS);

/** Each preset's name, as the owner app and the plan's sentences say it. */
export const PRESET_NAMES = Object.fromEntries(PRESET_REGISTRY.map((p) => [p.key, p.name])) as Record<
  PresetKey,
  string
>;

/** Per-vertical starting points, by key. */
export const PRESETS: Record<string, Preset[]> = Object.fromEntries(PRESET_REGISTRY.map((p) => [p.key, [...p.rules]]));

/**
 * Who says yes to a booking or an order: `rules`, the preset as it is, whose rules confirm a small
 * booking in a free slot and accept a small order on their own; or `owner`, the same preset without
 * those, so the owner confirms each booking and accepts each order. Asking a person, raising a
 * priority and offering a code stay either way.
 */
export type PresetConfirm = "owner" | "rules";

/** Whether a rule says yes on its own: it confirms a booking or accepts an order. */
export function saysYesOnItsOwn(definition: RuleDefinition): boolean {
  return definition.actions.some((a) => a.action === "transition" && (a.event === "confirm" || a.event === "accept"));
}

/** A vertical's rules, their words in the business's first language (`en` or `pt`). */
export function presetFor(key: string, lang: "en" | "pt", confirm: PresetConfirm = "rules"): Preset[] {
  const rules = (PRESETS[key] ?? []).filter((r) => confirm === "rules" || !saysYesOnItsOwn(r.definition));
  return lang === "pt" ? rules.map((r) => (r === OFFER_A_CODE ? OFFER_A_CODE_PT : r)) : rules;
}
