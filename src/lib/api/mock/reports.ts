/**
 * Mock seeded history used by the Reglas page (corrections, rule suggestions)
 * and the audit hash helper. The Reportes and Auditoría pages were removed.
 */
import type * as T from "../types";
import { USERS } from "./catalog";

export function seedCorrections(): T.CorrectionRow[] {
  const rows: T.CorrectionRow[] = [];
  const samples: [T.CorrectionRow["field"], string, string, T.ReasonCode, string[]][] = [
    ["validity", "Válida", "Pasada prevista", "R02", ["PRI-001"]],
    ["priority", "P1", "P2", "R08", ["PRI-001"]],
    ["validity", "Válida", "Tolerable", "R03", []],
    ["owner", "CLI", "SAN", "R10", ["OWN-002"]],
    ["validity", "Falso positivo", "Válida", "R06", ["FP-003"]],
    ["priority", "P3", "P2", "R09", ["PRI-003"]],
    ["reject", "—", "Rechazada", "R04", ["DUP-001"]],
    ["validity", "Válida", "Pasada prevista", "R02", ["SEI-001"]],
  ];
  for (let k = 0; k < 24; k++) {
    const [field, ai, human, code, rules] = samples[k % samples.length];
    rows.push({
      decisionId: `seed-${k}`,
      at: new Date(Date.now() - (k + 2) * 5.5 * 3600000).toISOString(),
      userName: USERS[k % 2].short,
      targetId: `G-${String(30 + k * 3).padStart(4, "0")}`,
      targetLabel: `G-${String(30 + k * 3).padStart(4, "0")}`,
      field,
      aiValue: ai,
      humanValue: human,
      reasonCode: code,
      note: code === "R02" ? "Hay manga en planos de estructura, no modelada aún." : undefined,
      ruleIds: rules,
      confidence: 0.55 + ((k * 13) % 40) / 100,
    });
  }
  return rows;
}

export function seedSuggestions(): T.RuleSuggestion[] {
  return [
    {
      id: "RS-0001",
      title: "Pasadas previstas en losas EST×SAN",
      count: 12,
      reasonCode: "R02",
      pair: "EST×SAN",
      summary: "Tuberías de aguas servidas Ø ≤ 110 que atraviesan losas en shafts sanitarios marcados en arquitectura son pasadas previstas.",
      patch:
        "--- a/rules/classification-rules.yaml\n+++ b/rules/classification-rules.yaml\n@@ -356,6 +356,15 @@\n   - id: TOL-001\n     name: Tolerancia MEP vs tabiques\n+  - id: SEI-002\n+    name: Pasada prevista en shaft sanitario\n+    pair: [EST, SAN]\n+    when:\n+      a.category: floors\n+      b.system: aguas servidas\n+      b.diameterMm: { lte: 110 }\n+      zone.tag: shaft\n+    set: { validity: by_design, confidence: 0.9 }\n",
      affected: 37,
      evaluation: { baselineMacroF1: 0.81, candidateMacroF1: 0.84, unsafeClosureRate: 0 },
      state: "pending",
      createdAt: new Date(Date.now() - 3 * 3600000).toISOString(),
    },
    {
      id: "RS-0002",
      title: "Bajar prioridad de escalerillas vs cielo con holgura",
      count: 8,
      reasonCode: "R08",
      pair: "ARQ×ELE",
      summary: "Escalerillas que tocan el cielo falso con penetración menor a 30 mm se proponen P4 en vez de P3.",
      patch:
        "--- a/rules/priority-scoring.yaml\n+++ b/rules/priority-scoring.yaml\n@@ -88,7 +88,7 @@\n   - id: PRI-004\n     pair: [ARQ, ELE]\n-    maxPenetrationMm: 20\n+    maxPenetrationMm: 30\n     priority: 4\n",
      affected: 21,
      evaluation: { baselineMacroF1: 0.81, candidateMacroF1: 0.815, unsafeClosureRate: 0 },
      state: "pending",
      createdAt: new Date(Date.now() - 27 * 3600000).toISOString(),
    },
  ];
}

/** Deterministic pseudo-hash for mock audit events (the real store hash-chains them). */
export function fakeHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0").repeat(8);
}
