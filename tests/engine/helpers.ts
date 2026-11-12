import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { ElementProps, ModelDocument, NormalizedClash } from "../../core/types";
import { loadRuleSet, type CompiledRuleSet, type RuleSources } from "../../core/rules/load";
import { loadRulesFromDisk } from "../../server/rules-loader";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let cached: CompiledRuleSet | undefined;
export function rules(): CompiledRuleSet {
  return (cached ??= loadRulesFromDisk());
}

/** Parsed rule sources (deep-cloned on each call) for mutation tests. */
export function sources(): { matrix: any; classification: any; scoring: any; holidays: any } {
  const read = (f: string) => YAML.parse(readFileSync(path.join(ROOT, "rules", f), "utf8"));
  return {
    matrix: read("discipline-matrix.yaml"),
    classification: read("classification-rules.yaml"),
    scoring: read("priority-scoring.yaml"),
    holidays: read("holidays-cl.yaml"),
  };
}

export function load(s: RuleSources): CompiledRuleSet {
  return loadRuleSet(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic project
// ─────────────────────────────────────────────────────────────────────────────

/** mulberry32 PRNG: deterministic. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function doc(id: number, displayName: string): ModelDocument {
  return {
    id,
    urn: `urn:doc:${id}`,
    viewableName: "{3D}",
    lineageUrn: `lin-${id}`,
    displayName,
    matchedModelSet: true,
    discipline: null,
    disciplineSource: "unassigned",
  };
}

export function clash(id: string | number, l: [number, number], r: [number, number], distanceMm: number, status: NormalizedClash["status"] = "active"): NormalizedClash {
  return {
    id: String(id),
    left: { documentId: l[0], objectId: l[1], viewerDbId: l[1] },
    right: { documentId: r[0], objectId: r[1], viewerDbId: r[1] },
    distanceMm,
    penetrationMm: Math.max(0, -distanceMm),
    kind: distanceMm < 0 ? "hard" : "clearance",
    rawDist: distanceMm / 1000,
    rawStatus: 1,
    status,
    instanceCount: 1,
  };
}

export function el(documentId: number, lmvId: number, props: Partial<ElementProps>): ElementProps {
  return { documentId, lmvId, externalId: `${documentId}-${lmvId}`, raw: {}, ...props };
}

export interface Project {
  documents: ModelDocument[];
  elements: ElementProps[];
  clashes: NormalizedClash[];
}

const DOCS: Array<[number, string]> = [
  [1, "P2401-SLF-ZZ-ZZ-M3-S-0001.rvt"],
  [2, "P2401_ARQ_TorreA.rvt"],
  [3, "P2401-SAN-TorreA.rvt"],
  [4, "P2401-CLI.rvt"],
  [6, "P2401-ELE.rvt"],
  [7, "P2401-INC.rvt"],
];

type Tpl = (i: number, rnd: () => number, level: string) => Partial<ElementProps>;
const TEMPLATES: Record<number, Tpl[]> = {
  1: [
    (_i, _r, level) => ({ category: "Revit Structural Framing", family: "Viga HA Rectangular", type: "V 25x60", level, widthMm: 250, heightMm: 600 }),
    (_i, _r, level) => ({ category: "Revit Floors", family: "Suelo", type: "Losa HA e=15", level, thicknessMm: 150 }),
    (_i, _r, level) => ({ category: "Revit Pilares estructurales", family: "Pilar HA", type: "P 50x50", level, widthMm: 500, heightMm: 500 }),
    (_i, _r, level) => ({ category: "Revit Muros", family: "Muro básico", type: "M HA e=20", level, widthMm: 200 }),
  ],
  2: [
    (_i, _r, level) => ({ category: "Revit Muros", family: "Muro básico", type: "Tabique volcometal 95", level, widthMm: 95 }),
    (_i, _r, level) => ({ category: "Revit Techos", family: "Cielo modular", type: "Cielo americano 60x60", level, thicknessMm: 15 }),
    (_i, _r, level) => ({ category: "Revit Puertas", family: "Puerta simple", type: "P1 90x210", level }),
    (_i, _r, level) => ({ category: "Revit Modelos genéricos", family: "Caja metálica", type: "Tipo 1", level }),
  ],
  3: [
    (i, _r, level) => ({ category: "Revit Tuberías", family: "Tubería PVC", type: "PVC Sanitario", level, systemClassification: "Sanitario", systemType: "ALC", systemName: `ALC ${i % 7}`, diameterMm: 110 }),
    (i, _r, level) => ({ category: "Revit Tuberías", family: "Tubería PPR", type: "PPR PN20", level, systemClassification: "Domestic Cold Water", systemType: "APF", systemName: `APF ${i % 5}`, diameterMm: 25 }),
  ],
  4: [
    (i, r, level) => ({ category: "Revit Ducts", family: "Ducto rectangular", type: "Galvanizado", level, systemClassification: "Supply Air", systemName: `INY-${i % 9}`, widthMm: r() < 0.3 ? 600 : 300, heightMm: 300 }),
    (i, _r, level) => ({ category: "Revit Pipe Insulation", family: "Aislamiento", type: "Elastomérico 25", level, systemName: `AH ${i % 4}`, insulationThicknessMm: 25 }),
    (i, _r, level) => ({ category: "Revit Pipes", family: "Tubería acero", type: "SCH40", level, systemClassification: "Hydronic Supply", systemName: `AH ${i % 4}`, diameterMm: 80 }),
  ],
  6: [
    (_i, _r, level) => ({ category: "Revit Cable Tray", family: "Escalerilla portaconductores", type: "300x100", level, widthMm: 300, heightMm: 100 }),
    (_i, r, level) => ({ category: "Revit Conduits", family: "Tubo conduit", type: "PVC", level, diameterMm: r() < 0.5 ? 20 : 63 }),
    (_i, _r, level) => ({ category: "Revit Luminarias", family: "Panel LED", type: "40W", level }),
  ],
  7: [
    (_i, _r, level) => ({ category: "Revit Rociadores", family: "Rociador colgante", type: "K5.6", level, systemClassification: "Fire Protection Wet", systemName: "RCI" }),
    (_i, _r, level) => ({ category: "Revit Tuberías", family: "Tubería acero", type: "Ranurado", level, systemClassification: "Fire Protection Wet", systemName: "RH", diameterMm: 100 }),
  ],
};

/**
 * Deterministic synthetic project: `n` clashes over ~n/4 elements, with ~5 %
 * duplicate reports (same pair, new clash id) and a few same-file pairs.
 */
export function syntheticProject(n: number, seed = 42): Project {
  const rnd = prng(seed);
  const documents = DOCS.map(([id, name]) => doc(id, name));
  const elements: ElementProps[] = [];
  const pool: Array<[number, number]> = [];
  const perDoc = Math.max(20, Math.ceil(n / 4 / DOCS.length));
  for (const [d] of DOCS) {
    const tpls = TEMPLATES[d]!;
    for (let i = 1; i <= perDoc; i++) {
      const level = `Piso ${1 + Math.floor(rnd() * 12)}`;
      const t = tpls[i % tpls.length]!;
      elements.push(el(d, i, t(i, rnd, level)));
      pool.push([d, i]);
    }
  }
  const clashes: NormalizedClash[] = [];
  let id = 1000;
  while (clashes.length < n) {
    if (clashes.length > 10 && rnd() < 0.05) {
      const src = clashes[Math.floor(rnd() * clashes.length)]!;
      clashes.push(clash(id++, [src.left.documentId, src.left.objectId], [src.right.documentId, src.right.objectId], src.distanceMm - Math.round(rnd() * 5)));
      continue;
    }
    const a = pool[Math.floor(rnd() * pool.length)]!;
    let b = pool[Math.floor(rnd() * pool.length)]!;
    if (a[0] === b[0] && a[1] === b[1]) b = pool[(pool.indexOf(a) + 1) % pool.length]!;
    const dist = -Math.round(rnd() * 400);
    clashes.push(clash(id++, a, b, dist));
  }
  return { documents, elements, clashes };
}

/** Fisher–Yates shuffle with a seed (returns a copy). */
export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const rnd = prng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
