/**
 * Regressions from the first real ACC model set (anonymised: no real file,
 * element or project names): discipline mapping, clash grid, ingest phases,
 * test-list enrichment, group titles / linked twins, ruleId per group,
 * property cache and null Index fields.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrichElement } from "../../core/enrich/element";
import type { ElementProps, NormalizedClash } from "../../core/types";
import { FieldDictionary } from "../../server/aps/property-mapping";
import { PropertyRowCache, mapLimit } from "../../server/cache/property-cache";
import type { Coordinator } from "../../server/coordinator";
import { inCode, outCode, resolveDocument, ruleMatches, SIN, suggestedToken, type ProjectDisciplines } from "../../server/disciplines";
import { loadRules, runEngine } from "../../server/engine";
import { linkedElementUid, normalizeLinkedExternalIds } from "../../server/group-titles";
import { clash, doc, el } from "../engine/helpers";
import { CoordinatorUi, HUMAN, ingest, makeCoord, MODEL_SET_ID, tempHome, testConfig, TEST_V42 } from "./helpers";

const P = "demo-proyecto";
const rs = loadRules();
const cfg0: ProjectDisciplines = { version: 0, assignments: {}, rules: [] };
const rule = (id: string, value: string, discipline: string, field: "fileName" | "viewName" = "fileName") => ({ id, match: "contains" as const, value, field, discipline, createdBy: "t", createdAt: "2026-01-01T00:00:00Z" });

describe("discipline resolution (pure)", () => {
  const d = { documentId: 0, lineageUrn: "urn:l:1", fileName: "Edificio-Mecánica-Nivel.rvt", viewName: "{3D}" };

  it("precedence: assignment > rule (first match) > matrix (only when enabled) > elements ≥ 80% > SIN", () => {
    const counts = new Map([["CLI", 9], ["EST", 1]]);
    expect(resolveDocument(d, { ...cfg0, assignments: { "urn:l:1": "ELE" }, rules: [rule("DR-001", "mecanica", "CLI")] }, rs, true, counts)).toEqual({ discipline: "ELE", source: "assignment" });
    // accent/case-insensitive, first match wins
    expect(resolveDocument(d, { ...cfg0, rules: [rule("DR-001", "MECANICA", "CLI"), rule("DR-002", "edificio", "ARQ")] }, rs, false, counts)).toEqual({ discipline: "CLI", source: "rule", ruleId: "DR-001" });
    expect(resolveDocument(d, cfg0, rs, false, counts)).toEqual({ discipline: "CLI", source: "elements", share: 0.9 });
    expect(resolveDocument(d, cfg0, rs, false, new Map([["CLI", 7], ["EST", 3]]))).toEqual({ discipline: SIN, source: "unassigned", share: 0.7 });
    expect(resolveDocument(d, cfg0, rs, false, undefined)).toEqual({ discipline: SIN, source: "unassigned" });
    // matrix tokens only when fileNameDetection = "matrix"
    const iso = { ...d, fileName: "PRJ-EST-MOD-001.rvt" };
    expect(resolveDocument(iso, cfg0, rs, true, undefined)).toEqual({ discipline: "EST", source: "matrix" });
    expect(resolveDocument(iso, cfg0, rs, false, undefined).source).toBe("unassigned");
  });

  it("UNK is accepted as input and never shown", () => {
    expect(inCode("unk")).toBe(SIN);
    expect(outCode("UNK")).toBe(SIN);
    expect(outCode(undefined)).toBe(SIN);
    expect(outCode("CLI")).toBe("CLI");
  });

  it("rules match on file name, view name; regex is case-insensitive", () => {
    expect(ruleMatches({ match: "startsWith", value: "edificio", field: "fileName" }, d)).toBe(true);
    expect(ruleMatches({ match: "regex", value: "^edificio-.*\\.rvt$", field: "fileName" }, d)).toBe(true);
    expect(ruleMatches({ match: "contains", value: "3d", field: "viewName" }, d)).toBe(true);
    expect(ruleMatches({ match: "contains", value: "x", field: "folder" }, d)).toBe(false);
  });

  it("suggestedToken: ISO role code, else the word that tells the file apart (no English dictionary)", () => {
    expect(suggestedToken("MECHANICAL.rvt")).toBe("MECH");
    expect(suggestedToken("PRJ-ARQ-MOD-001.rvt", ["PRJ-ARQ-MOD-001.rvt", "PRJ-EST-MOD-001.rvt", "PRJ-CLI-MOD-001.rvt"])).toBe("ARQ");
    expect(suggestedToken("PRJ-ZZ-01-XX-M3-CL-0001.rvt")).toBe("CL");
    expect(suggestedToken("123.ifc")).toBeUndefined();
  });

  it("element layer is naming-independent: pipes need a system, structural floors are EST", () => {
    const facts = (category: string, extra: Record<string, unknown> = {}) =>
      enrichElement(rs, { category, documentName: "PRJ-SAN-MOD-001.rvt", modelDisciplineOverride: null, strictCategoryDiscipline: true, ...extra }).discipline;
    expect(facts("Ducts")).toBe("CLI");
    expect(facts("Structural Framing")).toBe("EST");
    expect(facts("Cable Tray")).toBe("ELE");
    expect(facts("Sprinklers")).toBe("INC");
    expect(facts("Walls")).toBe("ARQ");
    expect(facts("Pipes")).toBe("UNK"); // ambiguous without a system → SIN in outputs
    expect(facts("Floors", { structural: true })).toBe("EST");
    // file name ignored when the project mapping decides nothing
    expect(enrichElement(rs, { category: "Pipes", documentName: "PRJ-SAN-MOD-001.rvt", modelDisciplineOverride: null, strictCategoryDiscipline: true }).modelDiscipline).toBeUndefined();
  });
});

describe("group titles and linked twins (anonymised extract)", () => {
  // Doc 0: structure. Doc 1: MEP model whose published view includes the linked structure.
  const LINK = "0a1b2c3d-0000-4000-8000-00000000abcd-0001f00d";
  const beamUid = (i: number) => `beam-uid-${i}`;
  const docs = [doc(0, "Modelo-A.rvt"), doc(1, "Modelo-B.rvt")];
  const elements: ElementProps[] = [];
  const clashes: NormalizedClash[] = [];
  let id = 1;
  for (let b = 0; b < 3; b++) {
    elements.push(el(0, 100 + b, { externalId: beamUid(b), elementId: String(9000 + b), category: "Structural Framing", type: "Viga 300x600", level: "Nivel 2" }));
    elements.push(el(1, 500 + b, { externalId: `${LINK}/${beamUid(b)}`, elementId: String(9000 + b), category: "Structural Framing", type: "Viga 300x600", level: "Nivel 2" }));
    for (let k = 0; k < 4; k++) {
      const duct = 1000 + b * 10 + k;
      elements.push(el(1, duct, { category: "Ducts", type: "Ducto rectangular", level: "Nivel 2", systemClassification: "Supply Air", widthMm: 400, heightMm: 300 }));
      clashes.push(clash(id++, [1, duct], [0, 100 + b], -80)); // duct × beam (structure model)
      clashes.push(clash(id++, [1, duct], [1, 500 + b], -80)); // duct × same beam via the link
    }
  }
  const run = (els: readonly ElementProps[], cl: readonly NormalizedClash[]) =>
    runEngine({ clashes: cl, elements: els, documents: docs, config: testConfig().config, rules: rs });

  it("linked externalIds reduce to the element uid", () => {
    expect(linkedElementUid(`${LINK}/abc`)).toBe("abc");
    expect(linkedElementUid("plain-uid")).toBeUndefined();
    const n = normalizeLinkedExternalIds([el(1, 1, { externalId: `${LINK}/abc` })]);
    expect(n[0]!.externalId).toBe("abc");
    expect(n[0]!.raw?.["__coord/linkedExternalId"]).toBe(`${LINK}/abc`);
  });

  it("twin clashes through the link merge instead of creating duplicate groups; titles are unique", () => {
    const withTwins = run(elements, clashes);
    const direct = run(elements.filter((e) => !String(e.externalId).startsWith(LINK)), clashes.filter((c) => c.right.documentId === 0));
    expect(withTwins.groups.length).toBe(direct.groups.length);
    expect(withTwins.groups.length).toBe(3); // one per beam, not six
    for (const g of withTwins.groups) expect(g.clashIds).toHaveLength(8); // both MC clash ids kept
    const titles = withTwins.groups.map((g) => g.title);
    expect(new Set(titles).size).toBe(titles.length);
    // every clash lands in exactly one group
    const seen = new Set<string>();
    for (const g of withTwins.groups) for (const c of g.clashIds) {
      expect(seen.has(c)).toBe(false);
      seen.add(c);
    }
  });

  it("a merged twin listed in the opposite left/right order keeps each element's own facts", () => {
    // ACC lists the twin through the link as beam (left) × duct (right): reversed vs the representative.
    const reversed = clashes.map((c) => (c.right.documentId === 1 ? { ...c, left: c.right, right: c.left } : c));
    const res = run(elements, reversed);
    expect(res.clashes.length).toBe(reversed.length);
    for (const c of res.clashes) {
      for (const s of [c.a, c.b]) {
        const isDuct = s.documentId === 1 && s.dbId >= 1000; // ducts are doc 1, dbIds 1000+ in this extract
        expect(s.category).toBe(isDuct ? "Ducts" : "Structural Framing");
        expect(s.discipline).toBe(isDuct ? "CLI" : "EST");
      }
    }
  });

  it("legitimate per-element splits get the element identity in the title", () => {
    const direct = run(elements.filter((e) => !String(e.externalId).startsWith(LINK)), clashes.filter((c) => c.right.documentId === 0));
    const titles = direct.groups.map((g) => g.title);
    expect(new Set(titles).size).toBe(titles.length);
    if (direct.groups.length > 1) expect(titles.some((t) => /9000|9001|9002|\(\d+\/\d+\)/.test(t))).toBe(true);
    // output never shows UNK
    expect(titles.join(" ")).not.toMatch(/\bUNK\b/);
  });
});

describe("clash grid, test list, disciplines API (fixtures)", () => {
  let home: string;
  let cleanup: () => void;
  let coord: Coordinator;
  let ui: CoordinatorUi;
  let k41: string;
  let k42: string;
  beforeAll(async () => {
    ({ home, cleanup } = tempHome());
    coord = makeCoord(home);
    ui = new CoordinatorUi(coord);
  });
  afterAll(() => cleanup());

  it("grid state is none before ingest, counts after phase 1, classified after classification", async () => {
    expect((await ui.clashGrid(P, MODEL_SET_ID, TEST_V42)).state).toBe("none");
    const phases: string[] = [];
    k41 = await ingest(coord, 41);
    const r = await coord.ingest({ projectId: P, modelSetId: MODEL_SET_ID, testId: TEST_V42 }, undefined, undefined, (ph) => phases.push(ph));
    k42 = r.testKey;
    expect(phases[0]).toBe("downloading");
    expect(phases).toContain("clash_grid_ready");
    expect(phases).toContain("properties");
    const counts = await ui.clashGrid(P, MODEL_SET_ID, k42);
    expect(counts.state).toBe("counts");
    expect(counts.cells.every((c) => c.groups === 0 && c.real === 0 && c.p1 === 0)).toBe(true);
    await coord.classify({ testKey: k42 });
    const g = await ui.clashGrid(P, MODEL_SET_ID, TEST_V42); // by ACC test id
    expect(g.state).toBe("classified");
    expect(g.testKey).toBe(k42);
    expect(g.cells.every((c) => c.a <= c.b)).toBe(true);
    const total = g.cells.reduce((n, c) => n + c.clashes, 0);
    expect(total).toBe((await coord.store.getTest(k42))!.counts.clashes);
    expect(g.cells.some((c) => c.groups > 0)).toBe(true);
    expect(g.cells.reduce((n, c) => n + c.newSinceLast, 0)).toBeGreaterThan(0);
    for (const d of g.documents) {
      expect(["assignment", "rule", "matrix", "elements", "unassigned"]).toContain(d.disciplineSource);
      expect(d.discipline).not.toBe("UNK");
    }
  });

  it("test list carries state, documentCount and delta from the ledger; views listed", async () => {
    const tests = await ui.tests(P, MODEL_SET_ID);
    const t42 = tests.find((t) => t.id === k42)!;
    expect(t42).toMatchObject({ state: "classified", documentCount: 8 });
    expect(t42.delta!.new + t42.delta!.persisting).toBeGreaterThan(0);
    expect(tests.find((t) => t.id === k41)!.delta).toBeUndefined();
    const views = await ui.modelSetViews(P, MODEL_SET_ID);
    expect(views[0]!.documents.length).toBeGreaterThan(0);
  });

  it("every triage group carries its dominant ruleId", async () => {
    const tri = await ui.triage(P, MODEL_SET_ID);
    expect(tri.groups.length).toBeGreaterThan(0);
    for (const g of tri.groups) {
      expect(g.ruleId).toBeTruthy();
      expect(g.ruleIds[0]).toBe(g.ruleId);
    }
  });

  it("assigning a document re-classifies cached tests and returns the grid; rule creation, preview and replace", async () => {
    const before = await ui.clashGrid(P, MODEL_SET_ID, k42);
    const target = before.documents.find((d) => d.disciplineSource === "unassigned") ?? before.documents[0]!;
    const g = await ui.setDocumentDiscipline(P, MODEL_SET_ID, target.lineageUrn, { discipline: "san", createRule: { match: "contains", value: "-SAN-", field: "fileName" } }, HUMAN, k42);
    for (const d of g.documents.filter((x) => x.lineageUrn === target.lineageUrn)) expect(d).toMatchObject({ discipline: "SAN", disciplineSource: "assignment" });
    const cfg = await ui.disciplineConfig(P);
    expect(cfg.version).toBe(1);
    expect(cfg.rules).toHaveLength(1);
    expect(cfg.rules[0]).toMatchObject({ id: "DR-001", discipline: "SAN", createdBy: HUMAN.name });
    expect(cfg.codes.map((c) => c.code)).toContain(SIN);
    expect(cfg.codes.map((c) => c.code)).not.toContain("UNK");
    // classification of the older version was re-run too
    expect((await coord.store.getTest(k41))!.documents.find((d) => d.lineageUrn === target.lineageUrn)!.disciplineSource).toBe("assignment");

    const pv = await ui.previewDisciplineRules(P, [
      { match: "contains", value: "-est-", field: "fileName", discipline: "EST" },
      { match: "contains", value: "prj", field: "fileName", discipline: "ARQ" },
    ]);
    expect(pv.rules[0]!.matches.length).toBeGreaterThan(0);
    expect(pv.rules[1]!.effective).toBe(pv.rules[1]!.matches.length - pv.rules[0]!.effective);
    expect((await ui.disciplineConfig(P)).version).toBe(1); // preview changes nothing

    const rep = await ui.replaceDisciplineRules(P, [{ id: "DR-001", match: "contains", value: "-EST-", field: "fileName", discipline: "EST" }], HUMAN);
    expect(rep.rules[0]!.id).toBe("DR-001");
    expect(rep.reclassified).toEqual(expect.arrayContaining([k41, k42]));
    const est = (await ui.clashGrid(P, MODEL_SET_ID, k42)).documents.filter((d) => d.fileName.includes("-EST-"));
    for (const d of est) expect(d).toMatchObject({ discipline: "EST", disciplineSource: "rule", ruleId: "DR-001" });
    await expect(ui.setDocumentDiscipline(P, MODEL_SET_ID, target.lineageUrn, { discipline: "XYZ" }, HUMAN)).rejects.toThrow(/desconocida/);
    await expect(ui.setDocumentDiscipline(P, MODEL_SET_ID, "urn:none", { discipline: "EST" }, HUMAN)).rejects.toThrow(/no encontrado/);
  });

  it("the agent can only PROPOSE a mapping; a human accepts or rejects it", async () => {
    const list = await coord.listDisciplines({ testKey: k42 });
    expect(list.documents!.length).toBe(8);
    const doc0 = list.documents!.find((d) => d.source !== "assignment")!;
    const p = await coord.proposeDisciplineMapping({ testKey: k42, documentId: doc0.documentId, discipline: "ELE", rationale: "Categorías eléctricas dominan." });
    expect(p.kind).toBe("discipline_mapping");
    // nothing changed yet
    expect((await ui.disciplineConfig(P)).assignments[doc0.lineageUrn!]).toBeUndefined();
    expect((await ui.disciplineConfig(P)).pendingProposals.map((x) => x.id)).toContain(p.proposalId);
    const after = await ui.decideDisciplineProposal(P, p.proposalId, "accept", HUMAN);
    expect(after.assignments[doc0.lineageUrn!]).toBe("ELE");
    expect(after.pendingProposals).toHaveLength(0);
    const p2 = await coord.proposeDisciplineMapping({ testKey: k42, discipline: "INC", rule: { match: "contains", value: "-INC-", field: "fileName" }, rationale: "Rociadores." });
    const rej = await ui.decideDisciplineProposal(P, p2.proposalId, "reject", HUMAN);
    expect(rej.rules.some((r) => r.value === "-INC-")).toBe(false);
    await expect(coord.proposeDisciplineMapping({ testKey: k42, discipline: "ELE", rationale: "x" })).rejects.toThrow(/documentId o rule/);
  });

  it("level 0 cannot even propose", async () => {
    const t = tempHome();
    try {
      const c0 = makeCoord(t.home, { config: testConfig({}, 0) });
      const k = await ingest(c0, 42);
      await expect(c0.proposeDisciplineMapping({ testKey: k, documentId: 0, discipline: "ARQ", rationale: "x" })).rejects.toThrow();
    } finally {
      t.cleanup();
    }
  });
});

describe("property fetch plumbing", () => {
  it("Index fields with a null category/name do not crash the dictionary", () => {
    const dict = new FieldDictionary([
      { key: "p1", category: null, type: "String", name: null, uom: null },
      { key: "p2", category: null, type: "String", name: "Level", uom: null },
      { key: "p3", category: "__category__", type: "String", name: "Level", uom: null },
    ]);
    expect(dict.keysFor(["Level"])).toEqual(["p2"]);
  });

  it("PropertyRowCache keeps rows, absent ids and metadata per seed version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pcache-"));
    try {
      const c = new PropertyRowCache(dir);
      const seed = "urn:seed:v1";
      expect((await c.get(seed)).rows.size).toBe(0);
      await c.putMeta(seed, { fields: [{ key: "p1", category: "x", type: "String", name: "n", uom: null }], views: { a: "b" } });
      await c.addRows(seed, [{ lmvId: 1, props: {} } as never, { lmvId: 2, props: {} } as never], [3], new Set());
      await c.addRows(seed, [], [4], new Set([3]));
      const got = await c.get(seed);
      expect([...got.rows.keys()].sort()).toEqual([1, 2]);
      expect([...got.absent].sort()).toEqual([3, 4]);
      expect(got.fields).toHaveLength(1);
      expect((await c.get("urn:seed:v2")).rows.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mapLimit bounds concurrency and keeps order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, x));
      inFlight--;
      return x * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });
});
