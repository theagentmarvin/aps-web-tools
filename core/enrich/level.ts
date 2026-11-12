/**
 * Level-name normalization (engine review P1): models of one project name the
 * same storey differently ("Level 1" in an English Revit ELE model, "Nivel 1"
 * in ARQ, "N01", "Piso 1"). Grouping, titles and `sameLevel` need ONE name.
 *
 * Each raw name gets a key: numbered storeys -> `L:<n>` (basements negative),
 * roof names -> `ROOF`, anything else -> its normalized text. All raw names
 * sharing a key display as the most frequent raw name of that key in the
 * test (ties: Spanish wording first, then alphabetical), so the project keeps
 * its own vocabulary. An explicit project map (`.coordinator/project.yaml`
 * `levels:`) wins over everything. Elevation-based matching would be more
 * robust; it needs level elevations, which the Index rows do not carry.
 */
import { cmpStr, norm } from "../util/text";

const ROOF = /^(cubierta|techumbre|azotea|roof|roof level|nivel cubierta|nivel techumbre)$/;
const BASEMENT_WORD = /^(subterraneo|sotano|subsuelo|basement|nivel subterraneo|piso subterraneo)\s*-?\s*0*(\d+)$/;
const BASEMENT_CODE = /^(s|ss|b)\s*-?\s*0*(\d+)$/;
// A "-" before the number is a sign (Piso -2, N-1), never a separator.
const NUMBERED = /^(nivel|level|piso|planta|floor|lvl|niv|n|l|p)\s*(?:[_.]\s*)?(\+|-)?\s*0*(\d+)$/;
const ENGLISH = /^(level|floor|lvl|basement|roof|l\s*-?\d)/;

/** Canonical key of a raw level name, or undefined when missing. */
export function levelKey(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = norm(String(raw));
  if (!n) return undefined;
  if (ROOF.test(n)) return "ROOF";
  let m = BASEMENT_WORD.exec(n) ?? BASEMENT_CODE.exec(n);
  if (m) return `L:-${Number(m[2])}`;
  m = NUMBERED.exec(n);
  if (m) return `L:${m[2] === "-" ? "-" : ""}${Number(m[3])}`;
  return `T:${n}`;
}

export type LevelCanon = (raw: string | undefined) => string | undefined;

/**
 * Build the level canonicalizer for one test from every raw level name seen
 * (with repetitions: frequency decides the display name).
 */
export function buildLevelCanon(raws: Iterable<string | undefined>, overrides: Readonly<Record<string, string>> = {}): LevelCanon {
  const over = new Map(Object.entries(overrides).map(([k, v]) => [norm(k), v]));
  const byKey = new Map<string, Map<string, number>>();
  for (const r of raws) {
    if (r === undefined || r === null || r === "" || over.has(norm(r))) continue;
    const k = levelKey(r)!;
    let m = byKey.get(k);
    if (!m) byKey.set(k, (m = new Map()));
    const t = String(r).trim().replace(/\s+/g, " ");
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  const display = new Map<string, string>();
  for (const [k, m] of byKey) {
    const best = [...m.entries()].sort((x, y) =>
      y[1] - x[1] ||
      Number(ENGLISH.test(norm(x[0]))) - Number(ENGLISH.test(norm(y[0]))) ||
      cmpStr(x[0], y[0]))[0]![0];
    display.set(k, best);
  }
  return (raw) => {
    if (raw === undefined || raw === null || raw === "") return undefined;
    const o = over.get(norm(raw));
    if (o !== undefined) return o;
    const k = levelKey(raw)!;
    return display.get(k) ?? String(raw).trim();
  };
}
