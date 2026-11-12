/**
 * Static catalog for the mock: disciplines, clash templates per discipline
 * pair, rules. Labels follow rules/discipline-matrix.yaml.
 */
import type { Discipline, Nature, RuleEffect, RuleState, Validity } from "../types";

/**
 * Internal mock "pattern" (finer than the domain vocabulary). Mapped at the
 * output boundary to the engine vocabulary (docs/domain/clash-taxonomy.md):
 * duplicate → false_positive + nature duplicate; by_design (standard
 * penetration) → tolerated; model_error → real (rootCause modeling_error);
 * unknown → needs_info.
 */
export type MockKind = "real" | "false_positive" | "duplicate" | "tolerance" | "by_design" | "model_error" | "unknown";

export function kindToValidity(k: MockKind): Validity {
  switch (k) {
    case "real":
    case "model_error":
      return "real";
    case "false_positive":
    case "duplicate":
      return "false_positive";
    case "tolerance":
    case "by_design":
      return "tolerated";
    default:
      return "needs_info";
  }
}

export function kindToNature(k: MockKind): Nature {
  return k === "duplicate" ? "duplicate" : "hard";
}

export const DISCIPLINES: Discipline[] = [
  { code: "EST", es: "Estructura", en: "Structure" },
  { code: "ARQ", es: "Arquitectura", en: "Architecture" },
  { code: "CLI", es: "Climatización", en: "HVAC" },
  { code: "SAN", es: "Sanitarias", en: "Plumbing" },
  { code: "ELE", es: "Electricidad", en: "Electrical" },
  { code: "INC", es: "Protección contra incendio", en: "Fire protection" },
];

export interface ElementTemplate {
  discipline: string;
  category: string;
  /** Spanish category label used in titles. */
  categoryEs: string;
  family: string;
  types: string[];
  /** Name pattern; `#` is replaced by a number. */
  name: string;
  systems?: string[];
  sizes?: string[];
}

export interface ClashTemplate {
  a: ElementTemplate;
  b: ElementTemplate;
  weight: number;
  /** Title pattern: {A} first element name, {B} second, {n} count, {level}. */
  title: string;
  /** Validity distribution for this template. */
  validity: Partial<Record<MockKind, number>>;
  toleranceMm: number;
  /** Discipline that usually moves (who-moves rule). */
  owner: string;
}

const viga: ElementTemplate = {
  discipline: "EST", category: "Structural Framing", categoryEs: "Vigas", family: "Viga hormigón armado",
  types: ["Viga H.A. 30x70", "Viga H.A. 25x60", "Viga H.A. 40x80"], name: "Viga V-2#",
};
const losa: ElementTemplate = {
  discipline: "EST", category: "Floors", categoryEs: "Losas", family: "Losa hormigón armado",
  types: ["Losa H.A. e=15", "Losa H.A. e=18", "Losa H.A. e=20"], name: "Losa L-#",
};
const muroEst: ElementTemplate = {
  discipline: "EST", category: "Walls", categoryEs: "Muros", family: "Muro hormigón armado",
  types: ["Muro H.A. e=20", "Muro H.A. e=25", "Muro H.A. e=30"], name: "Muro M-#",
};
const pilar: ElementTemplate = {
  discipline: "EST", category: "Structural Columns", categoryEs: "Pilares", family: "Pilar hormigón armado",
  types: ["Pilar H.A. 50x50", "Pilar H.A. 60x60"], name: "Pilar P-#",
};
const tabique: ElementTemplate = {
  discipline: "ARQ", category: "Walls", categoryEs: "Tabiques", family: "Tabique volcanita",
  types: ["Tabique 10 cm", "Tabique 15 cm doble placa", "Tabique RF-60"], name: "Tabique T-#",
};
const cielo: ElementTemplate = {
  discipline: "ARQ", category: "Ceilings", categoryEs: "Cielos", family: "Cielo falso",
  types: ["Cielo volcanita 12,5", "Cielo modular 60x60"], name: "Cielo C-#",
};
const ducto: ElementTemplate = {
  discipline: "CLI", category: "Ducts", categoryEs: "Ductos", family: "Ducto rectangular",
  types: ["Rect. 600x400", "Rect. 800x500", "Rect. 400x300", "Circular Ø350"], name: "Ducto DR-#",
  systems: ["Retorno RA-1", "Inyección IA-2", "Extracción EX-3", "Presurización PZ-1"],
};
const tuberiaSan: ElementTemplate = {
  discipline: "SAN", category: "Pipes", categoryEs: "Tuberías", family: "Tubería PVC",
  types: ["PVC Ø110", "PVC Ø75", "PVC Ø160", "PPR Ø32"], name: "Tubería AS-#",
  systems: ["Aguas servidas", "Aguas lluvias", "Agua potable fría", "Agua potable caliente"],
};
const bandeja: ElementTemplate = {
  discipline: "ELE", category: "Cable Trays", categoryEs: "Escalerillas", family: "Escalerilla portacables",
  types: ["Escalerilla 300x100", "Escalerilla 200x100", "Bandeja perforada 400x100"], name: "Escalerilla BP-#",
  systems: ["Fuerza", "Alumbrado", "Corrientes débiles"],
};
const redHumeda: ElementTemplate = {
  discipline: "INC", category: "Pipes", categoryEs: "Red húmeda", family: "Tubería acero",
  types: ["Acero Ø65", "Acero Ø50", "Acero Ø100"], name: "Red húmeda RH-#",
  systems: ["Red húmeda", "Red seca", "Rociadores"],
};
const rociador: ElementTemplate = {
  discipline: "INC", category: "Sprinklers", categoryEs: "Rociadores", family: "Rociador colgante",
  types: ["Rociador K5.6 colgante"], name: "Rociador SP-#", systems: ["Rociadores"],
};

export const TEMPLATES: ClashTemplate[] = [
  { a: viga, b: ducto, weight: 18, title: "{B} cruza {n} vigas · {level}", validity: { real: 0.78, by_design: 0.1, tolerance: 0.07, duplicate: 0.05 }, toleranceMm: 25, owner: "CLI" },
  { a: losa, b: tuberiaSan, weight: 14, title: "{B} atraviesa {A} sin pasada · {level}", validity: { real: 0.45, by_design: 0.35, tolerance: 0.1, model_error: 0.05, unknown: 0.05 }, toleranceMm: 10, owner: "SAN" },
  { a: cielo, b: bandeja, weight: 12, title: "{B} bajo {A}: cielo invade escalerilla · {level}", validity: { real: 0.55, tolerance: 0.25, false_positive: 0.15, unknown: 0.05 }, toleranceMm: 20, owner: "ELE" },
  { a: muroEst, b: redHumeda, weight: 9, title: "{B} atraviesa {A} · {level}", validity: { real: 0.6, by_design: 0.3, duplicate: 0.1 }, toleranceMm: 10, owner: "INC" },
  { a: ducto, b: tuberiaSan, weight: 10, title: "{A} vs {B} en shaft · {level}", validity: { real: 0.7, duplicate: 0.1, tolerance: 0.1, unknown: 0.1 }, toleranceMm: 15, owner: "CLI" },
  { a: ducto, b: bandeja, weight: 9, title: "{A} sobre {B} en pasillo · {level}", validity: { real: 0.65, tolerance: 0.2, false_positive: 0.1, unknown: 0.05 }, toleranceMm: 20, owner: "ELE" },
  { a: tabique, b: ducto, weight: 8, title: "{B} cruza {A} sin vano · {level}", validity: { real: 0.5, by_design: 0.3, false_positive: 0.2 }, toleranceMm: 15, owner: "ARQ" },
  { a: viga, b: bandeja, weight: 7, title: "{B} atraviesa viga {A} · {level}", validity: { real: 0.75, tolerance: 0.15, duplicate: 0.1 }, toleranceMm: 25, owner: "ELE" },
  { a: tuberiaSan, b: rociador, weight: 6, title: "{B} choca con {A} · {level}", validity: { real: 0.6, false_positive: 0.25, tolerance: 0.15 }, toleranceMm: 10, owner: "INC" },
  { a: tabique, b: tuberiaSan, weight: 6, title: "{B} embutida en {A} · {level}", validity: { by_design: 0.55, false_positive: 0.25, real: 0.2 }, toleranceMm: 5, owner: "SAN" },
  { a: pilar, b: tabique, weight: 5, title: "{B} se superpone a {A} · {level}", validity: { model_error: 0.3, tolerance: 0.3, duplicate: 0.2, real: 0.2 }, toleranceMm: 10, owner: "ARQ" },
  { a: bandeja, b: redHumeda, weight: 5, title: "{B} cruza {A} · {level}", validity: { real: 0.7, tolerance: 0.2, unknown: 0.1 }, toleranceMm: 15, owner: "ELE" },
];

export const LEVELS: { name: string; elevation: number }[] = [
  { name: "Subterráneo -2", elevation: -6.4 },
  { name: "Subterráneo -1", elevation: -3.2 },
  ...Array.from({ length: 12 }, (_, i) => ({ name: `Nivel ${i + 1}`, elevation: Number((i * 3.2).toFixed(2)) })),
];

export const GRID_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

export const USERS = [
  { id: "u-crojas", name: "Camila Rojas", short: "C. Rojas", initials: "CR" },
  { id: "u-rzepeda", name: "Rodrigo Zepeda", short: "R. Zepeda", initials: "RZ" },
  { id: "u-dmunoz", name: "Diego Muñoz", short: "D. Muñoz", initials: "DM" },
];

export interface MockRule {
  id: string;
  name: string;
  scope: string;
  effect: RuleEffect;
  state: RuleState;
  file: string;
  description: string;
  conditions: string[];
}

export const RULES: MockRule[] = [
  { id: "FP-001", name: "Aislación térmica alojada en ducto", scope: "CLI × *", effect: "validity", state: "active", file: "rules/classification-rules.yaml",
    description: "Interferencias de la aislación alojada en el propio ducto se consideran falso positivo.", conditions: ["categoría A o B = Duct Insulation", "elemento anfitrión = ducto involucrado"] },
  { id: "FP-003", name: "Contacto superficial bajo 5 mm", scope: "* × *", effect: "validity", state: "active", file: "rules/classification-rules.yaml",
    description: "Penetraciones menores a 5 mm entre superficies coplanares son falsos positivos geométricos.", conditions: ["penetración < 5 mm", "normales paralelas"] },
  { id: "FP-007", name: "Tubería embutida en tabique", scope: "ARQ × SAN", effect: "validity", state: "active", file: "rules/classification-rules.yaml",
    description: "Tuberías de agua potable Ø ≤ 32 mm dentro de tabiques de volcanita están previstas.", conditions: ["A = tabique volcanita", "B = tubería Ø ≤ 32 mm", "sistema = agua potable"] },
  { id: "FP-012", name: "Rociador colgante en cielo", scope: "ARQ × INC", effect: "validity", state: "disabled", file: "rules/classification-rules.yaml",
    description: "Rociadores colgantes que atraviesan el cielo falso son condición de diseño.", conditions: ["B = rociador colgante", "A = cielo falso"] },
  { id: "TOL-001", name: "Tolerancia MEP vs tabiques", scope: "ARQ × @MEP", effect: "validity", state: "active", file: "rules/discipline-matrix.yaml",
    description: "Penetraciones menores a 15 mm entre instalaciones y tabiques se aceptan como tolerables.", conditions: ["par ARQ × MEP", "penetración < 15 mm"] },
  { id: "TOL-002", name: "Tolerancia escalerillas vs cielo", scope: "ARQ × ELE", effect: "validity", state: "active", file: "rules/discipline-matrix.yaml",
    description: "Escalerillas que tocan el cielo falso hasta 20 mm son tolerables.", conditions: ["B = escalerilla", "A = cielo", "penetración < 20 mm"] },
  { id: "TOL-003", name: "Recubrimiento de losa", scope: "EST × @MEP", effect: "validity", state: "draft", file: "rules/discipline-matrix.yaml",
    description: "Penetraciones menores a 10 mm en recubrimiento de losas se tratan como tolerancia.", conditions: ["A = losa", "penetración < 10 mm"] },
  { id: "DUP-001", name: "Mismo par de elementos en dos pruebas", scope: "* × *", effect: "grouping", state: "active", file: "rules/classification-rules.yaml",
    description: "Interferencias repetidas entre los mismos elementos (por externalId) se marcan como duplicadas.", conditions: ["mismo par externalId", "misma prueba"] },
  { id: "DUP-004", name: "Ducto segmentado", scope: "CLI × *", effect: "grouping", state: "active", file: "rules/classification-rules.yaml",
    description: "Segmentos contiguos de un mismo tramo de ducto se agrupan como una sola causa.", conditions: ["mismo sistema", "segmentos conectados"] },
  { id: "SEI-001", name: "Pasada sísmica prevista", scope: "EST × @MEP", effect: "validity", state: "active", file: "rules/classification-rules.yaml",
    description: "Pasadas con manga modelada en muros estructurales son condición de diseño.", conditions: ["A = muro estructural", "existe manga modelada a < 50 mm"] },
  { id: "HYG-002", name: "Elemento sin nivel", scope: "* × *", effect: "validity", state: "active", file: "rules/classification-rules.yaml",
    description: "Elementos sin nivel asignado se marcan como error de modelo.", conditions: ["nivel vacío en A o B"] },
  { id: "PRI-001", name: "Penetración en estructura", scope: "EST × *", effect: "priority", state: "active", file: "rules/priority-scoring.yaml",
    description: "Penetraciones > 50 mm en vigas o losas suben a P1/P2.", conditions: ["A = EST", "penetración > 50 mm"] },
  { id: "PRI-003", name: "Instalaciones gravitacionales", scope: "SAN × *", effect: "priority", state: "active", file: "rules/priority-scoring.yaml",
    description: "Tuberías gravitacionales tienen prioridad alta por su baja flexibilidad de trazado.", conditions: ["B = aguas servidas o aguas lluvias"] },
  { id: "PRI-005", name: "Interferencias en pasillos de evacuación", scope: "* × INC", effect: "priority", state: "active", file: "rules/priority-scoring.yaml",
    description: "Redes de incendio en vías de evacuación suben un nivel de prioridad.", conditions: ["zona = evacuación", "B = INC"] },
  { id: "OWN-001", name: "Quién se mueve: MEP antes que estructura", scope: "EST × @MEP", effect: "owner", state: "active", file: "rules/discipline-matrix.yaml",
    description: "En choques estructura vs instalaciones, la instalación es responsable de desviar.", conditions: ["par EST × MEP"] },
  { id: "OWN-002", name: "Quién se mueve: gravitacionales mandan", scope: "@MEP × SAN", effect: "owner", state: "active", file: "rules/discipline-matrix.yaml",
    description: "Las tuberías gravitacionales no se desvían; se mueve la otra instalación.", conditions: ["B = aguas servidas o aguas lluvias"] },
];
