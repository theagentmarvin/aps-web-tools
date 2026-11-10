/**
 * Deterministic mock data generator (seeded PRNG): groups, clashes,
 * proposals for one test run.
 */
import type {
  AccStatus,
  Clash,
  ClashGroup,
  Delta,
  ElementInfo,
  FieldSource,
  IssueDraft,
  Priority,
  Proposal,
  Severity,
  TestDocument,
  TestRun,
  Validity,
} from "../types";
import { DISCIPLINES, GRID_LETTERS, LEVELS, TEMPLATES, USERS, kindToNature, kindToValidity, type ClashTemplate, type ElementTemplate, type MockKind } from "./catalog";

// ── PRNG ───────────────────────────────────────────────────────────

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T,>(arr: readonly T[]) => arr[Math.floor(next() * arr.length)],
    chance: (p: number) => next() < p,
    weighted: <K extends string>(dist: Partial<Record<K, number>>): K => {
      const entries = Object.entries(dist) as [K, number][];
      const total = entries.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [k, w] of entries) {
        r -= w;
        if (r <= 0) return k;
      }
      return entries[entries.length - 1][0];
    },
  };
}
export type Rng = ReturnType<typeof rng>;

// ── Helpers ────────────────────────────────────────────────────────

const pad = (n: number, w: number) => String(n).padStart(w, "0");

export function documentsFor(projectCode: string, version: number): TestDocument[] {
  return DISCIPLINES.map((d, i) => ({
    documentId: i + 1,
    urn: `urn:adsk.wipprod:fs.file:vf.MOCK-${projectCode}-${d.code}?version=${version}`,
    name: `${d.code}_${projectCode}.rvt`,
    discipline: d.code,
  }));
}

/** Mock document definition: `placeAs` decides which element templates land in it (may differ from the detected discipline). */
export interface MockDocDef {
  documentId: number;
  fileName: string;
  viewName: string;
  folderPath: string;
  lineageUrn: string;
  /** Discipline detected from Revit categories ("SIN" = none). */
  detected: string;
  /** How it was detected (default: unassigned when detected is SIN, else elements). */
  detectedSource?: "elements" | "matrix" | "unassigned";
  /** Share of elements of that discipline (detectedSource "elements"). */
  confidence?: number;
  /** Token suggested for "apply to files containing …". */
  suggestedToken?: string;
  /** Element discipline placed in this document by the generator; omit for a model with no clashes. */
  placeAs?: string;
}

function makeElement(r: Rng, t: ElementTemplate, docs: TestDocument[], level: string, num: number): ElementInfo {
  const doc = docs.find((d) => (d as TestDocument & { placeAs?: string }).placeAs === t.discipline) ?? docs.find((d) => d.discipline === t.discipline) ?? docs[0];
  const dbId = r.int(1200, 980000);
  return {
    ref: `E-${doc.documentId}:${dbId}`,
    documentId: doc.documentId,
    dbId,
    externalId: `${r.int(10000000, 99999999).toString(16)}-${pad(r.int(0, 99999), 5)}`,
    discipline: t.discipline,
    name: t.name.replace("#", String(num)),
    category: t.category,
    family: t.family,
    type: r.pick(t.types),
    system: t.systems ? r.pick(t.systems) : undefined,
    level,
    sizeHint: undefined,
    modelName: doc.name,
  };
}

/** Split `total` into `n` heavy-tailed positive sizes. */
function groupSizes(r: Rng, n: number, total: number): number[] {
  const w = Array.from({ length: n }, () => Math.exp(1.2 * (r.next() + r.next() + r.next() - 1.5) * 1.6));
  const sum = w.reduce((s, x) => s + x, 0);
  const sizes = w.map((x) => Math.max(1, Math.floor((x / sum) * total)));
  let diff = total - sizes.reduce((s, x) => s + x, 0);
  let i = 0;
  while (diff !== 0) {
    const k = i % n;
    if (diff > 0) {
      sizes[k]++;
      diff--;
    } else if (sizes[k] > 1) {
      sizes[k]--;
      diff++;
    }
    i++;
  }
  return sizes;
}

function pickTemplate(r: Rng): ClashTemplate {
  const idx = r.weighted<string>(Object.fromEntries(TEMPLATES.map((t, i) => [String(i), t.weight])));
  return TEMPLATES[Number(idx)];
}

function priorityFor(validity: MockKind, penMax: number, ownerA: string): Priority {
  if (validity === "unknown") return 3;
  if (validity !== "real" && validity !== "model_error") return 4;
  if (penMax > 100 || (ownerA === "EST" && penMax > 60)) return 1;
  if (penMax > 40) return 2;
  return 3;
}

function severityFor(v: Validity, penMax: number): Severity {
  if (v === "false_positive" || v === "tolerated") return "none";
  if (v === "needs_info") return "medium";
  return penMax > 150 ? "critical" : penMax > 60 ? "high" : penMax > 25 ? "medium" : "low";
}

function confidence(r: Rng, bias: number): number {
  const c = 0.42 + r.next() * 0.56 + bias;
  return Math.max(0.35, Math.min(0.99, Number(c.toFixed(2))));
}

function sourceFor(r: Rng): FieldSource {
  return r.weighted<FieldSource>({ rule: 0.6, llm: 0.25, "rule+llm": 0.15 });
}

const VALIDITY_RULES: Record<MockKind, string[]> = {
  real: ["PRI-001"],
  false_positive: ["FP-003", "FP-001"],
  duplicate: ["DUP-001", "DUP-004"],
  tolerance: ["TOL-001", "TOL-002"],
  by_design: ["SEI-001", "FP-007"],
  model_error: ["HYG-002"],
  unknown: [],
};

const VALIDITY_ES: Record<MockKind, string> = {
  real: "conflicto",
  false_positive: "no es problema",
  duplicate: "duplicada",
  tolerance: "dentro de tolerancia",
  by_design: "pasada prevista",
  model_error: "error de modelo",
  unknown: "por confirmar",
};

function rationale(t: ClashTemplate, v: MockKind, count: number, penMax: number, level: string): string {
  const what = `${t.b.categoryEs.toLowerCase()} de ${DISCIPLINES.find((d) => d.code === t.b.discipline)?.es.toLowerCase()} contra ${t.a.categoryEs.toLowerCase()}`;
  switch (v) {
    case "real":
      return `Se detectan ${count} interferencias de ${what} en ${level}, con penetraciones de hasta ${penMax} mm, muy por sobre la tolerancia de ${t.toleranceMm} mm para este par. No hay pasadas ni mangas modeladas en la zona. Corresponde a un problema real de coordinación; el trazado de ${t.owner} debe desviarse.`;
    case "false_positive":
      return `Las ${count} interferencias de ${what} son contactos superficiales (máx. ${penMax} mm) entre caras coplanares. La geometría no se intersecta realmente; se propone cerrarlas como falso positivo.`;
    case "duplicate":
      return `Este grupo repite el mismo par de elementos ya representado en otro grupo de la prueba (mismo externalId). Se propone cerrar como duplicada para evitar incidencias repetidas.`;
    case "tolerance":
      return `La penetración máxima (${penMax} mm) queda dentro de la tolerancia del proyecto para ${what} (${t.toleranceMm} mm). Se propone cerrar como tolerable.`;
    case "by_design":
      return `Existe una pasada o manga modelada a menos de 50 mm del punto de choque en ${level}. Se trata de una penetración prevista por diseño; se propone cerrar.`;
    case "model_error":
      return `Uno de los elementos no tiene nivel asignado o está duplicado en el modelo de origen. Es un error de modelación más que una interferencia; se propone incidencia al modelador.`;
    default:
      return `Las reglas no son concluyentes para ${what} en ${level}: la penetración (${penMax} mm) está cerca del umbral y no hay información de pasadas. Se requiere revisión del coordinador.`;
  }
}

function issueDraftFor(t: ClashTemplate, g: ClashGroup, a: ElementInfo, b: ElementInfo, created: Date, clashIds: string[]): IssueDraft {
  const due = new Date(created.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const levelName = g.location?.level ?? "";
  return {
    title: `[${g.pair[0]}×${g.pair[1]}] ${b.name} × ${a.name} – ${levelName}`.slice(0, 120),
    description:
      `Problema: ${b.name} (${b.type}) interfiere con ${a.name} (${a.type}) en ${g.clashIds.length} puntos.\n` +
      `Ubicación: ${levelName}${g.location?.grid ? `, ejes ${g.location.grid}` : ""}.\n` +
      `Elementos: ${a.modelName} id ${a.dbId} · ${b.modelName} id ${b.dbId}.\n` +
      `Penetración máxima: ${g.penetrationMaxMm} mm (tolerancia ${t.toleranceMm} mm).\n` +
      `Propuesta de solución: desviar el trazado de ${t.owner} o coordinar pasada con estructura.\n` +
      `Referencias: grupo ${g.id}.`,
    ownerDiscipline: t.owner,
    assigneeRole: `Modelador ${t.owner}`,
    dueDate: due,
    issueType: "Coordinación",
    issueSubtype: "Interferencia",
    location: levelName,
    includeView: true,
    linkClashIds: clashIds.slice(0, 10),
  };
}

// ── Generator ──────────────────────────────────────────────────────

export interface GeneratedTest {
  test: TestRun;
  groups: ClashGroup[];
  clashes: Clash[];
  proposals: Proposal[];
}

export interface GenerateOptions {
  seed: number;
  projectCode: string;
  modelSetId: string;
  testId: string;
  version: number;
  completedOn: string;
  groups: number;
  clashes: number;
  analyzed: boolean;
  /** ACC clash test id (defaults to testId). */
  accTestId?: string;
  /** First analysed test of the set: everything is "new". */
  firstTest?: boolean;
  /** Explicit documents (real-looking file names); default: one per discipline. */
  documents?: MockDocDef[];
  /** Mock grid stage when not yet analysed: "counts" = clash grid downloaded, not classified. */
  stage?: "none" | "counts";
}

export function generateTest(o: GenerateOptions): GeneratedTest {
  const r = rng(o.seed);
  const docs: TestDocument[] = o.documents
    ? o.documents.map((d) => ({
        documentId: d.documentId,
        urn: `urn:adsk.wipprod:fs.file:vf.MOCK-${o.projectCode}-${d.documentId}?version=${o.version}`,
        name: `${d.fileName} · ${d.viewName}`,
        discipline: d.detected,
        placeAs: d.placeAs,
      }))
    : documentsFor(o.projectCode, o.version);
  const created = new Date(o.completedOn);
  const sizes = groupSizes(r, o.groups, o.clashes);
  const groups: ClashGroup[] = [];
  const clashes: Clash[] = [];
  const proposals: Proposal[] = [];
  let elementNum = 100;

  sizes.forEach((size, gi) => {
    const t = pickTemplate(r);
    const levelIdx = r.int(0, LEVELS.length - 1);
    const lvl = LEVELS[levelIdx];
    const gx = r.int(0, GRID_LETTERS.length - 2);
    const gy = r.int(1, 7);
    const grid = `${GRID_LETTERS[gx]}–${GRID_LETTERS[gx + 1]} / ${gy}–${gy + r.int(1, 2)}`;
    const validity = r.weighted<MockKind>(t.validity);
    const domainValidity: Validity = kindToValidity(validity);
    const nature = kindToNature(validity);
    const groupId = `G-${pad(gi + 1, 4)}`;
    const bElem = makeElement(r, t.b, docs, lvl.name, r.int(1, 40));
    const shareA = r.chance(0.3);
    const aFirst = makeElement(r, t.a, docs, lvl.name, (elementNum += r.int(1, 9)));

    const penBase = validity === "real" ? r.int(30, 180) : validity === "tolerance" ? r.int(3, t.toleranceMm) : r.int(1, 60);
    const clashIds: string[] = [];
    const deltaCounts = { new: 0, persisting: 0, reappeared: 0, modified: 0 };
    const statusCounts: Record<AccStatus, number> = { active: 0, reviewed: 0, resolved: 0, closed: 0 };
    let penMax = 0;
    let penMin = Infinity;
    const missing = r.chance(0.015);

    for (let k = 0; k < size; k++) {
      const id = `C-${4129946 + r.int(0, 999999)}${pad(r.int(0, 9999999), 7)}`;
      const pen = Math.max(1, Math.round(penBase * (0.35 + r.next() * 0.75)));
      const clearance = validity === "false_positive" && r.chance(0.3);
      const distanceMm = clearance ? r.int(1, 8) : -pen;
      const a = shareA ? aFirst : makeElement(r, t.a, docs, lvl.name, (elementNum += r.int(1, 4)));
      const b = shareA ? makeElement(r, t.b, docs, lvl.name, r.int(1, 40)) : { ...bElem, dbId: bElem.dbId + k, ref: `E-${bElem.documentId}:${bElem.dbId + k}` };
      const delta: Delta = o.firstTest ? "new" : r.weighted<Delta>({ new: 0.28, persisting: 0.57, reappeared: 0.05, modified: 0.1 });
      deltaCounts[delta as keyof typeof deltaCounts]++;
      const status = r.weighted<AccStatus>({ active: 0.86, reviewed: 0.09, resolved: 0.03, closed: 0.02 });
      statusCounts[status]++;
      if (!clearance) {
        penMax = Math.max(penMax, pen);
        penMin = Math.min(penMin, pen);
      }
      clashIds.push(id);
      clashes.push({
        id,
        groupId,
        status,
        distanceMm,
        a,
        b,
        level: lvl.name,
        validity: domainValidity,
        nature,
        delta,
        persistingCount: delta === "persisting" ? r.int(1, 4) : undefined,
        persistingSince: delta === "persisting" ? `v${o.version - 1}` : undefined,
        previousDistanceMm: delta === "modified" ? distanceMm + (r.chance(0.5) ? 1 : -1) * r.int(15, 60) : undefined,
        elementMissing: missing && k === 0 ? true : undefined,
      });
    }
    if (!Number.isFinite(penMin)) penMin = 0;

    const dominantDelta = (Object.entries(deltaCounts) as [Delta, number][]).sort((x, y) => y[1] - x[1])[0][0];
    const delta: Delta = deltaCounts.reappeared > 0 ? "reappeared" : dominantDelta;
    const accStatus = (Object.entries(statusCounts) as [AccStatus, number][]).sort((x, y) => y[1] - x[1])[0][0];
    const firstA = clashes[clashes.length - size].a;
    const title = t.title
      .replace("{A}", firstA.name)
      .replace("{B}", bElem.name)
      .replace("{n}", String(size))
      .replace("{level}", lvl.name);
    const createIssue = domainValidity === "real";
    const group: ClashGroup = {
      id: groupId,
      ruleId: null,
      ruleIds: [],
      testId: o.testId,
      strategy: shareA ? "by_element" : r.pick(["by_system_run", "by_root_cause", "by_level_zone"] as const),
      engineStrategy: shareA ? "element" : "zone",
      title,
      clashIds,
      pair: [t.a.discipline, t.b.discipline],
      location: { level: lvl.name, elevation: lvl.elevation, grid },
      penetrationMaxMm: penMax,
      penetrationMinMm: penMin,
      deltaSummary: deltaCounts,
      delta,
      accStatus,
      issue: createIssue ? (r.chance(0.12) ? "existing" : "draft") : "none",
      updatedAt: new Date(created.getTime() + r.int(1, 120) * 60000).toISOString(),
      elementMissing: missing || undefined,
      validity: domainValidity,
      nature,
      severity: severityFor(domainValidity, penMax),
      priority: priorityFor(validity, penMax, t.a.discipline),
      confidence: 1,
      reviewState: "auto_ok",
    };
    if (group.issue === "existing") group.existingIssueId = `#${r.int(120, 480)}`;
    groups.push(group);

    if (!o.analyzed) return;

    const bias = validity === "unknown" ? -0.3 : validity === "real" ? 0.1 : 0;
    const vConf = confidence(r, bias);
    const vSource = validity === "unknown" ? "llm" : sourceFor(r);
    const priority = priorityFor(validity, penMax, t.a.discipline);
    const pConf = confidence(r, 0.05);
    const pSource = sourceFor(r);
    const oConf = confidence(r, 0.15);
    const vRules = vSource === "llm" ? [] : VALIDITY_RULES[validity];
    const pRules = pSource === "llm" ? [] : [t.b.discipline === "SAN" ? "PRI-003" : t.b.discipline === "INC" ? "PRI-005" : "PRI-001"];
    const oRules = [t.a.discipline === "EST" ? "OWN-001" : "OWN-002"];
    const proposalId = `P-${o.completedOn.slice(0, 10).replace(/-/g, "")}-${pad(gi + 1, 4)}`;
    const p: Proposal = {
      id: proposalId,
      sourceProposalIds: [proposalId],
      targetType: "group",
      targetId: groupId,
      testId: o.testId,
      runId: `run-${(o.seed % 65536).toString(16)}${pad(o.version, 2)}`,
      model: vSource !== "rule" || pSource !== "rule" ? "claude-opus-5-5" : undefined,
      createdAt: group.updatedAt,
      updatedAt: group.updatedAt,
      fields: {
        validity: { value: domainValidity, confidence: vConf, source: vSource, ruleIds: vRules },
        priority: { value: priority, confidence: pConf, source: pSource, ruleIds: pRules },
        owner: { value: t.owner, confidence: oConf, source: "rule", ruleIds: oRules },
        action: {
          value: { createIssue, setStatus: domainValidity === "false_positive" ? "closed" : domainValidity === "tolerated" ? "reviewed" : null },
          confidence: Math.min(vConf, 0.97),
          source: vSource,
          ruleIds: vRules,
        },
      },
      rationale: rationale(t, validity, size, penMax, lvl.name),
      signals: [
        { label: "Penetración máx.", value: `${penMax} mm` },
        { label: "Tolerancia del par", value: `${t.toleranceMm} mm` },
        { label: "Categorías", value: `${t.a.categoryEs} × ${t.b.categoryEs}` },
        { label: "Pasada modelada", value: validity === "by_design" ? "Sí" : "No" },
        { label: "Validez", value: VALIDITY_ES[validity] },
      ],
      ruleIds: Array.from(new Set([...vRules, ...pRules, ...oRules])),
      spotCheck: false,
    };
    const minConf = Math.min(vConf, pConf, oConf, p.fields.action.confidence);
    group.ruleIds = p.ruleIds;
    group.ruleId = p.ruleIds[0] ?? null;
    group.confidence = minConf;
    group.priority = priority;
    group.reviewState = minConf < 0.7 || domainValidity === "needs_info" ? "needs_review" : "proposed";
    p.spotCheck = minConf >= 0.85 && (gi * 7919) % 19 === 0;
    if (createIssue) p.issueDraft = issueDraftFor(t, group, firstA, bElem, created, clashIds);
    if (!o.firstTest && deltaCounts.persisting > size / 2 && r.chance(0.12)) {
      const u = r.pick(USERS);
      p.inherited = {
        testId: `v${o.version - 1}`,
        decidedAt: new Date(created.getTime() - 7 * 86400000).toISOString(),
        userName: u.short,
        kind: r.chance(0.7) ? "accept" : "correct",
        reasonCode: r.chance(0.5) ? "R03" : undefined,
      };
    }
    proposals.push(p);
  });

  const test: TestRun = {
    id: o.testId,
    state: o.analyzed ? "classified" : "none",
    accTestId: o.accTestId ?? o.testId,
    cached: true,
    modelSetId: o.modelSetId,
    modelSetVersion: o.version,
    completedOn: o.completedOn,
    clashCount: clashes.length,
    analyzed: o.analyzed,
    documents: docs,
  };
  return { test, groups, clashes, proposals };
}
