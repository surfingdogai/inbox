import type { LineOption, Portion } from "@surfingdog/spec";
import type { FieldProblem } from "../write/errors";
import type { MenuFields, OptionGroup } from "./schema";

/**
 * A line's options against the business's menu (ADR-040): each choice by its group, a half only where
 * the group takes halves, every group the line shows within its min and max, a group opened by a choice
 * only once that choice is taken (one level), and the defaults taken for a group the agent left out.
 * What each choice adds is the business's, never the agent's: the line's unit price is the item's plus
 * them.
 */
export interface PricedOptions {
  /** The options as the order keeps them, each with the business's name and what it adds per unit. */
  readonly options: LineOption[];
  /** What they add to the unit price, in minor units. */
  readonly unitDelta: number;
  readonly problems: FieldProblem[];
}

interface Sent {
  readonly groupId: string;
  readonly choiceId: string;
  readonly portion?: Portion | undefined;
}

export function priceOptions(
  menu: MenuFields,
  sent: readonly Sent[] | undefined,
  currency: string,
  path: string,
): PricedOptions {
  const problems: FieldProblem[] = [];
  const groups = new Map(menu.optionGroups.map((g) => [g.id, g]));
  const chosen: { group: OptionGroup; choiceId: string; portion: Portion }[] = [];
  const seen = new Set<string>();
  (sent ?? []).forEach((o, i) => {
    const at = `${path}.options.${i}`;
    const group = groups.get(o.groupId);
    if (!group) {
      problems.push({ path: `${at}.groupId`, problem: "invalid", message: "not an option group of this item" });
      return;
    }
    const choice = group.choices.find((c) => c.id === o.choiceId);
    if (!choice) {
      problems.push({ path: `${at}.choiceId`, problem: "invalid", message: `not a choice of ${group.name}` });
      return;
    }
    const portion: Portion = o.portion ?? "whole";
    if (portion !== "whole" && !group.halves) {
      problems.push({ path: `${at}.portion`, problem: "invalid", message: `${group.name} is not made in halves` });
      return;
    }
    const key = `${group.id}\u0000${choice.id}\u0000${portion}`;
    if (seen.has(key)) {
      problems.push({ path: at, problem: "invalid", message: `${choice.name} is chosen twice` });
      return;
    }
    seen.add(key);
    chosen.push({ group, choiceId: choice.id, portion });
  });

  // Which groups the line shows: every group no choice opens, and the ones a chosen choice opens.
  const opener = new Map<string, { group: string; choice: string }>();
  for (const g of menu.optionGroups) {
    for (const c of g.choices) if (c.opens) opener.set(c.opens, { group: g.id, choice: c.id });
  }
  const shows = (g: OptionGroup) => {
    const by = opener.get(g.id);
    return !by || chosen.some((c) => c.group.id === by.group && c.choiceId === by.choice);
  };
  for (const c of chosen) {
    if (!shows(c.group)) {
      problems.push({
        path: `${path}.options`,
        problem: "invalid",
        message: `${c.group.name} comes only with the choice that opens it`,
      });
    }
  }
  // A group the agent left out takes its defaults, when it has them.
  for (const g of menu.optionGroups) {
    if (!shows(g) || chosen.some((c) => c.group.id === g.id)) continue;
    for (const d of g.choices.filter((c) => c.default)) chosen.push({ group: g, choiceId: d.id, portion: "whole" });
  }
  for (const g of menu.optionGroups) {
    if (!shows(g)) continue;
    const n = chosen.filter((c) => c.group.id === g.id).length;
    if (n < g.min) {
      problems.push({
        path: `${path}.options`,
        problem: "missing",
        message: `choose ${g.min === g.max ? g.min : `at least ${g.min}`} of ${g.name}`,
      });
    } else if (n > g.max) {
      problems.push({ path: `${path}.options`, problem: "invalid", message: `at most ${g.max} of ${g.name}` });
    }
  }

  let unitDelta = 0;
  const options: LineOption[] = [];
  // In the menu's order, so the same choices always read the same way and fingerprint the same.
  for (const g of menu.optionGroups) {
    for (const c of g.choices) {
      for (const portion of ["whole", "left", "right"] as const) {
        if (!chosen.some((x) => x.group.id === g.id && x.choiceId === c.id && x.portion === portion)) continue;
        const delta = portion === "whole" ? (c.priceDelta ?? 0) : (c.halfDelta ?? c.priceDelta ?? 0);
        unitDelta += delta;
        options.push({
          groupId: g.id,
          choiceId: c.id,
          ...(portion !== "whole" ? { portion } : {}),
          name: c.name,
          ...(delta > 0 ? { priceDelta: { value: delta, currency } } : {}),
        });
      }
    }
  }
  return { options, unitDelta, problems };
}

/** The allergens a line brings: the dish's own and its chosen choices'. */
export function lineAllergens(
  menu: MenuFields,
  options: readonly Pick<LineOption, "groupId" | "choiceId">[],
): { contains: string[]; mayContain: string[] } {
  const contains = new Set(menu.allergens.contains);
  const may = new Set(menu.allergens.mayContain);
  for (const o of options) {
    const c = menu.optionGroups.find((g) => g.id === o.groupId)?.choices.find((x) => x.id === o.choiceId);
    for (const a of c?.allergens?.contains ?? []) contains.add(a);
    for (const a of c?.allergens?.mayContain ?? []) may.add(a);
  }
  return { contains: [...contains], mayContain: [...may].filter((a) => !contains.has(a)) };
}

/** A line's options in words, for a summary or the kitchen: "Large, Crispy, ½ Pepperoni". */
export function optionWords(options: readonly LineOption[] | undefined): string {
  return (options ?? [])
    .map((o) => `${o.portion === "left" ? "½ " : o.portion === "right" ? "½ " : ""}${o.name ?? o.choiceId}`)
    .join(", ");
}
