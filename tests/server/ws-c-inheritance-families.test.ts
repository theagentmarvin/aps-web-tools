/**
 * ws-C (docs/domain/coordinator-journey-2026-11.md):
 *  G7  inherited decisions are re-asked only by policy; bulk "Confirmar heredadas sin cambio"
 *      (typed count, separate acknowledgements, audited per item) + the agent's proposal (parity);
 *  G16 coarser family signature v7; old family decisions map onto the new families or surface as "revisar";
 *  G23 pair label and responsible use the system discipline of the MEP element.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Decision } from "../../server/api/contract";
import type { ClassifiedClash } from "../../core/classified";
import { physicalSignature, systemDisciplineOf, upgradeParts } from "../../core/families";
import type { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { inheritPolicyReasons, legacyFamilyMapping, systemPair, type ModelSetFamilies } from "../../server/families";
import type { FamilyRecord, GroupRecord } from "../../server/store/types";
import { HUMAN, ingest, makeCoord, MODEL_SET_ID, tempHome } from "./helpers";

const P = "demo-proyecto";
let cleanup: () => void;
let coord: Coordinator;
let ui: CoordinatorUi;
beforeEach(() => {
  let home: string;
  ({ home, cleanup } = tempHome());
  coord = makeCoord(home);
  ui = new CoordinatorUi(coord);
});
afterEach(() => cleanup());

async function approveAllFamilies(testKey: string) {
  for (const f of (await ui.families(testKey)).families) {
    if (f.state !== "sin_decidir") continue;
    await ui.decideFamily(f.id, { testId: testKey, decision: "approve", spotChecked: f.groupIds.slice(0, 3), acknowledgeValidityChanges: true }, HUMAN).catch(() => undefined);
  }
}

describe("G7 inherited decisions: policy re-asks, bulk confirmation", () => {
  it("lists only unchanged, policy-gated items; confirms them with a typed count and separate acknowledgements", async () => {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    await approveAllFamilies(k41);
    const list = await ui.inheritedConfirmList(k42);
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.changedCount).toBeGreaterThan(0);
    const cls = (await coord.requireClassified(k42)).cls;
    for (const i of list.items) {
      const g = cls.groups.find((x) => x.id === i.groupId)!;
      expect(i.reasons.length).toBeGreaterThan(0);
      expect(i.reasons).toEqual(inheritPolicyReasons(g));
      // never a closure carried to a real ubicación
      expect(i.effect === "close" && g.validity === "real").toBe(false);
    }
    const ids = list.items.map((i) => i.groupId);
    const structural = list.items.some((i) => i.reasons.includes("structural_opening"));
    const lifeSafety = list.items.some((i) => i.reasons.includes("life_safety"));
    // typed count must match
    await expect(ui.confirmInheritedBulk({ testId: k42, groupIds: ids, typedCount: ids.length + 1, acknowledgeStructural: true, acknowledgeLifeSafety: true }, HUMAN)).rejects.toThrow(/cantidad exacta/);
    // ids outside the list are refused (changed ones are confirmed one by one)
    const changed = (await ui.triage(P, MODEL_SET_ID, k42)).groups.find((g) => g.inherited?.confirmReasons?.includes("changed"))!;
    await expect(ui.confirmInheritedBulk({ testId: k42, groupIds: [changed.id], typedCount: 1 }, HUMAN)).rejects.toThrow(/No son heredadas sin cambio/);
    // structural openings and life safety are acknowledged separately
    if (structural) await expect(ui.confirmInheritedBulk({ testId: k42, groupIds: ids, typedCount: ids.length, acknowledgeLifeSafety: true }, HUMAN)).rejects.toThrow(/calculista/);
    if (lifeSafety) await expect(ui.confirmInheritedBulk({ testId: k42, groupIds: ids, typedCount: ids.length, acknowledgeStructural: true }, HUMAN)).rejects.toThrow(/seguridad de las personas/);

    const r = await ui.confirmInheritedBulk({ testId: k42, groupIds: ids, typedCount: ids.length, acknowledgeStructural: true, acknowledgeLifeSafety: true }, HUMAN);
    expect(r.confirmed).toEqual(ids);
    expect(r.list.items).toHaveLength(0);
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    for (const id of ids) {
      const g = tri.groups.find((x) => x.id === id)!;
      expect(g.inherited?.needsConfirmation).toBeUndefined();
      expect(g.reviewState).toBe("decided");
    }
    // audited per item
    const audit = (await coord.store.listAudit()).filter((e) => e.action === "inherited.confirmed");
    expect(audit.map((e) => e.targetIds?.[0]).sort()).toEqual([...ids].sort());
  }, 90_000);

  it("an unchanged human decision on a critical / structural / life-safety ubicación is re-asked until confirmed", async () => {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const t41 = await ui.triage(P, MODEL_SET_ID, k41);
    const t42 = await ui.triage(P, MODEL_SET_ID, k42);
    const cls42 = (await coord.requireClassified(k42)).cls;
    const g41Of = new Map(t41.groups.flatMap((g) => g.clashIds.map((c) => [c, g] as const)));
    const pair = t42.groups
      .filter((g) => !g.acc && g.change === "unchanged" && inheritPolicyReasons(cls42.groups.find((x) => x.id === g.id)!).length > 0)
      .map((g) => ({ g42: g, src: [...new Set(g.clashIds.map((c) => g41Of.get(c)?.id))] }))
      .find((x) => x.src.length === 1 && x.src[0] && t41.groups.find((y) => y.id === x.src[0])!.clashIds.length === x.g42.clashIds.length && t41.groups.find((y) => y.id === x.src[0])!.validity === x.g42.validity);
    expect(pair).toBeDefined();
    const p = (await ui.proposals(k41, undefined, 1000)).items.find((x) => x.targetId === pair!.src[0])!;
    const d: Decision = { id: `d-wsc-${Date.now()}`, proposalId: p.id, targetType: "group", targetId: pair!.src[0]!, testId: k41, modelSetId: MODEL_SET_ID, projectId: P, kind: "accept", changes: [], viewedInViewerMs: 2000, decidedAt: new Date().toISOString(), userId: "x", userName: "x" };
    await ui.saveDecisions([d], HUMAN);
    const g = (await ui.triage(P, MODEL_SET_ID, k42)).groups.find((x) => x.id === pair!.g42.id)!;
    expect(g.inherited).toMatchObject({ source: "human", needsConfirmation: true });
    expect(g.inherited!.confirmReasons).not.toContain("changed");
    const item = (await ui.inheritedConfirmList(k42)).items.find((i) => i.groupId === g.id)!;
    expect(item).toMatchObject({ source: "human", ref: d.id });
    await ui.confirmInheritedBulk({ testId: k42, groupIds: [g.id], typedCount: 1, acknowledgeStructural: true, acknowledgeLifeSafety: true }, HUMAN);
    const after = (await ui.triage(P, MODEL_SET_ID, k42)).groups.find((x) => x.id === g.id)!;
    expect(after.inherited?.needsConfirmation).toBeUndefined();
    expect(after.reviewState).toBe("decided");
  }, 90_000);

  it("parity: the agent proposes a bulk confirmation (never confirms); the human applies it", async () => {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    await approveAllFamilies(k41);
    const list = await ui.inheritedConfirmList(k42);
    const pick = list.items.filter((i) => !i.reasons.includes("structural_opening") && !i.reasons.includes("life_safety")).slice(0, 2);
    const ids = (pick.length ? pick : list.items.slice(0, 1)).map((i) => i.groupId);
    const changed = (await ui.triage(P, MODEL_SET_ID, k42)).groups.find((g) => g.inherited?.confirmReasons?.includes("changed"))!;
    const common = { testKey: k42, rationale: "Sin cambios desde v41; la política vuelve a preguntar.", evidence: [], confidence: "alta" as const };
    await expect(coord.proposeGroupAction({ ...common, action: { type: "confirm_inherited", groupIds: [changed.id] } })).rejects.toThrow(/No son heredadas sin cambio/);
    const prop = await coord.proposeGroupAction({ ...common, action: { type: "confirm_inherited", groupIds: ids } });
    // nothing confirmed by the proposal itself
    expect((await ui.inheritedConfirmList(k42)).items.map((i) => i.groupId)).toEqual(expect.arrayContaining(ids));
    const pending = (await ui.inheritedConfirmList(k42)).proposals;
    expect(pending.map((p) => p.groupIds)).toContainEqual(ids);
    const pid = pending[0]!.id;
    expect(pid).toBe((prop as { proposalId?: string; id?: string }).proposalId ?? (prop as { id?: string }).id);
    await ui.confirmInheritedBulk({ testId: k42, groupIds: ids, typedCount: ids.length, acknowledgeStructural: true, acknowledgeLifeSafety: true, proposalId: pid }, HUMAN);
    expect((await coord.store.getProposal(pid))!.state).toBe("applied");
    expect((await ui.inheritedConfirmList(k42)).proposals).toHaveLength(0);
  }, 90_000);
});

describe("G16 family signature v7 and decisions across signature changes", () => {
  const el = (o: Record<string, unknown>) => ({ discipline: "UNK", disciplineGroup: "UNK", elementClass: "other", ...o }) as unknown as ClassifiedClash["left"];
  const clash = (left: ClassifiedClash["left"], right: ClassifiedClash["right"], pen: number, ruleId = "EST-004") =>
    ({ key: `k${pen}`, id: `c${pen}`, mcClashIds: [`c${pen}`], left, right, facts: { penetrationMm: pen }, classification: { ruleId, validity: "real" } }) as unknown as ClassifiedClash;
  const beam = (type: string, h: number) => el({ elementClass: "structure_framing", discipline: "EST", type, heightMm: h, category: "Structural Framing" });
  const duct = (sys: string) => el({ elementClass: "duct", discipline: "CLI", systemClassification: sys, widthMm: 400, heightMm: 300, category: "Ducts" });
  const ctx = { originFile: () => "x.rvt" };

  it("under-beam ducts: one family across beam sections, CLI sub-systems and displacements ≤ 250 mm", () => {
    const a = physicalSignature(clash(beam("V200x500", 500), duct("SupplyAir"), 60), ctx);
    const b = physicalSignature(clash(beam("V350x800", 800), duct("ExhaustAir"), 180), ctx);
    expect(a.parts).toMatchObject({ problemType: "PT02", hostClass: "viga", systemClass: "CLI", relation: "desplazar≤250" });
    expect(a.familyId).toBe(b.familyId);
    // > 250 mm (ceiling height / level error) stays apart
    expect(physicalSignature(clash(beam("V350x800", 800), duct("SupplyAir"), 300), ctx).familyId).not.toBe(a.familyId);
    // a pasada through the web keeps the beam section (the calculista checks that beam)
    const web = physicalSignature(clash(beam("V200x500", 500), duct("SupplyAir"), 300), ctx);
    expect(web.parts).toMatchObject({ problemType: "PT01", hostType: "V200x500", relation: "atraviesa_alma" });
  });

  it("upgradeParts translates a v6 signature to v7 (and is idempotent)", () => {
    const v6 = { problemType: "PT02", hostClass: "viga", hostType: "V200x500", moverClass: "ducto", systemClass: "CLI-retorno", sizeBand: ">h/3", relation: "desplazar101–250" } as const;
    const v7 = physicalSignature(clash(beam("V350x800", 800), duct("ReturnAir"), 180), ctx).parts;
    expect(upgradeParts(v6)).toEqual(v7);
    expect(upgradeParts(v7)).toEqual(v7);
    expect(upgradeParts({ problemType: "PT04", hostClass: "losa", hostType: "Losa H.A. e=180", moverClass: "tub_grav", systemClass: "ALC-servidas", sizeBand: "Ø111–160", relation: "vertical" })).toEqual({ problemType: "PT04", hostClass: "losa", moverClass: "tub_grav", systemClass: "ALC", sizeBand: "≤Ø160", relation: "vertical" });
    expect(upgradeParts({ problemType: "PT06", hostClass: "muro", hostType: "Tabique Volcometal 100", moverClass: "tub_pres", systemClass: "AP-agua potable", sizeBand: "Ø51–110", relation: "atraviesa" })).toMatchObject({ hostType: "tabique", systemClass: "AP", sizeBand: "≤Ø160" });
  });

  it("different system disciplines (different responsible) stay apart", () => {
    const pipe = (sys: string) => el({ elementClass: "pipe", discipline: "AP", systemClassification: sys, diameterMm: 50, category: "Pipes" });
    const ap = physicalSignature(clash(beam("V250x600", 600), pipe("DomesticColdWater"), 40), ctx);
    const inc = physicalSignature(clash(beam("V250x600", 600), pipe("FireProtectionWet"), 40), ctx);
    expect(ap.parts.systemClass).toBe("AP");
    expect(inc.parts.systemClass).toBe("INC");
    expect(ap.familyId).not.toBe(inc.familyId);
  });

  const fam = (id: string, groupIds: string[]): FamilyRecord => ({ id, groupIds, parts: { problemType: "PT02" } }) as unknown as FamilyRecord;
  const grp = (id: string, familyId: string, clashIds: string[]): GroupRecord => ({ id, familyId, clashIds }) as unknown as GroupRecord;
  const version = (familyId: string, validity: "real" | "false_positive", action: "create_issue" | "close", responsible = "CLI", decidedAt = "2026-11-01T00:00:00Z") => ({
    familyId, version: 1, status: "approved" as const, validity, action, responsibleDiscipline: responsible, issueMode: "family" as const, decidedBy: "x", decidedAt, spotChecked: [], coveredGroupIds: [], testKey: "T-00000041",
  });
  const state = (fams: Record<string, ReturnType<typeof version>>): ModelSetFamilies => ({
    version: 1,
    families: Object.fromEntries(Object.entries(fams).map(([k, v]) => [k, { versions: [v], exceptions: [], confirmed: [] }])),
    aliases: {},
    detached: {},
  });

  it("old decisions with the same fields carry onto the new family; disagreeing ones surface as 'revisar'", () => {
    const fams = [fam("F-new1", ["G-1", "G-2"]), fam("F-new2", ["G-3", "G-4"])];
    const groups = [grp("G-1", "F-new1", ["c1"]), grp("G-2", "F-new1", ["c2"]), grp("G-3", "F-new2", ["c3"]), grp("G-4", "F-new2", ["c4"])];
    const st = state({
      "F-oldA": version("F-oldA", "real", "create_issue", "CLI", "2026-11-02T00:00:00Z"),
      "F-oldB": version("F-oldB", "real", "create_issue"),
      "F-oldC": version("F-oldC", "real", "create_issue"),
      "F-oldD": version("F-oldD", "false_positive", "close"),
    });
    const refs: Record<string, string> = { c1: "F-oldA@v1", c2: "F-oldB@v1", c3: "F-oldC@v1", c4: "F-oldD@v1" };
    const m = legacyFamilyMapping(fams, groups, st, (id) => refs[id]);
    expect(m.aliases).toEqual({ "F-new1": "F-oldA" });
    expect([...m.compatible.get("F-oldA")!].sort()).toEqual(["F-oldA", "F-oldB"]);
    expect(m.review.get("F-new2")!.map((d) => d.familyId).sort()).toEqual(["F-oldC", "F-oldD"]);
    expect(m.aliases["F-new2"]).toBeUndefined();
  });

  it("an old family spread over several new families is never aliased (both say 'revisar')", () => {
    const fams = [fam("F-new1", ["G-1"]), fam("F-new2", ["G-2"])];
    const groups = [grp("G-1", "F-new1", ["c1"]), grp("G-2", "F-new2", ["c2"])];
    const st = state({ "F-old": version("F-old", "real", "create_issue") });
    const m = legacyFamilyMapping(fams, groups, st, () => "F-old@v1");
    expect(m.aliases).toEqual({});
    expect(m.review.get("F-new1")).toHaveLength(1);
    expect(m.review.get("F-new2")).toHaveLength(1);
  });

  it("end to end: v41 family decisions under old ids still reach v42 (inheritance kept, never lost)", async () => {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    await approveAllFamilies(k41);
    const before = await ui.triage(P, MODEL_SET_ID, k42);
    const inheritedBefore = before.groups.filter((g) => g.inherited?.source === "family").map((g) => [g.id, g.inherited!.needsConfirmation ?? false]);
    expect(inheritedBefore.length).toBeGreaterThan(0);
    // Simulate the previous signature: every decided family id (and its ledger references) is renamed.
    const test = (await coord.requireClassified(k42)).test;
    const famPath = coord.families.path(test.projectId, test.modelSetId);
    const ren = (id: string) => id.replace(/^F-/, "F-old");
    const st = JSON.parse(readFileSync(famPath, "utf8")) as ModelSetFamilies;
    st.families = Object.fromEntries(Object.entries(st.families).map(([k, v]) => [ren(k), { ...v, versions: v.versions.map((x) => ({ ...x, familyId: ren(x.familyId) })) }]));
    writeFileSync(famPath, JSON.stringify(st));
    const ledgerPath = coord.ledger.path(test.projectId, test.modelSetId);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { entries: Record<string, { decision?: { source: string; ref: string } }> };
    for (const e of Object.values(ledger.entries)) if (e.decision?.source === "family") e.decision.ref = ren(e.decision.ref);
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    // …and v41's cached classification carries the old ids (its parts let new-only ubicaciones find their family).
    const c41 = (await coord.store.getClassification(k41))!;
    await coord.store.putClassification({ ...c41, families: c41.families!.map((f) => ({ ...f, id: ren(f.id) })) });
    const after = await ui.triage(P, MODEL_SET_ID, k42);
    const inheritedAfter = after.groups.filter((g) => g.inherited?.source === "family").map((g) => [g.id, g.inherited!.needsConfirmation ?? false]);
    expect(inheritedAfter).toEqual(inheritedBefore);
    const views = (await ui.families(k42)).families;
    expect(views.some((f) => f.id.startsWith("F-old") && f.mergedFrom.length > 0 && f.decision?.status === "approved")).toBe(true);
  }, 90_000);

  it("fixtures: v42 needs fewer, larger families than signature v6 (130/156 → measured in the report)", async () => {
    const k42 = await ingest(coord, 42);
    const cls = (await coord.requireClassified(k42)).cls;
    expect(cls.families!.length).toBeLessThan(40);
    expect(cls.groups.length / cls.families!.length).toBeGreaterThan(2.5);
  }, 60_000);
});

describe("G23 system discipline for the pair and the responsible", () => {
  it("systemDisciplineOf maps system classes to discipline codes", () => {
    expect(systemDisciplineOf("AP-agua potable")).toBe("AP");
    expect(systemDisciplineOf("ALL")).toBe("ALL");
    expect(systemDisciplineOf("ALC-servidas")).toBe("ALC");
    expect(systemDisciplineOf("arch_wall")).toBeUndefined();
  });

  it("an AP pipe in a slab / wall group labelled ALC or ALL is re-labelled with AP; EST/ARQ stay", () => {
    const parts = { problemType: "PT04", hostClass: "losa", systemClass: "AP" } as const;
    expect(systemPair({ pair: ["ALC", "EST"], responsibleDiscipline: "EST" }, parts)).toMatchObject({ pair: ["AP", "EST"], responsibleDiscipline: "EST", disciplinePair: "AP×EST" });
    expect(systemPair({ pair: ["ALL", "ARQ"], responsibleDiscipline: "ALL" }, { ...parts, problemType: "PT06", hostClass: "muro" })).toMatchObject({ pair: ["AP", "ARQ"], responsibleDiscipline: "AP" });
    // MEP × MEP crossing: the host side keeps its own system discipline
    expect(systemPair({ pair: ["CLI", "INC"], responsibleDiscipline: "INC" }, { problemType: "PT08", hostClass: "ducto", hostType: "CLI", systemClass: "INC" })).toMatchObject({ pair: ["CLI", "INC"], responsibleDiscipline: "INC" });
  });

  it("fixtures: no pair-bucket family of AP / ALL / ALC pipes is labelled with another sanitary discipline", async () => {
    const k42 = await ingest(coord, 42);
    const cls = (await coord.requireClassified(k42)).cls;
    for (const f of cls.families!) {
      const sd = systemDisciplineOf(f.parts.systemClass);
      if (f.bucket !== "pair" || !sd || !["AP", "ALL", "ALC"].includes(sd) || f.parts.problemType === "PT09") continue;
      const others = ["AP", "ALL", "ALC"].filter((d) => d !== sd);
      const hostSd = f.parts.hostClass === "tub_grav" || f.parts.hostClass === "tub_pres" ? systemDisciplineOf(f.parts.hostType) : undefined;
      for (const d of f.pair!) if (d !== hostSd) expect(others).not.toContain(d);
    }
  }, 60_000);
});
