/**
 * The "Grupos" tree and the "Interferencias" list group the SAME clashes
 * differently: for any query the totals must match, every tree node must be
 * the sum of its children, and levels are ordered by importance. Runs on the
 * mock payload and on a v11-shaped variant (raw ACC clashes ≠ unique pairs,
 * P1 items inside the "Conjunto de modelos" / "No es problema" buckets).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PROJECTS } from "../../src/lib/api/mock/fixtures";
import { generateTest } from "../../src/lib/api/mock/generate";
import { applyM1 } from "../../src/lib/api/mock/m1";
import { applyM2 } from "../../src/lib/api/mock/m2";
import { buildIssueChecks } from "../../src/lib/api/mock/m3";
import { buildAgenda } from "../../src/lib/api/mock/m4";
import type { Clash, TriagePayloadWithFamilies } from "../../src/lib/api/types";

// The store and the mock families step use browser APIs (window, import.meta.env): they are
// loaded at runtime so the Node-only server tsconfig (which typechecks tests/) does not walk into them.
const STORE_MODULE: string = "../../src/features/triage/store";
const FAMILIES_MODULE: string = "../../src/lib/api/mock/families";
/* eslint-disable @typescript-eslint/no-explicit-any */
let TriageStore: any;
let deriveFamilies: any;
type ListQuery = { filters: Record<string, string[]>; sort: string; q: string; view: string; docs?: string; lens?: string };
interface TreeNode { id: string; depth: number; bucket: string; familyIds: string[]; instanceCount: number; clashCount: number; worst: number | null }
interface StoreLike {
  state: {
    rows: { kind: string; depth?: number; id: string }[];
    nodes: Map<string, TreeNode>;
    familyStats: Map<string, { clashCount: number; instanceCount: number }>;
    families: Map<string, { groupIds: string[] }>;
    visibleByGroup: Map<string, unknown[]>;
    hiddenByGroup: Map<string, unknown[]>;
    lensCounts: { cambios: number; todo: number };
    openQuestionByGroup: Map<string, string>;
    groups: Map<string, { change?: string; inherited?: unknown }>;
    checked: Set<string>;
    summary: { groups: number; locations: number; clashes: number; changed?: number; issues?: { total: number; resolved: number; saysResolved: number }; meeting?: { topics: number; disciplines: number } };
  };
  familiesMode(): boolean;
  effectiveLens(): string;
  hasPrevious(): boolean;
  load(p: unknown): void;
  selectionMembers(key: string): { members: unknown[] };
  toggleCheckSubtree(key: string): void;
  setIssueChecks(checks: unknown[], version?: number): void;
  setAgenda(disciplines: unknown[]): void;
  agendaSize(): number;
  toggleCheck(key: string): void;
  checkState(key: string): string;
}

let mock: TriagePayloadWithFamilies;
let sandbox: TriagePayloadWithFamilies;
let v11: TriagePayloadWithFamilies;

/** Same data path as the mock API: generated test + the mock F1 families step. */
function payloadFor(projectId: string): TriagePayloadWithFamilies {
  const project = PROJECTS.find((p) => p.id === projectId)!;
  const ms = project.modelSets[0];
  const opts = ms.tests[0];
  const d = generateTest({ ...opts, analyzed: true });
  const f = deriveFamilies(d.groups, d.clashes, d.proposals) as { groups: Parameters<typeof applyM1>[1]; families: unknown[] };
  const m1 = applyM1(d.test, f.groups, d.clashes, !!opts.firstTest);
  const m2 = applyM2(d.test, f.groups, !!opts.firstTest);
  if (m1.changeSummary) m1.changeSummary.baseVersion = m2.baseVersion;
  return {
    project: { id: project.id },
    modelSet: { id: ms.id },
    test: d.test,
    tests: [],
    disciplines: [],
    groups: f.groups,
    families: f.families,
    problemTypes: [],
    clashes: d.clashes,
    proposals: d.proposals,
    decisions: [],
    changesCursor: "0",
    changeSummary: m1.changeSummary,
    scopeChanges: m1.scopeChanges,
    questions: m2.questions,
  } as unknown as TriagePayloadWithFamilies;
}

/** v11 shape: MECHANICAL loaded twice → every clash of half the groups appears 2–3× in ACC (raw), unique stays the same. */
function v11Shaped(p: TriagePayloadWithFamilies): TriagePayloadWithFamilies {
  const out = structuredClone(p);
  const extra: Clash[] = [];
  out.groups.forEach((g, i) => {
    g.uniqueClashCount = g.clashIds.length;
    if (i % 2) return;
    const copies = 1 + (i % 3 === 0 ? 1 : 0);
    for (const id of [...g.clashIds]) {
      const c = out.clashes.find((x) => x.id === id)!;
      for (let k = 0; k < copies; k++) {
        const dup = { ...c, id: `${c.id}-dup${k}` };
        extra.push(dup);
        g.clashIds.push(dup.id);
      }
    }
  });
  out.clashes.push(...extra);
  // Important items in the special buckets: they must not be pushed to the end.
  for (const f of out.families ?? []) {
    if (f.bucket === "pair") continue;
    for (const gid of f.groupIds) {
      const g = out.groups.find((x) => x.id === gid);
      if (g) g.priority = 1;
    }
  }
  out.proposals = out.proposals.map((pr) => (out.families?.some((f) => f.bucket !== "pair" && f.groupIds.includes(pr.targetId)) ? { ...pr, fields: { ...pr.fields, priority: { ...pr.fields.priority, value: 1 } } } : pr));
  out.decisions = [];
  return out;
}

const api = {};
const q = (over: Partial<ListQuery> = {}): ListQuery => ({ filters: { decision: ["pendiente"] }, sort: "priority", q: "", view: "families", ...over });

function both(payload: TriagePayloadWithFamilies, query: ListQuery): { tree: StoreLike; list: StoreLike } {
  const tree = new TriageStore(api, query);
  tree.load(payload);
  const list = new TriageStore(api, { ...query, view: "clashes" });
  list.load(payload);
  return { tree, list };
}

beforeAll(async () => {
  ({ TriageStore } = await import(/* @vite-ignore */ STORE_MODULE));
  ({ deriveFamilies } = await import(/* @vite-ignore */ FAMILIES_MODULE));
  mock = payloadFor("3f2a9c1e-7b4d-4e2a-9f10-5c8e2b7d1a01"); // Torre B
  sandbox = payloadFor("da524c2d-6e11-4357-a82d-63244776d979"); // Sandbox v11 (the live project, mock data)
  v11 = v11Shaped(sandbox);
});

describe("tree vs Interferencias totals", () => {
  const queries: [string, Partial<ListQuery>][] = [
    ["pendientes (default)", {}],
    ["todo", { filters: { decision: [] } }],
    ["válidas P1–P2", { filters: { decision: [], validity: ["valida"], priority: ["1", "2"] } }],
    ["búsqueda", { filters: { decision: [] }, q: "Nivel" }],
  ];
  for (const [name, fixture] of [["mock Torre B", () => mock], ["mock Sandbox v11", () => sandbox], ["v11-shaped (raw duplicates)", () => v11]] as const) {
    for (const [label, over] of queries)
      for (const lens of ["todo", "cambios"]) {
      it(`${name} · ${label} · lente ${lens}: same grupos · ubicaciones · interferencias`, () => {
        const { tree, list } = both(fixture(), q({ ...over, lens }));
        expect(tree.familiesMode()).toBe(true);
        expect(list.state.rows.length).toBe(list.state.summary.clashes);
        expect(tree.state.summary).toEqual(list.state.summary);
        // The collapsed "N sin cambios" row is outside the lens totals.
        const roots = [...tree.state.nodes.values()].filter((n) => n.depth === 0 && n.bucket !== "unchanged");
        expect(roots.reduce((s, n) => s + n.clashCount, 0)).toBe(list.state.rows.length);
        expect(roots.reduce((s, n) => s + n.instanceCount, 0)).toBe(list.state.summary.locations);
        expect(tree.state.lensCounts).toEqual(list.state.lensCounts);
      });
      }
    it(`${name}: docs filter applies identically`, () => {
      const c = fixture().clashes[0];
      const docs = `${c.a.documentId},${c.b.documentId}`;
      const { tree, list } = both(fixture(), q({ filters: { decision: [] }, docs }));
      expect(list.state.rows.length).toBeGreaterThan(0);
      expect(tree.state.summary).toEqual(list.state.summary);
    });
  }

  it("counts raw ACC clashes, not unique pairs", () => {
    const { tree } = both(v11, q({ filters: { decision: [] }, lens: "todo" }));
    expect(tree.state.summary.clashes).toBe(v11.clashes.length);
    const unique = v11.groups.reduce((s, g) => s + (g.uniqueClashCount ?? 0), 0);
    expect(tree.state.summary.clashes).toBeGreaterThan(unique);
  });
});

describe("tree structure", () => {
  it("every node is the sum of its children", () => {
    const { tree } = both(v11, q({ filters: { decision: [] }, lens: "todo" }));
    const s = tree.state;
    for (const n1 of [...s.nodes.values()].filter((n) => n.depth === 0 && n.bucket !== "loose")) {
      const kids = [...s.nodes.values()].filter((n) => n.depth === 1 && n.id.startsWith(`${n1.id}|`));
      expect(kids.reduce((x, k) => x + k.clashCount, 0)).toBe(n1.clashCount);
      for (const k of kids) {
        const fams = k.familyIds.map((id) => s.familyStats.get(id)!);
        expect(fams.reduce((x, f) => x + f.clashCount, 0)).toBe(k.clashCount);
        expect(fams.reduce((x, f) => x + f.instanceCount, 0)).toBe(k.instanceCount);
      }
    }
  });

  it("orders by importance across buckets (worst priority first)", () => {
    const { tree } = both(v11, q({ filters: { decision: [] }, lens: "todo" }));
    const l1 = tree.state.rows.filter((r) => r.kind === "node" && r.depth === 0).map((r) => tree.state.nodes.get(r.id)!);
    const worst = l1.map((n) => n.worst ?? 9);
    expect(worst).toEqual([...worst].sort((a, b) => a - b));
    const special = l1.findIndex((n) => n.bucket !== "pair" && n.bucket !== "loose");
    if (special >= 0) expect(l1[special].worst).toBe(1);
    // A P1 bucket is not after a lower-priority pair node.
    const firstNonP1 = worst.findIndex((w) => w > 1);
    if (special >= 0 && firstNonP1 >= 0) expect(special).toBeLessThan(firstNonP1);
  });

  it("a node selects (viewer) and checks (checkbox) its whole subtree", () => {
    const { tree } = both(v11, q({ filters: { decision: [] }, lens: "todo" }));
    const s = tree.state;
    const n1 = [...s.nodes.values()].find((n) => n.depth === 0)!;
    expect(tree.selectionMembers(`n:${n1.id}`).members.length).toBe(n1.clashCount);
    const fid = n1.familyIds[0];
    const f = s.families.get(fid)!;
    expect(tree.selectionMembers(`f:${fid}`).members.length).toBe(s.familyStats.get(fid)!.clashCount);
    tree.toggleCheckSubtree(`f:${fid}`);
    expect(tree.checkState(`f:${fid}`)).toBe("all");
    const visible = f.groupIds.filter((g) => tree.state.visibleByGroup.has(g));
    for (const g of visible) expect(tree.state.checked.has(`g:${g}`)).toBe(true);
    if (visible.length > 1) {
      tree.toggleCheck(`g:${visible[0]}`);
      expect(tree.checkState(`f:${fid}`)).toBe("some");
      expect(tree.checkState(`n:${n1.id}`)).toBe("some");
    }
    tree.toggleCheckSubtree(`n:${n1.id}`);
    expect(tree.checkState(`n:${n1.id}`)).toBe("all");
  });
});

describe("lens Qué cambió", () => {
  it("the (N nuevas) bracket equals changeSummary new + changed + reappeared, identical in both views", () => {
    for (const fixture of [mock, sandbox]) {
      const cs = (fixture as unknown as { changeSummary: { clashes: Record<string, number> } }).changeSummary.clashes;
      const expected = cs.new + cs.changed + cs.reappeared;
      const { tree, list } = both(fixture, q({ filters: { decision: [] }, lens: "cambios" }));
      expect(tree.state.summary.changed).toBe(expected);
      expect(list.state.summary.changed).toBe(expected);
      expect(tree.state.lensCounts.cambios).toBe(expected);
      expect(list.state.lensCounts.cambios).toBe(expected);
      expect(tree.state.summary.clashes).toBeGreaterThanOrEqual(expected);
      // No bracket outside the lens.
      expect(both(fixture, q({ filters: { decision: [] }, lens: "todo" })).tree.state.summary.changed).toBeUndefined();
    }
  });

  it("defaults to Qué cambió when there is a previous version", () => {
    const { tree } = both(sandbox, q({ filters: { decision: [] } }));
    expect(tree.hasPrevious()).toBe(true);
    expect(tree.effectiveLens()).toBe("cambios");
  });

  it("changed + hidden (sin cambios) = Todo, in clashes and ubicaciones", () => {
    for (const fixture of [mock, sandbox, v11]) {
      const todo = both(fixture, q({ filters: { decision: [] }, lens: "todo" })).tree;
      const { tree } = both(fixture, q({ filters: { decision: [] }, lens: "cambios" }));
      const hidden = [...tree.state.hiddenByGroup.values()];
      expect(tree.state.summary.locations + hidden.length).toBe(todo.state.summary.locations);
      expect(tree.state.summary.clashes + hidden.reduce((n: number, l) => n + l.length, 0)).toBe(todo.state.summary.clashes);
      // Tab count = the "(N nuevas)" bracket = clashes that actually changed.
      expect(tree.state.lensCounts.cambios).toBe(tree.state.summary.changed);
      const unchanged = tree.state.nodes.get("unchanged");
      if (hidden.length) expect(unchanged?.instanceCount).toBe(hidden.length);
    }
  });

  it("reappeared items sort first at the top level", () => {
    const { tree } = both(sandbox, q({ filters: { decision: [] }, lens: "cambios" }));
    const l1 = tree.state.rows.filter((r) => r.kind === "node" && r.depth === 0).map((r) => tree.state.nodes.get(r.id)!);
    const flags = l1.filter((n) => n.bucket !== "unchanged").map((n) => ((n as unknown as { reappeared: number }).reappeared > 0 ? 1 : 0));
    expect(flags).toEqual([...flags].sort((a, b) => b - a));
  });
});

describe("M2: inherited decisions and agent questions", () => {
  it("an open question brings its ubicación into Qué cambió even when unchanged; inherited unchanged items stay under sin cambios", () => {
    const { tree, list } = both(sandbox, q({ filters: { decision: [] }, lens: "cambios" }));
    // 3 questions; the action one decides 5 ubicaciones of a grupo (confirmation case).
    expect(new Set(tree.state.openQuestionByGroup.values()).size).toBe(3);
    expect(tree.state.openQuestionByGroup.size).toBeGreaterThan(3);
    const unchangedWithQuestion = [...tree.state.openQuestionByGroup.keys()].filter((g) => tree.state.groups.get(g)?.change === "unchanged");
    expect(unchangedWithQuestion.length).toBeGreaterThan(0);
    for (const g of tree.state.openQuestionByGroup.keys()) expect(tree.state.visibleByGroup.has(g)).toBe(true);
    const inheritedUnchanged = [...tree.state.groups].filter(([id, g]) => g.inherited && g.change === "unchanged" && !tree.state.openQuestionByGroup.has(id)).map(([id]) => id);
    expect(inheritedUnchanged.length).toBeGreaterThan(0);
    for (const g of inheritedUnchanged) {
      expect(tree.state.visibleByGroup.has(g)).toBe(false);
      expect(tree.state.hiddenByGroup.has(g)).toBe(true);
    }
    // Same totals in both views with the question items included.
    expect(tree.state.summary).toEqual(list.state.summary);
  });
});

describe("M3: lens Incidencias", () => {
  it("issue rows, discipline nodes and the summary are identical in both views", () => {
    const fx = sandbox as unknown as { test: Parameters<typeof buildIssueChecks>[0]; groups: Parameters<typeof buildIssueChecks>[1]; proposals: Parameters<typeof buildIssueChecks>[2] };
    const { checks } = buildIssueChecks(fx.test, fx.groups, fx.proposals);
    expect(checks.length).toBeGreaterThanOrEqual(2);
    const { tree, list } = both(sandbox, q({ filters: { decision: [] }, lens: "incidencias" }));
    tree.setIssueChecks(checks);
    list.setIssueChecks(checks);
    expect(tree.effectiveLens()).toBe("incidencias");
    const issueRows = tree.state.rows.filter((r) => r.kind === "issue");
    expect(issueRows.length).toBe(checks.length);
    expect(tree.state.summary.issues).toEqual(list.state.summary.issues);
    expect(tree.state.summary.issues?.total).toBe(checks.length);
    // Interferencias rows = clashes of the issue ubicaciones under the filters = the clashes the tree holds.
    expect(list.state.rows.length).toBe(tree.state.summary.clashes);
    // Follow-up order: a "dice_resuelta" issue comes first when there is one.
    const first = checks.find((c) => c.issueId === issueRows[0].id)!;
    if (checks.some((c) => c.verdict === "dice_resuelta")) expect(first.verdict).toBe("dice_resuelta");
    const discs = tree.state.rows.filter((r) => r.kind === "node" && r.depth === 0);
    expect(discs.length).toBe(new Set(checks.map((c) => c.discipline)).size);
  });

  it("without issue checks the lens falls back to Todo", () => {
    const { tree } = both(sandbox, q({ filters: { decision: [] }, lens: "incidencias" }));
    expect(tree.effectiveLens()).toBe("todo");
  });
});

describe("M4: lens Reunión", () => {
  it("the agenda tree, the summary and the clash rows agree in both views", () => {
    const fx = sandbox as unknown as { test: Parameters<typeof buildAgenda>[0]; families: Parameters<typeof buildAgenda>[1]; groups: Parameters<typeof buildAgenda>[2]; proposals: Parameters<typeof buildIssueChecks>[2] };
    const { checks } = buildIssueChecks(fx.test, fx.groups, fx.proposals);
    const { disciplines } = buildAgenda(fx.test, fx.families, fx.groups, checks);
    const topics = disciplines.reduce((n, d) => n + d.items.length, 0);
    expect(topics).toBeGreaterThan(0);
    const { tree, list } = both(sandbox, q({ filters: { decision: [] }, lens: "reunion" }));
    for (const st of [tree, list]) {
      st.setIssueChecks(checks);
      st.setAgenda(disciplines);
    }
    expect(tree.effectiveLens()).toBe("reunion");
    expect(tree.state.summary.meeting).toEqual({ topics, disciplines: disciplines.length });
    expect(list.state.summary.meeting).toEqual(tree.state.summary.meeting);
    // Interferencias rows = clashes of the agenda ubicaciones = the clashes the tree holds.
    expect(list.state.rows.length).toBe(tree.state.summary.clashes);
    // One top-level row per discipline, in the server order; item rows follow the agenda.
    const l1 = tree.state.rows.filter((r) => r.kind === "node" && r.depth === 0).map((r) => r.id);
    expect(l1).toEqual(disciplines.map((d) => `agenda:${d.discipline}`));
    const itemRows = tree.state.rows.filter((r) => r.depth === 1);
    expect(itemRows.length).toBeGreaterThan(0);
    expect(itemRows.length).toBeLessThanOrEqual(topics + tree.state.rows.filter((r) => r.kind === "group" && r.depth === 1).length);
  });

  it("without an agenda the lens falls back to Todo", () => {
    const { tree } = both(sandbox, q({ filters: { decision: [] }, lens: "reunion" }));
    expect(tree.effectiveLens()).toBe("todo");
  });
});
