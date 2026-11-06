/**
 * Text helpers shared by the coordination engine. Pure, isomorphic.
 *
 * Normalization contract (rules/discipline-matrix.yaml, convention 1):
 * lowercase -> Unicode NFD -> strip combining marks -> trim -> collapse
 * internal whitespace to one space.
 */

const COMBINING = /[̀-ͯ]/g;
const WS = /\s+/g;

/** Normalize a string per the rules convention. */
export function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(COMBINING, "").trim().replace(WS, " ");
}

/** Normalize any scalar (non-strings are stringified first). Missing -> "". */
export function normAny(v: unknown): string {
  if (v === undefined || v === null) return "";
  return norm(typeof v === "string" ? v : String(v));
}

/** Missing per the DSL: undefined, null or empty string. */
export function isMissing(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/** Unordered pair as a canonical "x|y" string (lexicographic). */
export function sortedPair(a: string, b: string, sep = "|"): string {
  return a <= b ? `${a}${sep}${b}` : `${b}${sep}${a}`;
}

/** Strip control chars, collapse whitespace and truncate model-derived text. */
export function sanitize(s: unknown, max = 60): string {
  if (isMissing(s)) return "";
  // eslint-disable-next-line no-control-regex
  const t = String(s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(WS, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Capitalize the first letter (Spanish titles). */
export function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Stable string comparison for sort callbacks. */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Most frequent value; ties broken by the smallest string. */
export function dominant<T extends string>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestN = -1;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && best !== undefined && v < best)) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/** Distinct values sorted by frequency desc, then lexicographically. */
export function byFrequency(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((x, y) => y[1] - x[1] || cmpStr(x[0], y[0])).map(([v]) => v);
}
