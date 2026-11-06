/**
 * Deterministic generator for synthetic Model Coordination fixtures.
 *
 *   npx tsx scripts/generate-fixtures.ts
 *
 * Output: tests/fixtures/ (committed). Schemas follow
 * docs/research/aps-model-coordination-api.md §2 (model set version), §3.1–3.2
 * (tests, resources, clash / clash-instance / document files) and §4 (Index v2
 * fields + property rows). Everything is synthetic; no real project data.
 *
 * Scenario: 6 seed files (ARQ, EST, CLI, SAN, ELE, INC; Chilean names
 * `PRJ-<DISC>-MOD-001.rvt`) plus two false-positive traps:
 *   - a DUPLICATED LINKED MODEL: `PRJ-EST-MOD-001.rvt` uploaded again under a
 *     "Vinculados" folder (new lineage, same content, same externalIds);
 *   - the SAN seed exposes two 3D viewables ({3D} and "Coordinación"), both in
 *     the model set, which yields pipe-vs-its-own-insulation and
 *     element-vs-itself clashes.
 * => 8 clash documents. Two consecutive model set versions (41, 42) where CLI,
 * SAN and ELE got new seed versions (their viewer ids shift, stable ids don't).
 * `fixture-truth.json` holds the expected diff and the pattern of every clash.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");

// ── deterministic helpers ──────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261106);
const between = (lo: number, hi: number): number => lo + (hi - lo) * rnd();
const int = (lo: number, hi: number): number => Math.floor(between(lo, hi + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const round = (v: number, d = 4): number => Math.round(v * 10 ** d) / 10 ** d;
function shuffle<T>(xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
const hex = (n: number, w: number): string => n.toString(16).padStart(w, "0");
function uuid(tag: string): string {
  const h = fnv1a(tag) + fnv1a(`${tag}#2`) + fnv1a(`${tag}#3`) + fnv1a(`${tag}#4`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const urnId = (tag: string): string => Buffer.from(fnv1a(tag) + fnv1a(`${tag}!`)).toString("base64url").slice(0, 22);

// ── project / seeds ────────────────────────────────────────────────────────

const CONTAINER_ID = "3f8a2c1e-5b7d-4e90-a1c2-6d8e9f0a1b2c";
const MODEL_SET_ID = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

type SeedCode = "ARQ" | "EST" | "CLI" | "SAN" | "ELE" | "INC" | "ESTV";
interface Seed {
  code: SeedCode;
  idx: number;
  fileName: string;
  folder: string;
  lineageUrn: string;
  /** seed revision per model set version */
  rev: { 41: number; 42: number };
  viewables: string[];
  lang: "es" | "en";
}
const SEEDS: Seed[] = (
  [
    ["ARQ", "PRJ-ARQ-MOD-001.rvt", "Modelos/ARQ", { 41: 7, 42: 7 }, ["{3D}"], "es"],
    ["EST", "PRJ-EST-MOD-001.rvt", "Modelos/EST", { 41: 5, 42: 5 }, ["{3D}"], "es"],
    ["CLI", "PRJ-CLI-MOD-001.rvt", "Modelos/CLI", { 41: 3, 42: 4 }, ["{3D}"], "es"],
    ["SAN", "PRJ-SAN-MOD-001.rvt", "Modelos/SAN", { 41: 4, 42: 5 }, ["{3D}", "Coordinación"], "es"],
    ["ELE", "PRJ-ELE-MOD-001.rvt", "Modelos/ELE", { 41: 2, 42: 3 }, ["{3D}"], "en"],
    ["INC", "PRJ-INC-MOD-001.rvt", "Modelos/INC", { 41: 3, 42: 3 }, ["{3D}"], "es"],
    // Duplicated linked model: same file name and content, different folder/lineage.
    ["ESTV", "PRJ-EST-MOD-001.rvt", "Vinculados", { 41: 1, 42: 1 }, ["{3D}"], "es"],
  ] as const
).map(([code, fileName, folder, rev, viewables, lang], idx) => ({
  code,
  idx,
  fileName,
  folder,
  lineageUrn: `urn:adsk.wipprod:dm.lineage:${urnId(`lineage-${code}`)}`,
  rev: { ...rev },
  viewables: [...viewables],
  lang,
}));
const seedOf = (c: SeedCode): Seed => SEEDS.find((s) => s.code === c)!;
const versionUrn = (s: Seed, msv: 41 | 42): string => `urn:adsk.wipprod:fs.file:vf.${urnId(`file-${s.code}`)}?version=${s.rev[msv]}`;

/** Clash documents: one per (seed, viewable). Ids are stable across both versions here. */
interface DocDef {
  id: number;
  seed: Seed;
  viewableName: string;
}
const DOCS: DocDef[] = [];
for (const s of SEEDS) for (const v of s.viewables) DOCS.push({ id: DOCS.length, seed: s, viewableName: v });
const docOf = (c: SeedCode, viewable = "{3D}"): DocDef => DOCS.find((d) => d.seed.code === c && d.viewableName === viewable)!;

// ── elements ───────────────────────────────────────────────────────────────

type Val = string | number | boolean;
interface Element {
  seed: Seed;
  n: number;
  /** lmvId base; actual lmvId = base + rev * 3 (viewer ids shift between seed versions) */
  lmvBase: number;
  loid: number;
  externalId: string;
  elementId: number;
  /** [fieldCategory, fieldName, value, uom?] */
  props: Array<[string, string, Val, string?]>;
  rc: string;
  categoryEn: string;
  categoryId: number;
  family: string;
  type: string;
  bboxM: { min: [number, number, number]; max: [number, number, number] };
  deletedIn42?: boolean;
}
const ELEMENTS: Element[] = [];
const counters = new Map<SeedCode, number>();

const LEVELS: Array<[string, number]> = [
  ["Nivel -1", -3.2],
  ["Nivel 1", 0],
  ["Nivel 2", 3.6],
  ["Nivel 3", 7.2],
  ["Nivel 4", 10.8],
];
const LEVELS_EN: Record<string, string> = { "Nivel -1": "Level -1", "Nivel 1": "Level 1", "Nivel 2": "Level 2", "Nivel 3": "Level 3", "Nivel 4": "Level 4" };

interface ElSpec {
  rc: string;
  categoryEn: string;
  categoryId: number;
  family: string;
  type: string;
  props: Array<[string, string, Val, string?]>;
  bboxM: Element["bboxM"];
}

function addElement(code: SeedCode, spec: ElSpec): Element {
  const seed = seedOf(code);
  const n = (counters.get(code) ?? 0) + 1;
  counters.set(code, n);
  const elementId = 300000 + seed.idx * 20000 + n * 7;
  const e: Element = {
    seed,
    n,
    lmvBase: 1000 + n * 4,
    loid: 2_000_000 + seed.idx * 100_000 + n,
    externalId: `${uuid(`ext-${code}`)}-${hex(elementId, 8)}`,
    elementId,
    ...spec,
  };
  ELEMENTS.push(e);
  return e;
}

/** Copy of an EST element inside the duplicated linked model (same externalId and props). */
function duplicateInCopy(src: Element): Element {
  const seed = seedOf("ESTV");
  const n = (counters.get("ESTV") ?? 0) + 1;
  counters.set("ESTV", n);
  const e: Element = { ...src, seed, n, loid: 2_000_000 + seed.idx * 100_000 + n, lmvBase: src.lmvBase };
  ELEMENTS.push(e);
  return e;
}

function box(cx: number, cy: number, cz: number, dx: number, dy: number, dz: number): Element["bboxM"] {
  return {
    min: [round(cx - dx / 2), round(cy - dy / 2), round(cz - dz / 2)],
    max: [round(cx + dx / 2), round(cy + dy / 2), round(cz + dz / 2)],
  };
}
const randXY = (): [number, number] => [round(between(0, 48)), round(between(0, 30))];
const randLevel = (): [string, number] => pick(LEVELS.slice(0, 4));
const phase: [string, string, Val] = ["Fases", "Fase de creación", "Nueva construcción"];
const workset = (w: string): [string, string, Val] => ["Datos de identidad", "Subproyecto", w];

// Category specs (Revit es-ES names for _RC; English for the ELE model).
function duct(level: [string, number], x: number, y: number): Element {
  const [w, h] = pick([[600, 400], [800, 400], [400, 300], [1000, 500], [300, 250]] as const);
  const sys = pick([
    ["Aire de impulsión", "Impulsión"],
    ["Aire de retorno", "Retorno"],
    ["Aire de escape", "Extracción baños"],
  ] as const);
  return addElement("CLI", {
    rc: "Conductos",
    categoryEn: "Ducts",
    categoryId: -2008000,
    family: "Conducto rectangular",
    type: "Uniones por radio / Te",
    props: [
      ["Restricciones", "Nivel de referencia", level[0]],
      ["Mecánico", "Clasificación de sistema", sys[0]],
      ["Mecánico", "Tipo de sistema", sys[1]],
      ["Mecánico", "Nombre de sistema", `${sys[1].slice(0, 3).toUpperCase()}-${int(1, 12)}`],
      ["Cotas", "Anchura", w, "mm"],
      ["Cotas", "Altura", h, "mm"],
      ["Cotas", "Tamaño", `${w}x${h}`],
      ["Cotas", "Grosor de aislamiento", pick([0, 25, 38]), "mm"],
      workset("CLI-Conductos"),
      phase,
    ],
    bboxM: box(x, y, level[1] + 2.9, 6, w / 1000, h / 1000),
  });
}

function pipe(level: [string, number], x: number, y: number, vertical = false, sys?: readonly [string, string]): Element {
  const d = pick([50, 75, 110, 160]);
  const s =
    sys ??
    pick([
      ["Sanitario", "Aguas servidas"],
      ["Agua fría doméstica", "Agua potable fría"],
      ["Agua caliente doméstica", "Agua potable caliente"],
      ["Aguas lluvias", "Aguas lluvias"],
    ] as const);
  return addElement("SAN", {
    rc: "Tuberías",
    categoryEn: "Pipes",
    categoryId: -2008044,
    family: "Tubería",
    type: d >= 110 ? "PVC Sanitario" : "PPR PN20",
    props: [
      ["Restricciones", "Nivel de referencia", level[0]],
      ["Mecánico", "Clasificación de sistema", s[0]],
      ["Mecánico", "Tipo de sistema", s[1]],
      ["Mecánico", "Nombre de sistema", `${s[1].split(" ")[0].toUpperCase()}-${int(1, 9)}`],
      ["Cotas", "Diámetro", d, "mm"],
      ["Cotas", "Diámetro exterior", d + 2.2, "mm"],
      ["Cotas", "Tamaño", `${d} mmø`],
      workset("SAN-Redes"),
      phase,
    ],
    bboxM: vertical ? box(x, y, level[1] + 1.8, d / 1000, d / 1000, 3.6) : box(x, y, level[1] + 2.7, 5, d / 1000, d / 1000),
  });
}

function insulationOf(p: Element): Element {
  const t = pick([13, 19, 25]);
  const d = Number(p.props.find((q) => q[1] === "Diámetro")![2]);
  return addElement("SAN", {
    rc: "Aislamientos de tuberías",
    categoryEn: "Pipe Insulations",
    categoryId: -2008122,
    family: "Aislamiento de tubería",
    type: "Elastomérico",
    props: [
      ["Restricciones", "Nivel de referencia", String(p.props[0][2])],
      ["Mecánico", "Clasificación de sistema", String(p.props[1][2])],
      ["Mecánico", "Tipo de sistema", String(p.props[2][2])],
      ["Cotas", "Grosor de aislamiento", t, "mm"],
      ["Cotas", "Diámetro", d, "mm"],
      ["Datos de identidad", "Comentarios", `Aislamiento de ${p.elementId}`],
      workset("SAN-Redes"),
      phase,
    ],
    bboxM: p.bboxM,
  });
}

function sleeve(level: [string, number], x: number, y: number, d: number): Element {
  return addElement("SAN", {
    rc: "Accesorios de tuberías",
    categoryEn: "Pipe Accessories",
    categoryId: -2008055,
    family: "Pasada PVC",
    type: `Camisa Ø${d + 50}`,
    props: [
      ["Restricciones", "Nivel", level[0]],
      ["Cotas", "Diámetro", d + 50, "mm"],
      ["Datos de identidad", "Marca", `PAS-${int(100, 999)}`],
      ["Datos de identidad", "Comentarios", "Pasada en losa"],
      workset("SAN-Pasadas"),
      phase,
    ],
    bboxM: box(x, y, level[1], (d + 50) / 1000, (d + 50) / 1000, 0.25),
  });
}

function beam(level: [string, number], x: number, y: number): Element {
  const [b, h] = pick([[250, 600], [300, 700], [200, 500], [350, 800]] as const);
  return addElement("EST", {
    rc: "Armazón estructural",
    categoryEn: "Structural Framing",
    categoryId: -2001320,
    family: "Viga hormigón rectangular",
    type: `V${b}x${h}`,
    props: [
      ["Restricciones", "Nivel de referencia", level[0]],
      ["Cotas", "b", b, "mm"],
      ["Cotas", "h", h, "mm"],
      ["Materiales y acabados", "Material estructural", "Hormigón G30"],
      ["Estructural", "Uso estructural", "Viga"],
      workset("EST-Vigas"),
      phase,
    ],
    bboxM: box(x, y, level[1] + 3.6 - h / 2000, 7, b / 1000, h / 1000),
  });
}

function column(level: [string, number], x: number, y: number): Element {
  const s = pick([400, 500, 600]);
  return addElement("EST", {
    rc: "Pilares estructurales",
    categoryEn: "Structural Columns",
    categoryId: -2001330,
    family: "Pilar hormigón rectangular",
    type: `P${s}x${s}`,
    props: [
      ["Restricciones", "Restricción de base", level[0]],
      ["Cotas", "b", s, "mm"],
      ["Cotas", "h", s, "mm"],
      ["Materiales y acabados", "Material estructural", "Hormigón G35"],
      workset("EST-Pilares"),
      phase,
    ],
    bboxM: box(x, y, level[1] + 1.8, s / 1000, s / 1000, 3.6),
  });
}

function slab(level: [string, number], x: number, y: number): Element {
  const t = pick([150, 180, 200, 250]);
  return addElement("EST", {
    rc: "Suelos",
    categoryEn: "Floors",
    categoryId: -2000032,
    family: "Suelo",
    type: `Losa H.A. e=${t}`,
    props: [
      ["Restricciones", "Nivel", level[0]],
      ["Cotas", "Grosor", t, "mm"],
      ["Estructural", "Estructural", true],
      ["Materiales y acabados", "Material estructural", "Hormigón G30"],
      workset("EST-Losas"),
      phase,
    ],
    bboxM: box(x, y, level[1] - t / 2000, 8, 8, t / 1000),
  });
}

function wall(level: [string, number], x: number, y: number): Element {
  const t = pick([100, 140, 200]);
  return addElement("ARQ", {
    rc: "Muros",
    categoryEn: "Walls",
    categoryId: -2000011,
    family: "Muro básico",
    type: t === 100 ? "Tabique Volcometal 100" : `Albañilería e=${t}`,
    props: [
      ["Restricciones", "Restricción de base", level[0]],
      ["Cotas", "Anchura", t, "mm"],
      ["Datos de identidad", "Resistencia al fuego", pick(["F-60", "F-120", ""])],
      ["Estructural", "Estructural", false],
      workset("ARQ-Muros"),
      phase,
    ],
    bboxM: box(x, y, level[1] + 1.8, 6, t / 1000, 3.6),
  });
}

function ceiling(level: [string, number], x: number, y: number): Element {
  return addElement("ARQ", {
    rc: "Techos",
    categoryEn: "Ceilings",
    categoryId: -2000038,
    family: "Cielo compuesto",
    type: "Cielo americano 60x60",
    props: [
      ["Restricciones", "Nivel", level[0]],
      ["Cotas", "Grosor", 15, "mm"],
      workset("ARQ-Cielos"),
      phase,
    ],
    bboxM: box(x, y, level[1] + 2.6, 6, 6, 0.015),
  });
}

function sprinklerPipe(level: [string, number], x: number, y: number): Element {
  const d = pick([25, 32, 50, 65, 100]);
  return addElement("INC", {
    rc: "Tuberías",
    categoryEn: "Pipes",
    categoryId: -2008044,
    family: "Tubería",
    type: "Acero Sch40 ranurado",
    props: [
      ["Restricciones", "Nivel de referencia", level[0]],
      ["Mecánico", "Clasificación de sistema", "Protección contra incendios húmeda"],
      ["Mecánico", "Tipo de sistema", d >= 65 ? "Red húmeda" : "Rociadores"],
      ["Mecánico", "Nombre de sistema", `RH-${int(1, 4)}`],
      ["Cotas", "Diámetro", d, "mm"],
      ["Cotas", "Diámetro exterior", d + 8.4, "mm"],
      ["Cotas", "Tamaño", `${d} mmø`],
      workset("INC-Redes"),
      phase,
    ],
    bboxM: box(x, y, level[1] + 3.0, 5, d / 1000, d / 1000),
  });
}

function sprinkler(level: [string, number], x: number, y: number): Element {
  return addElement("INC", {
    rc: "Rociadores",
    categoryEn: "Sprinklers",
    categoryId: -2008099,
    family: "Rociador colgante",
    type: "K5.6 68°C",
    props: [
      ["Restricciones", "Nivel", level[0]],
      ["Mecánico", "Clasificación de sistema", "Protección contra incendios húmeda"],
      ["Mecánico", "Tipo de sistema", "Rociadores"],
      workset("INC-Rociadores"),
      phase,
    ],
    bboxM: box(x, y, level[1] + 2.6, 0.06, 0.06, 0.12),
  });
}

/** ELE model is authored in an English Revit: English parameter names, lengths in feet. */
function cableTray(level: [string, number], x: number, y: number): Element {
  const w = pick([200, 300, 400, 600]);
  return addElement("ELE", {
    rc: "Cable Trays",
    categoryEn: "Cable Tray",
    categoryId: -2008130,
    family: "Cable Tray with Fittings",
    type: "Ladder Cable Tray",
    props: [
      ["Constraints", "Reference Level", LEVELS_EN[level[0]]],
      ["Electrical", "Service Type", pick(["Fuerza", "Corrientes débiles", "Alumbrado"])],
      ["Dimensions", "Width", round(w / 304.8, 6), "ft"],
      ["Dimensions", "Height", round(100 / 304.8, 6), "ft"],
      ["Dimensions", "Size", `${w} mmx100 mm`],
      ["Identity Data", "Workset", "ELE-Bandejas"],
      ["Phasing", "Phase Created", "New Construction"],
    ],
    bboxM: box(x, y, level[1] + 3.1, 6, w / 1000, 0.1),
  });
}

function conduit(level: [string, number], x: number, y: number): Element {
  const d = pick([20, 25, 32]);
  return addElement("ELE", {
    rc: "Conduits",
    categoryEn: "Conduits",
    categoryId: -2008132,
    family: "Conduit with Fittings",
    type: "EMT",
    props: [
      ["Constraints", "Reference Level", LEVELS_EN[level[0]]],
      ["Dimensions", "Diameter", round(d / 304.8, 6), "ft"],
      ["Dimensions", "Outside Diameter", round((d + 3) / 304.8, 6), "ft"],
      ["Identity Data", "Comments", "Embutido en losa"],
      ["Identity Data", "Workset", "ELE-Canalizaciones"],
      ["Phasing", "Phase Created", "New Construction"],
    ],
    bboxM: box(x, y, level[1] - 0.08, 4, d / 1000, d / 1000),
  });
}

// ── clash patterns ─────────────────────────────────────────────────────────

type Pattern =
  | "real_duct_beam"
  | "real_pipe_beam"
  | "real_tray_duct"
  | "real_inc_pipe_duct"
  | "real_pipe_wall"
  | "real_pipe_slab_no_sleeve"
  | "tolerance_small"
  | "clearance_soft"
  | "fp_insulation_own_pipe"
  | "fp_same_element_dup_viewable"
  | "fp_duplicated_linked_model"
  | "by_design_pipe_slab_sleeve"
  | "by_design_sleeve_slab"
  | "sprinkler_ceiling"
  | "conduit_in_slab";

interface PoolEntry {
  pattern: Pattern;
  left: { el: Element; doc: DocDef };
  right: { el: Element; doc: DocDef };
  /** metres, negative = penetration */
  dist: number;
}
const POOL: PoolEntry[] = [];
const add = (pattern: Pattern, l: Element, ld: DocDef, r: Element, rd: DocDef, dist: number): void => {
  POOL.push({ pattern, left: { el: l, doc: ld }, right: { el: r, doc: rd }, dist: round(dist, 6) });
};
const pen = (lo: number, hi: number): number => -between(lo, hi);

const COUNTS: Array<[Pattern, number]> = [
  ["real_duct_beam", 60],
  ["real_pipe_beam", 45],
  ["real_tray_duct", 30],
  ["real_inc_pipe_duct", 25],
  ["real_pipe_wall", 30],
  ["real_pipe_slab_no_sleeve", 15],
  ["tolerance_small", 25],
  ["clearance_soft", 8],
  ["fp_insulation_own_pipe", 30],
  ["fp_same_element_dup_viewable", 8],
  ["fp_duplicated_linked_model", 40],
  ["by_design_pipe_slab_sleeve", 20],
  ["sprinkler_ceiling", 15],
  ["conduit_in_slab", 12],
];

for (const [pattern, count] of COUNTS) {
  for (let i = 0; i < count; i++) {
    const lv = randLevel();
    const [x, y] = randXY();
    switch (pattern) {
      case "real_duct_beam":
        add(pattern, duct(lv, x, y), docOf("CLI"), beam(lv, x, y), docOf("EST"), pen(0.03, 0.3));
        break;
      case "real_pipe_beam":
        add(pattern, pipe(lv, x, y), docOf("SAN"), beam(lv, x, y), docOf("EST"), pen(0.02, 0.16));
        break;
      case "real_tray_duct":
        add(pattern, cableTray(lv, x, y), docOf("ELE"), duct(lv, x, y), docOf("CLI"), pen(0.02, 0.1));
        break;
      case "real_inc_pipe_duct":
        add(pattern, sprinklerPipe(lv, x, y), docOf("INC"), duct(lv, x, y), docOf("CLI"), pen(0.02, 0.09));
        break;
      case "real_pipe_wall":
        add(pattern, wall(lv, x, y), docOf("ARQ"), pipe(lv, x, y), docOf("SAN"), pen(0.05, 0.2));
        break;
      case "real_pipe_slab_no_sleeve":
        add(pattern, pipe(lv, x, y, true), docOf("SAN"), slab(lv, x, y), docOf("EST"), pen(0.15, 0.25));
        break;
      case "tolerance_small":
        if (i % 2) add(pattern, pipe(lv, x, y), docOf("SAN"), duct(lv, x, y), docOf("CLI"), pen(0.0003, 0.004));
        else add(pattern, cableTray(lv, x, y), docOf("ELE"), sprinklerPipe(lv, x, y), docOf("INC"), pen(0.0003, 0.004));
        break;
      case "clearance_soft":
        add(pattern, duct(lv, x, y), docOf("CLI"), beam(lv, x, y), docOf("EST"), between(0.005, 0.05));
        break;
      case "fp_insulation_own_pipe": {
        const p = pipe(lv, x, y, false, ["Agua caliente doméstica", "Agua potable caliente"]);
        add(pattern, p, docOf("SAN"), insulationOf(p), docOf("SAN", "Coordinación"), pen(0.01, 0.03));
        break;
      }
      case "fp_same_element_dup_viewable": {
        const p = pipe(lv, x, y);
        add(pattern, p, docOf("SAN"), p, docOf("SAN", "Coordinación"), pen(0.05, 0.11));
        break;
      }
      case "fp_duplicated_linked_model": {
        const src = i % 2 ? beam(lv, x, y) : column(lv, x, y);
        const size = Number(src.props.find((q) => q[1] === "b")![2]) / 1000;
        add(pattern, src, docOf("EST"), duplicateInCopy(src), docOf("ESTV"), -size);
        break;
      }
      case "by_design_pipe_slab_sleeve": {
        const s = slab(lv, x, y);
        const p = pipe(lv, x, y, true, ["Sanitario", "Aguas servidas"]);
        const d = Number(p.props.find((q) => q[1] === "Diámetro")![2]);
        add("by_design_pipe_slab_sleeve", p, docOf("SAN"), s, docOf("EST"), pen(0.15, 0.25));
        add("by_design_sleeve_slab", sleeve(lv, x, y, d), docOf("SAN"), s, docOf("EST"), pen(0.15, 0.25));
        break;
      }
      case "sprinkler_ceiling":
        add(pattern, sprinkler(lv, x, y), docOf("INC"), ceiling(lv, x, y), docOf("ARQ"), pen(0.01, 0.06));
        break;
      case "conduit_in_slab":
        add(pattern, conduit(lv, x, y), docOf("ELE"), slab(lv, x, y), docOf("EST"), pen(0.02, 0.03));
        break;
      default:
        break;
    }
  }
}

// ── version assignment ────────────────────────────────────────────────────

const BASE_CLASH_ID = 41299469560661;
const clashIdOf = (i: number): number => BASE_CLASH_ID + i * 7919;
const ID_SHIFT = 1_000_000_000;

type Fate = "persisting" | "persisting_new_id" | "resolved" | "element_deleted" | "new" | "reappeared";
const order = shuffle(POOL.map((_, i) => i));
const fate = new Map<number, Fate>();
const deletable = new Set<Pattern>(["real_duct_beam", "real_pipe_beam", "real_pipe_wall"]);
let p = 0;
for (const i of order.slice(0, 220)) fate.set(i, p++ < 8 ? "persisting_new_id" : "persisting");
let deleted = 0;
for (const i of order.slice(220, 300)) {
  if (deleted < 15 && deletable.has(POOL[i].pattern)) {
    fate.set(i, "element_deleted");
    deleted++;
  } else fate.set(i, "resolved");
}
for (const i of order.slice(300, 370)) fate.set(i, "new");
for (const i of order.slice(370)) fate.set(i, "reappeared");
if (deleted !== 15) throw new Error(`only ${deleted} deletable entries`);

// Mark the MEP side (CLI/SAN) of element_deleted entries as deleted in v42.
for (const [i, f] of fate) {
  if (f !== "element_deleted") continue;
  const e = POOL[i];
  const mep = ["CLI", "SAN"].includes(e.left.el.seed.code) ? e.left.el : e.right.el;
  mep.deletedIn42 = true;
}

const inV41 = (f: Fate): boolean => f === "persisting" || f === "persisting_new_id" || f === "resolved" || f === "element_deleted";
const inV42 = (f: Fate): boolean => f === "persisting" || f === "persisting_new_id" || f === "new" || f === "reappeared";

// ── writers ────────────────────────────────────────────────────────────────

function write(rel: string, data: unknown, opts: { gzip?: boolean; ndjson?: boolean } = {}): void {
  const path = join(OUT, rel);
  mkdirSync(dirname(path), { recursive: true });
  const text = opts.ndjson
    ? (data as unknown[]).map((r) => JSON.stringify(r)).join("\n") + "\n"
    : JSON.stringify(data, null, rel.includes("scope-version") ? undefined : 2) + "\n";
  writeFileSync(path, text);
  if (opts.gzip) writeFileSync(`${path}.gz`, gzipSync(Buffer.from(text), { level: 9 }));
}

const lmvId = (e: Element, msv: 41 | 42): number => e.lmvBase + e.seed.rev[msv] * 3;

const createTime = (msv: 41 | 42): string => (msv === 41 ? "2026-10-28T13:05:11.000Z" : "2026-11-04T12:41:37.000Z");

function modelSetVersion(msv: 41 | 42): unknown {
  return {
    modelSetId: MODEL_SET_ID,
    version: msv,
    createTime: createTime(msv),
    status: "Successful",
    documentVersions: DOCS.map((d) => {
      const vUrn = versionUrn(d.seed, msv);
      return {
        stableDocumentId: `${d.seed.lineageUrn}#${d.viewableName}`,
        unstableDocumentId: `${vUrn}#${d.viewableName}`,
        documentLineage: {
          lineageUrn: d.seed.lineageUrn,
          parentFolderUrn: `urn:adsk.wipprod:fs.folder:co.${urnId(`folder-${d.seed.folder}`)}`,
          isAligned: false,
          tipVersionUrn: vUrn,
        },
        alignment: {
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          checksum: fnv1a(`align-${d.seed.code}`),
          upAxis: [0, 0, 1],
          distanceUnit: "autodesk.unit.unit:feet-1.0.1",
        },
        isTipVersion: true,
        documentStatus: "Succeeded",
        forgeType: "versions:autodesk.bim360:File",
        versionUrn: vUrn,
        displayName: d.seed.fileName,
        revision: d.seed.rev[msv],
        viewableName: d.viewableName,
        createUserId: "PD23PXGV8V3V",
        createTime: createTime(msv),
        viewableGuid: uuid(`viewable-${d.seed.code}-${d.viewableName}`),
        viewableId: uuid(`viewableId-${d.seed.code}-${d.viewableName}`),
        viewableMime: "application/autodesk-svf",
        bubbleUrn: vUrn,
        isSvf2Supported: false,
        originalSeedFileVersionSize: 40_000_000 + d.seed.idx * 3_000_000,
        originalSeedFileVersionUrn: vUrn,
        originalSeedFileVersionName: d.seed.fileName,
      };
    }),
  };
}

const testIdOf = (msv: 41 | 42): string => uuid(`test-${msv}`);

function clashFiles(msv: 41 | 42): void {
  const clashes: unknown[] = [];
  const instances: unknown[] = [];
  POOL.forEach((e, i) => {
    const f = fate.get(i)!;
    if (!(msv === 41 ? inV41(f) : inV42(f))) return;
    const id = msv === 42 && f === "persisting_new_id" ? clashIdOf(i) + ID_SHIFT : clashIdOf(i);
    // A few "reviewed" (2) in v42 and one string status, to exercise mapping (raw type UNVERIFIED).
    const status = msv === 42 && i % 37 === 0 ? 2 : msv === 42 && i % 101 === 0 ? "New" : 1;
    clashes.push({ id, clash: [e.left.el.loid, e.right.el.loid], dist: e.dist, status });
    instances.push({
      cid: id,
      ldid: e.left.doc.id,
      rdid: e.right.doc.id,
      loid: e.left.el.loid,
      roid: e.right.el.loid,
      lvid: lmvId(e.left.el, msv),
      rvid: lmvId(e.right.el, msv),
    });
  });
  const documents = DOCS.map((d) => ({ id: d.id, urn: versionUrn(d.seed, msv), viewableName: d.viewableName }));
  const dir = `mc/v${msv}`;
  write(`${dir}/scope-version-clash.json`, { scope: "scope-version-clash", version: 2, clashes }, { gzip: true });
  write(`${dir}/scope-version-clash-instance.json`, { scope: "scope-version-clash-instance", version: 2, instances }, { gzip: true });
  write(`${dir}/scope-version-document.json`, { scope: "scope-version-document", version: 2, documents }, { gzip: true });
  write(`${dir}/modelset-version.json`, modelSetVersion(msv));

  const testId = testIdOf(msv);
  const s3 = (type: string): string =>
    `https://bim360-mc-clash-prod-us-east-1.s3.us-east-1.amazonaws.com/${CONTAINER_ID}/${testId}/${type}.json.gz?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=SYNTHETIC&X-Amz-Expires=3600&X-Amz-Signature=${fnv1a(type + testId)}`;
  write(`${dir}/clash-test-resources.json`, {
    page: {},
    resources: ["scope-version-clash.2.0.0", "scope-version-clash-instance.2.0.0", "scope-version-document.2.0.0"]
      .map((type) => ({
        type,
        extension: "json.gz",
        url: s3(type),
        headers: { "x-amz-server-side-encryption-customer-algorithm": "AES256" } as Record<string, string>,
        validUntil: msv === 41 ? "2026-10-28T14:05:11.000Z" : "2026-11-04T13:41:37.000Z",
      }))
      .concat([
        {
          type: "scope-version-clash.2.0.0",
          extension: "sqlite",
          url: s3("clash-sqlite"),
          headers: {},
          validUntil: "2026-11-04T13:41:37.000Z",
        },
      ]),
  });
}

// ── Index v2 ──────────────────────────────────────────────────────────────

interface FieldDef {
  key: string;
  category: string;
  type: string;
  name: string;
  uom: string | null;
}
const FIELDS = new Map<string, FieldDef>();
function fieldKey(category: string, name: string, value: Val, uom?: string): string {
  const k = `p${fnv1a(`${category}/${name}`)}`;
  if (!FIELDS.has(k)) {
    const type = typeof value === "boolean" ? "Boolean" : typeof value === "number" ? (Number.isInteger(value) && !uom ? "Integer" : "Double") : "String";
    FIELDS.set(k, { key: k, category, type, name, uom: uom ?? null });
  }
  return k;
}

function indexRow(e: Element, msv: 41 | 42, viewIds: string[]): unknown {
  const props: Record<string, Val> = {};
  const put = (c: string, n: string, v: Val, uom?: string): void => {
    if (v === "") return;
    props[fieldKey(c, n, v, uom)] = v;
  };
  put("__name__", "name", `${e.family} [${e.elementId}]`);
  put("__category__", "Category", `Revit ${e.categoryEn}`);
  put("__categoryId__", "CategoryId", e.categoryId);
  put("__category__", "_RC", e.rc);
  put("__category__", "_RFN", e.family);
  put("__category__", "_RFT", e.type);
  for (const [c, n, v, uom] of e.props) put(c, n, v, uom);
  const ft = (v: number): number => round(v / 0.3048, 4);
  return {
    svf2Id: lmvId(e, msv) + 1,
    lineageId: fnv1a(e.seed.lineageUrn),
    externalId: e.externalId,
    lmvId: lmvId(e, msv),
    databaseId: fnv1a(`db-${e.seed.code}-${e.seed.rev[msv]}`),
    props,
    propsHash: fnv1a(JSON.stringify(props)),
    geomHash: fnv1a(JSON.stringify(e.bboxM)),
    bboxMin: { x: ft(e.bboxM.min[0]), y: ft(e.bboxM.min[1]), z: ft(e.bboxM.min[2]) },
    bboxMax: { x: ft(e.bboxM.max[0]), y: ft(e.bboxM.max[1]), z: ft(e.bboxM.max[2]) },
    views: viewIds,
  };
}

function indexFixtures(): Record<string, unknown> {
  const catalog: Record<string, unknown> = {};
  const done = new Set<string>();
  for (const msv of [41, 42] as const) {
    for (const seed of SEEDS) {
      const vUrn = versionUrn(seed, msv);
      if (done.has(vUrn)) continue;
      done.add(vUrn);
      const viewIds = seed.viewables.map((v) => fnv1a(`view-${seed.code}-${v}`));
      const rows = ELEMENTS.filter((e) => e.seed === seed && !(msv === 42 && e.deletedIn42 && seed.rev[41] !== seed.rev[42])).map(
        (e) => indexRow(e, msv, viewIds),
      );
      const file = `index/properties/${seed.code}-r${seed.rev[msv]}.ndjson`;
      write(file, rows, { ndjson: true, gzip: seed.code === "SAN" });
      const indexId = fnv1a(`index-${vUrn}`) + fnv1a(`index2-${vUrn}`);
      catalog[vUrn] = {
        indexId,
        seed: seed.code,
        file,
        rows: rows.length,
        views: seed.viewables.map((v) => ({ id: fnv1a(`view-${seed.code}-${v}`), viewableName: v, viewableGuid: uuid(`viewable-${seed.code}-${v}`), is3d: true })),
      };
    }
  }
  write("index/fields.ndjson", [...FIELDS.values()], { ndjson: true, gzip: true });
  return catalog;
}

// ── run ────────────────────────────────────────────────────────────────────

clashFiles(41);
clashFiles(42);
const indexCatalog = indexFixtures();

write("mc/clash-tests.json", {
  page: {},
  tests: [41, 42].map((msv) => ({
    id: testIdOf(msv as 41 | 42),
    modelSetId: MODEL_SET_ID,
    modelSetVersion: msv,
    status: "Success",
    completedOn: msv === 41 ? "2026-10-28T13:19:02.000Z" : "2026-11-04T12:58:45.000Z",
  })),
});
write("mc/modelset-views.json", {
  page: {},
  modelSetViews: [
    {
      viewId: uuid("view-est-mep"),
      name: "EST_MEP",
      description: "Estructura vs instalaciones",
      isPrivate: false,
      definition: (["EST", "CLI", "SAN", "ELE", "INC"] as const).map((c) => ({ lineageUrn: seedOf(c).lineageUrn, viewableName: "{3D}" })),
      createdBy: "PD23PXGV8V3V",
      createdTime: "2026-09-01T10:00:00.000Z",
    },
  ],
});

const idsFor = (msv: 41 | 42): number[] =>
  POOL.flatMap((_, i) => {
    const f = fate.get(i)!;
    if (!(msv === 41 ? inV41(f) : inV42(f))) return [];
    return [msv === 42 && f === "persisting_new_id" ? clashIdOf(i) + ID_SHIFT : clashIdOf(i)];
  }).sort((a, b) => a - b);

// v40 (older history): every reappeared id plus a sample of v41 ids.
const history = POOL.flatMap((_, i) => {
  const f = fate.get(i)!;
  return f === "reappeared" || (inV41(f) && i % 3 === 0) ? [String(clashIdOf(i))] : [];
}).sort();
write("mc/history-v40-clash-ids.json", history);

const byFate = (f: Fate[]): string[] =>
  POOL.flatMap((_, i) => (f.includes(fate.get(i)!) ? [String(fate.get(i) === "persisting_new_id" ? clashIdOf(i) + ID_SHIFT : clashIdOf(i))] : [])).sort(
    (a, b) => Number(a) - Number(b),
  );

write("fixture-truth.json", {
  note: "Synthetic data generated by scripts/generate-fixtures.ts. Diff expectations assume prev=v41, next=v42, history=mc/history-v40-clash-ids.json, pairKeys from index rows of each version, nextElementKeys = all externalIds in v42 index rows.",
  containerId: CONTAINER_ID,
  modelSetId: MODEL_SET_ID,
  tests: { 41: testIdOf(41), 42: testIdOf(42) },
  documents: DOCS.map((d) => ({ id: d.id, seed: d.seed.code, fileName: d.seed.fileName, viewableName: d.viewableName })),
  counts: { pool: POOL.length, v41: idsFor(41).length, v42: idsFor(42).length },
  expectedDiff: {
    new: byFate(["new"]),
    persisting: byFate(["persisting", "persisting_new_id"]),
    resolved: byFate(["resolved"]),
    element_deleted: byFate(["element_deleted"]),
    reappeared: byFate(["reappeared"]),
    matchedByPairKey: POOL.flatMap((_, i) =>
      fate.get(i) === "persisting_new_id" ? [{ prevId: String(clashIdOf(i)), nextId: String(clashIdOf(i) + ID_SHIFT) }] : [],
    ),
  },
  patterns: Object.fromEntries(
    POOL.map((e, i) => [String(fate.get(i) === "persisting_new_id" ? clashIdOf(i) + ID_SHIFT : clashIdOf(i)), e.pattern]),
  ),
  patternCounts: Object.fromEntries(
    [...new Set(POOL.map((e) => e.pattern))].map((pt) => [pt, POOL.filter((e) => e.pattern === pt).length]),
  ),
  deletedExternalIds: ELEMENTS.filter((e) => e.deletedIn42).map((e) => e.externalId),
  index: indexCatalog,
});

console.log(
  `fixtures: pool=${POOL.length} v41=${idsFor(41).length} v42=${idsFor(42).length} elements=${ELEMENTS.length} fields=${FIELDS.size} -> ${OUT}`,
);
