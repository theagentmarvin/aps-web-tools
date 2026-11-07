/**
 * Mock report aggregation + seeded history (audit, corrections, rule
 * suggestions).
 */
import type { EffectiveValues } from "../decision-utils";
import type * as T from "../types";
import { DISCIPLINES, USERS } from "./catalog";
import { PROJECTS } from "./fixtures";
import type { GeneratedTest } from "./generate";

interface ReportInput {
  scope: T.ReportScope;
  data: GeneratedTest;
  decisions: T.Decision[];
  effective: Map<string, EffectiveValues>;
  corrections: T.CorrectionRow[];
}

export function buildReport(i: ReportInput): T.ReportData {
  const { data, decisions } = i;
  const active = data.clashes.filter((c) => c.status === "active").length;
  const groupsReviewed = decisions.filter((d) => d.targetType === "group" && d.kind !== "postpone").length;
  const accepted = decisions.filter((d) => d.kind === "accept").length;
  const corrected = decisions.filter((d) => d.kind === "correct").length;
  const rejected = decisions.filter((d) => d.kind === "reject").length;
  const reviewedGroups = new Set(decisions.map((d) => d.targetId));
  const rawReviewed = data.groups.filter((g) => reviewedGroups.has(g.id)).reduce((s, g) => s + g.clashIds.length, 0);
  const reviewSeconds = decisions.reduce((s, d) => s + d.viewedInViewerMs / 1000 + 4, 0);

  const codes = DISCIPLINES.map((d) => d.code);
  const matrix: T.ReportData["matrix"] = {};
  for (const a of codes) {
    matrix[a] = {};
    for (const b of codes) matrix[a][b] = 0;
  }
  const byPair = new Map<string, { active: number; reviewed: number; resolved: number; closed: number }>();
  const groupById = new Map(data.groups.map((g) => [g.id, g]));
  for (const c of data.clashes) {
    const g = groupById.get(c.groupId);
    const [a, b] = g ? g.pair : [c.a.discipline, c.b.discipline];
    const validity = i.effective.get(c.groupId)?.validity;
    if (c.status === "active" && (validity === undefined || validity === "real")) {
      matrix[a][b]++;
      if (a !== b) matrix[b][a]++;
    }
    const key = a < b ? `${a}×${b}` : `${b}×${a}`;
    const row = byPair.get(key) ?? { active: 0, reviewed: 0, resolved: 0, closed: 0 };
    row[c.status]++;
    byPair.set(key, row);
  }

  const reasons = new Map<T.ReasonCode, number>();
  for (const c of i.corrections) if (c.reasonCode) reasons.set(c.reasonCode, (reasons.get(c.reasonCode) ?? 0) + 1);

  const total = data.clashes.length;
  return {
    scope: i.scope,
    kpis: {
      activeClashes: active,
      activeClashesPrev: Math.round(active * 1.09),
      groups: data.groups.length,
      rawClashes: total,
      groupsReviewed,
      issuesCreated: 23,
      aiAccepted: accepted + 240,
      aiCorrected: corrected + 28,
      aiRejected: rejected + 6,
      rawClashesReviewed: rawReviewed + 2100,
      actualReviewSeconds: reviewSeconds + 21000,
    },
    burndown: [
      { label: "21-10 · v12", active: Math.round(total * 1.18), reviewed: 40, resolved: 0, closed: 12, valid: Math.round(total * 0.8) },
      { label: "28-10 · v13", active: Math.round(total * 1.0), reviewed: 120, resolved: 64, closed: 90, valid: Math.round(total * 0.72) },
      { label: `${data.test.completedOn.slice(8, 10)}-${data.test.completedOn.slice(5, 7)} · v${data.test.modelSetVersion}`, active, reviewed: data.clashes.filter((c) => c.status === "reviewed").length + 60, resolved: 140, closed: 210, valid: Math.round(active * 0.68) },
    ],
    disciplines: codes,
    matrix,
    byStatusPair: [...byPair.entries()].map(([pair, v]) => ({ pair, ...v })).sort((a, b) => b.active - a.active),
    newVsResolved: [
      { label: "v12", new: Math.round(total * 1.24), resolved: 0 },
      { label: "v13", new: 312, resolved: 488 },
      { label: `v${data.test.modelSetVersion}`, new: data.clashes.filter((c) => c.delta === "new").length, resolved: 402 },
    ],
    reasons: [...reasons.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    calibration: [
      { band: "alta", proposals: 1204, acceptedUnchanged: 1156 },
      { band: "media", proposals: 412, acceptedUnchanged: 321 },
      { band: "baja", proposals: 38, acceptedUnchanged: 20 },
    ],
    p1Aging: { lt1w: 14, w1to2: 9, w2to4: 5, gt4w: 2 },
  };
}

export function seedAudit(): T.AuditEvent[] {
  const p = PROJECTS[0];
  const ms = p.modelSets[0];
  const now = Date.now();
  const h = (n: number) => new Date(now - n * 3600000).toISOString();
  const agent = { type: "agent" as const, id: "agent", name: "Agente" };
  const user = { type: "user" as const, id: USERS[0].id, name: USERS[0].short };
  const mgr = { type: "user" as const, id: USERS[1].id, name: USERS[1].short };
  const server = { type: "server" as const, id: "server", name: "Servidor" };
  const hrt = PROJECTS[2];
  const ev: Omit<T.AuditEvent, "hash">[] = [
    { id: "A-0001", at: h(1), actor: agent, action: "proposal.created", projectId: p.id, modelSetId: ms.id, testId: "T-3f9a21c0", targetIds: ["G-0001", "G-0150"], details: { proposals: 150, runId: "run-1a2b14" } },
    { id: "A-0002", at: h(2), actor: agent, action: "rule.suggested", projectId: p.id, targetIds: ["RS-0001"], details: { title: "Pasadas previstas en losas EST×SAN" } },
    { id: "A-0003", at: h(21), actor: user, action: "decision.accepted", projectId: p.id, modelSetId: ms.id, testId: "T-3f9a21c0", targetIds: ["G-0003"], details: { proposalId: "P-20261104-0003", viewedInViewerMs: 4200 } },
    { id: "A-0004", at: h(21.5), actor: user, action: "decision.corrected", projectId: p.id, modelSetId: ms.id, testId: "T-3f9a21c0", targetIds: ["G-0007"], details: { field: "priority", reasonCode: "R08" } },
    { id: "A-0005", at: h(21.8), actor: user, action: "batch.ready", projectId: p.id, modelSetId: ms.id, testId: "T-3f9a21c0", batchId: "L-2026-11-05-01", targetIds: [], details: { decisions: 18 } },
    { id: "A-0006", at: h(96), actor: user, action: "batch.ready", projectId: p.id, modelSetId: p.modelSets[1].id, testId: "T-5a6b7c8d", batchId: "L-2026-11-02-01", targetIds: [], details: { decisions: 9 } },
    { id: "A-0007", at: h(142), actor: server, action: "preflight.run", projectId: hrt.id, modelSetId: hrt.modelSets[0].id, testId: "T-9e0f1a2b", batchId: "L-2026-10-31-01", targetIds: [], details: { conflicts: 0 } },
    { id: "A-0008", at: h(141.5), actor: mgr, action: "batch.approved", projectId: hrt.id, modelSetId: hrt.modelSets[0].id, testId: "T-9e0f1a2b", batchId: "L-2026-10-31-01", targetIds: [], details: { items: 96 } },
    { id: "A-0009", at: h(141.4), actor: server, action: "acc.issue.created", projectId: hrt.id, modelSetId: hrt.modelSets[0].id, testId: "T-9e0f1a2b", batchId: "L-2026-10-31-01", targetIds: [], details: { count: 9 }, accResponseId: "acc-7f3e2a1b" },
    { id: "A-0010", at: h(141.3), actor: server, action: "acc.clash.statusChanged", projectId: hrt.id, modelSetId: hrt.modelSets[0].id, testId: "T-9e0f1a2b", batchId: "L-2026-10-31-01", targetIds: [], details: { count: 87 }, accResponseId: "acc-8a4f3b2c" },
    { id: "A-0011", at: h(170), actor: mgr, action: "rule.disabled", projectId: p.id, targetIds: ["FP-012"], details: { reason: "Generaba falsos cierres en cielos RF" } },
    { id: "A-0012", at: h(171), actor: mgr, action: "settings.changed", projectId: p.id, targetIds: [], details: { key: "dwellGuardSeconds", from: 1, to: 1.5 } },
  ];
  return ev.map((e, i) => ({ ...e, hash: fakeHash(e.id + i) }));
}

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
