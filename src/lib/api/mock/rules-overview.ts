/** Mock data of the Reglas page (demo mode only; the real page reads GET /rules/overview). */
import type * as T from "../types";

const rule = (id: string, nameEs: string, sides: [string | null, string | null], validity: string, responsible: string, action: string, use: number, n: number, agree: number, when: Record<string, unknown> = {}): T.RuleRow => ({
  id,
  name: nameEs,
  nameEs,
  section: id.split("-")[0]!,
  sides,
  validity,
  responsible,
  severity: validity === "real" ? "high" : "none",
  action,
  confidence: 0.85,
  humanReview: id === "DEF-999",
  usage: { clashes: use, groups: Math.ceil(use / 4) },
  totalUse: use,
  accuracy: { agree, n, rate: n >= 5 ? agree / n : null, ...(n > agree ? { topCorrection: "Conflicto → No es problema" } : {}) },
  thresholds: (() => {
    const out: T.RuleThreshold[] = [];
    for (const [block, m] of Object.entries(when)) for (const [field, v] of Object.entries(m as Record<string, unknown>)) if (v && typeof v === "object") for (const [op, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "number") out.push({ path: `${block}.${field}.${op}`, block, field, op, value: x });
    return out;
  })(),
  raw: { id, name: nameEs, nameEs, when, then: { validity, nature: "hard", rootCause: "design_coordination", responsibleDiscipline: responsible, severity: validity === "real" ? "high" : "none", confidence: 0.85, suggestedAction: action, rationale: nameEs } },
  fallback: id === "DEF-999",
});

export function mockRulesOverview(): T.RulesOverview {
  return {
    tests: [{ testKey: "T-3f9a21c0", projectId: "demo-proyecto", modelSetId: "ms-demo", version: 42, label: "Edificio Demo · Coordinación v42", classifiedTests: 1 }],
    selectedTestKey: "T-3f9a21c0",
    rules: [
      rule("HYG-002", "Objeto no físico o analítico", [null, null], "false_positive", "COORD", "close_not_issue", 12, 6, 6),
      rule("DUP-001", "Mismo elemento en dos archivos", [null, null], "false_positive", "COORD", "hygiene_issue", 30, 4, 4),
      rule("EST-001", "Instalación atraviesa pilar", ["MEP", "EST"], "real", "$a", "create_issue", 18, 9, 9, { a: { elementClass: { inSet: "MEP_ANY" } }, b: { elementClass: "structure_column" } }),
      rule("EST-005", "Instalación ≥ 100 mm atraviesa viga", ["MEP", "EST"], "real", "$a", "create_issue", 44, 12, 7, { a: { elementClass: { inSet: "MEP_DIST" }, sizeMm: { gte: 100 } }, b: { elementClass: "structure_framing" } }),
      rule("MA-007", "Instalación grande atraviesa tabique", ["MEP", "ARQ"], "real", "$a", "create_issue", 0, 0, 0, { a: { elementClass: { inSet: "MEP_DIST" }, sizeMm: { gt: 150 } }, b: { elementClass: "arch_wall" } }),
      rule("MM-001", "Cruce de redes", ["MEP", "MEP"], "real", "@mover", "create_issue", 22, 3, 2),
      rule("DEF-999", "Sin regla específica", [null, null], "real", "@mover", "create_issue", 9, 2, 1),
    ],
    library: [{ id: "TOL-009", nameEs: "Tolerancia de cielo", section: "TOL", sides: ["MEP", "ARQ"], validity: "tolerated", retiredAt: "2026-11-01" }],
    annotations: [
      { id: "ANN-002", tags: ["seguridad_personas"], note: "Involucra un sistema o recinto de seguridad de las personas." },
      { id: "ANN-006", tags: ["requiere_calculista"], note: "Toda pasada en estructura requiere aprobación del ingeniero calculista." },
    ],
    minAccuracyN: 5,
  };
}
