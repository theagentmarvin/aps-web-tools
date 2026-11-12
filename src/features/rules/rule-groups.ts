/**
 * Reglas › grouping of the active rules by discipline pair (pure, unit-tested).
 * Hygiene / duplicates first, then the pairs in file order (= precedence), "General" last.
 */
import type { RuleRow } from "~/lib/api/types";

export const GROUP_HYGIENE = "HYG";
export const GROUP_GENERAL = "GEN";

type PairRow = Pick<RuleRow, "section" | "sides" | "fallback">;

/** "EST×MEP", "MEP×*" (any), "HYG" (hygiene / duplicates) or "GEN" (general / fallback). */
export function pairKeyOf(r: PairRow): string {
  if (r.section === "HYG" || r.section === "DUP") return GROUP_HYGIENE;
  if (r.fallback) return GROUP_GENERAL;
  const [a, b] = r.sides;
  if (!a && !b) return GROUP_GENERAL;
  const sides = [a ?? "*", b ?? "*"].sort((x, y) => (x === "*" ? 1 : y === "*" ? -1 : x.localeCompare(y)));
  return sides.join("×");
}

export interface RuleGroup<T> {
  key: string;
  rows: T[];
}

export function groupRulesByPair<T extends PairRow>(rows: T[]): Array<RuleGroup<T>> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const k = pairKeyOf(r);
    const list = map.get(k) ?? [];
    list.push(r);
    map.set(k, list);
  }
  const keys = [...map.keys()];
  const rank = (k: string) => (k === GROUP_HYGIENE ? -1 : k === GROUP_GENERAL ? 1 : 0);
  keys.sort((x, y) => rank(x) - rank(y));
  return keys.map((key) => ({ key, rows: map.get(key)! }));
}

/** Tokens of a pair key ("EST×MEP" → ["EST", "MEP"]); [] for HYG / GEN. */
export function pairTokens(key: string): string[] {
  return key === GROUP_HYGIENE || key === GROUP_GENERAL ? [] : key.split("×");
}

/** Accuracy flag: null = sin datos (n below the minimum). */
export function accuracyTone(a: RuleRow["accuracy"]): "none" | "low" | "ok" {
  if (a.rate === null) return "none";
  return a.rate < 0.7 ? "low" : "ok";
}
