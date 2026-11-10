/**
 * Mock data for the human-side parity views (docs/ai/agent-human-parity.md):
 * hygiene stats, cycle report KPIs, report files and the feedback log.
 * Deterministic and small: enough to exercise the UI without a server.
 */
import type * as T from "../types";
import type { GeneratedTest } from "./generate";
import { refreshFamily } from "./families";

const GENERIC = /gen[eé]ric|default|predetermin|placeholder|sin tipo/i;
const MEP = /duct|pipe|conduit|tuber|conduct|bandeja|canaliz/i;

/** Same shape (and roughly the same checks) as the server's get_model_hygiene_stats. */
export function mockHygiene(testId: string, d: GeneratedTest): T.TestHygiene {
  const docName = new Map(d.test.documents.map((x) => [x.documentId, x]));
  type Acc = { doc: string; discipline: string; el: Set<string>; self: number; dup: number; lvl: Set<string>; sys: Set<string>; gen: Set<string> };
  const per = new Map<number, Acc>();
  const findings = new Map<string, { check: T.HygieneCheck; doc: string; refs: Set<string>; clashes: Set<string> }>();
  const get = (id: number): Acc => {
    let a = per.get(id);
    if (!a) {
      const doc = docName.get(id);
      a = { doc: doc?.name ?? `doc ${id}`, discipline: doc?.discipline ?? "?", el: new Set(), self: 0, dup: 0, lvl: new Set(), sys: new Set(), gen: new Set() };
      per.set(id, a);
    }
    return a;
  };
  const hit = (check: T.HygieneCheck, doc: string, ref: string, clashId: string) => {
    const k = `${check}|${doc}`;
    const f = findings.get(k) ?? { check, doc, refs: new Set<string>(), clashes: new Set<string>() };
    f.refs.add(ref);
    f.clashes.add(clashId);
    findings.set(k, f);
  };
  for (const c of d.clashes) {
    for (const s of [c.a, c.b]) {
      const a = get(s.documentId);
      a.el.add(s.ref);
      if (!s.level) (a.lvl.add(s.ref), hit("missing_level", a.doc, s.ref, c.id));
      if (MEP.test(s.category) && !s.system) (a.sys.add(s.ref), hit("missing_system", a.doc, s.ref, c.id));
      if (s.type && GENERIC.test(s.type)) (a.gen.add(s.ref), hit("generic_or_placeholder_types", a.doc, s.ref, c.id));
    }
    if (c.a.documentId === c.b.documentId) {
      get(c.a.documentId).self++;
      hit("self_clashes_same_document", get(c.a.documentId).doc, c.a.ref, c.id);
    }
    if (c.nature === "duplicate") {
      get(c.a.documentId).dup++;
      hit("duplicate_elements", get(c.a.documentId).doc, c.a.ref, c.id);
    }
  }
  return {
    testId,
    byDocument: [...per.values()].map((a) => ({ doc: a.doc, discipline: a.discipline, elementsInClashes: a.el.size, selfClashes: a.self, duplicates: a.dup, missingLevel: a.lvl.size, missingSystem: a.sys.size, genericTypes: a.gen.size })),
    findings: [...findings.values()]
      .map((f) => ({ check: f.check, doc: f.doc, count: f.refs.size, examples: [...f.refs].slice(0, 3), clashesAffected: f.clashes.size }))
      .sort((a, b) => b.count - a.count),
  };
}

export function mockReport(scope: T.ReportScope, tests: GeneratedTest[]): T.ReportData {
  const sorted = [...tests].sort((a, b) => a.test.modelSetVersion - b.test.modelSetVersion);
  const latest = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];
  const active = (t?: GeneratedTest) => (t ? t.clashes.filter((c) => c.status === "active").length : 0);
  const byPair = new Map<string, { active: number; reviewed: number; resolved: number; closed: number }>();
  for (const g of latest?.groups ?? []) {
    const pair = `${g.pair[0]}×${g.pair[1]}`;
    const row = byPair.get(pair) ?? { active: 0, reviewed: 0, resolved: 0, closed: 0 };
    row[g.accStatus] += g.clashIds.length;
    byPair.set(pair, row);
  }
  return {
    scope,
    kpis: {
      activeClashes: active(latest),
      activeClashesPrev: prev ? active(prev) : null,
      groups: latest?.groups.length ?? 0,
      rawClashes: latest?.clashes.length ?? 0,
      groupsReviewed: Math.round((latest?.groups.length ?? 0) * 0.4),
      issuesCreated: 6,
      aiAccepted: 41,
      aiCorrected: 9,
      aiRejected: 3,
      rawClashesReviewed: Math.round((latest?.clashes.length ?? 0) * 0.35),
      actualReviewSeconds: 2460,
    },
    burndown: sorted.map((t) => ({ label: `${t.test.completedOn.slice(0, 10)} · v${t.test.modelSetVersion}`, active: active(t), reviewed: t.clashes.filter((c) => c.status === "reviewed").length, resolved: 0, closed: t.clashes.filter((c) => c.status === "closed").length, valid: t.clashes.filter((c) => c.validity === "real").length })),
    disciplines: [],
    matrix: {},
    byStatusPair: [...byPair.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([pair, v]) => ({ pair, ...v })),
    newVsResolved: sorted.map((t) => ({ label: `v${t.test.modelSetVersion}`, new: t.clashes.filter((c) => c.delta === "new" || c.delta === "reappeared").length, resolved: t.test.delta?.resolved ?? 0 })),
    reasons: [{ code: "R02", count: 4 }, { code: "R09", count: 2 }],
    calibration: [],
    p1Aging: { lt1w: 3, w1to2: 2, w2to4: 1, gt4w: 0 },
  };
}

export const MOCK_REPORT_FILES: T.ReportFile[] = [
  { name: "2026-11-03-weekly-T-3f9a21c0.md", format: "md", kind: "weekly", testKey: "T-3f9a21c0", date: "2026-11-03", size: 2140, modifiedAt: "2026-11-03T18:20:00.000Z" },
  { name: "2026-11-03-weekly-T-3f9a21c0.html", format: "html", kind: "weekly", testKey: "T-3f9a21c0", date: "2026-11-03", size: 3810, modifiedAt: "2026-11-03T18:20:05.000Z" },
  { name: "2026-10-27-hygiene-T-3f9a21c0.md", format: "md", kind: "hygiene", testKey: "T-3f9a21c0", date: "2026-10-27", size: 1210, modifiedAt: "2026-10-27T15:02:00.000Z" },
];

export function mockFeedback(): T.FeedbackRow[] {
  const base = Date.now();
  const rows: Array<[T.FeedbackSource, T.FeedbackRow["verdict"], string, string, string, string]> = [
    ["agent", "incorrect", "real", "tolerated", "CLI×EST", "Pasadas de CLI en vigas del N03 están previstas por plano E-301."],
    ["ui", "incorrect", "false_positive", "real", "SAN×EST", "La tubería atraviesa la losa sin manga: es real."],
    ["decision", "partially_correct", "real", "real", "ELE×ARQ", "Prioridad P2, no P1: no afecta vía de evacuación."],
    ["agent", "correct", "false_positive", "false_positive", "ARQ×ARQ", "Duplicados del vínculo de ARQ, ya informados como higiene."],
    ["ui", "incorrect", "needs_info", "tolerated", "CLI×ARQ", "Aislación de ducto contra cielo: tolerable según especialista."],
  ];
  return rows.map(([source, verdict, ev, cv, pair, statement], i) => ({
    feedbackId: `FB-${String(120 - i).padStart(4, "0")}`,
    at: new Date(base - (i + 1) * 9 * 3600000).toISOString(),
    source,
    verdict,
    testKey: "T-3f9a21c0",
    groupId: `G-${String(40 + i * 7).padStart(4, "0")}`,
    engineValidity: ev,
    correctedValidity: cv,
    disciplinePair: pair,
    ruleIds: i % 2 ? ["PRI-001"] : [],
    statement,
    generalizable: i % 2 ? "yes" : "unsure",
    scope: i % 2 ? "project" : "this_group",
    curated: i > 3,
  }));
}

/** Recompute the size fields of a mock family after a merge / detach. */
export function resizeFamily(f: T.TriageFamily, groups: Map<string, T.FamilyGroup>): void {
  const inst = f.groupIds.map((id) => groups.get(id)).filter((g): g is T.FamilyGroup => !!g);
  f.instanceCount = inst.length;
  f.rawClashCount = inst.reduce((n, g) => n + g.clashIds.length, 0);
  f.uniqueClashCount = inst.reduce((n, g) => n + (g.uniqueClashCount ?? g.clashIds.length), 0);
  f.levels = [...new Set(inst.map((g) => g.location?.level).filter((l): l is string => !!l))].sort();
  refreshFamily(f, groups);
}
