/**
 * Solution families (docs/domain/solution-families-proposal.md): signature
 * determinism, the v11-like hydronic bundle (anonymised), validity mix,
 * inheritance / exceptions / re-test, one assign per family, > 1,000 split.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ElementProps, NormalizedClash } from "../../core/types";
import { familyIdOf } from "../../core/families";
import type { Coordinator } from "../../server/coordinator";
import { loadRules, runEngine } from "../../server/engine";
import { clash, doc, el } from "../engine/helpers";
import { CoordinatorUi, HUMAN, ingest, makeCoord, MODEL_SET_ID, tempHome, testConfig } from "./helpers";

const rs = loadRules();
const P = "demo-proyecto";

/**
 * Anonymised v11 extract: a 4-pipe hydronic bundle (supply/return, Ø22–54) runs in the bottom
 * 35–86 mm of beams of one type (h = 457 mm) on 3 floors; plus a few clashes within tolerance.
 */
function bundle(opts: { beamsPerLevel?: number; pipesPerBeam?: number; tolerated?: boolean } = {}) {
  const docs = [doc(0, "Estructura.rvt"), doc(1, "Clima.rvt")];
  const elements: ElementProps[] = [];
  const clashes: NormalizedClash[] = [];
  const levels: Array<[string, string]> = [["Nivel 201", "Nivel 101"], ["Nivel 301", "Nivel 201"], ["Nivel 401", "Nivel 301"]];
  const sizes = [22, 29, 41, 54];
  let id = 1;
  let lmv = 1;
  for (const [beamLevel, pipeLevel] of levels) {
    for (let b = 0; b < (opts.beamsPerLevel ?? 2); b++) {
      const beam = lmv++;
      elements.push(el(0, beam, { category: "Structural Framing", type: '12" x 18"', family: "Viga W", level: beamLevel, elementId: String(200000 + beam) }));
      for (let p = 0; p < (opts.pipesPerBeam ?? 4); p++) {
        const pipe = lmv++;
        elements.push(el(1, pipe, { category: "Pipes", type: "Cobre", level: pipeLevel, systemClassification: p % 2 ? "Hydronic Return" : "Hydronic Supply", systemName: `Hydronic ${p % 2 ? "Return" : "Supply"} ${b}`, diameterMm: sizes[p % sizes.length] }));
        const pen = opts.tolerated && p === 0 && b === 0 ? 2 : 35 + ((p * 17 + b * 11) % 52);
        clashes.push(clash(id++, [1, pipe], [0, beam], -pen));
      }
    }
  }
  return { docs, elements, clashes };
}

const run = (x: ReturnType<typeof bundle>, order?: (c: NormalizedClash[]) => NormalizedClash[]) =>
  runEngine({ clashes: order ? order([...x.clashes]) : x.clashes, elements: x.elements, documents: x.docs, config: testConfig().config, rules: rs });

describe("signature (F1)", () => {
  it("is deterministic: same families whatever the input order; id = F- + sha1(signature)", () => {
    const x = bundle();
    const a = run(x);
    const b = run(x, (c) => c.reverse());
    expect(b.families.map((f) => [f.id, f.signature, f.groupIds.length])).toEqual(a.families.map((f) => [f.id, f.signature, f.groupIds.length]));
    for (const f of a.families) expect(f.id).toBe(familyIdOf(f.signature.replace(/ {2,}/g, " ")));
    // every clash and group carries its family; one group = one family
    for (const g of a.groups) expect(g.familyId).toMatch(/^F-[0-9a-f]{10}$/);
    for (const c of a.clashes) expect(c.familyId).toBe(a.groups.find((g) => g.id === c.groupId)!.familyId);
  });

  it("the CAL bundle under beams on 3 levels is ONE PT02 family, a typical detail", () => {
    const out = run(bundle());
    expect(out.families).toHaveLength(1);
    const f = out.families[0]!;
    expect(f.parts).toMatchObject({ problemType: "PT02", hostClass: "viga", hostType: '12" x 18"', moverClass: "tub_pres", systemClass: "CAL-hidrónica", sizeBand: "≤h/3", relation: "desplazar≤100" });
    expect(f.instanceCount).toBeGreaterThanOrEqual(3);
    expect(f.levels.length).toBeGreaterThanOrEqual(2);
    expect(f.tags).toContain("tipico");
    expect(f.uniqueClashCount).toBe(24);
    expect(f.evidence.moverSizeMm).toEqual({ min: 22, max: 54 });
    expect(f.evidence.hostDepthMm).toBe(457);
    expect(f.title).toMatch(/CAL-hidrónica Ø22–54 invaden el fondo de vigas 12" x 18" · bajar ≤100 mm/);
    expect(f.proposed).toMatchObject({ validity: "real", action: "create_issue" });
    expect(out.groups.some((g) => g.hostLevelLabel?.startsWith("Entretecho Nivel 101 (viga nivel Nivel 201)"))).toBe(true);
  });

  it("validity is not in the signature: a tolerated member joins the real family and flags validez_mixta", () => {
    const out = run(bundle({ tolerated: true }));
    const f = out.families.find((x) => x.parts.problemType === "PT02")!;
    expect(f.validityMix.real).toBeGreaterThan(0);
    expect(f.validityMix.tolerated).toBeGreaterThan(0);
    expect(f.tags).toContain("validez_mixta");
    expect(out.families).toHaveLength(1);
  });
});

describe("family decisions, inheritance and batches (fixtures)", () => {
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
    k41 = await ingest(coord, 41);
    k42 = await ingest(coord, 42);
  });
  afterAll(() => cleanup());

  /** A real family with ≥ 2 instances in v42 and at least one instance that is new since v41. */
  async function familyWithNewInstance() {
    const a = await ui.families(k41);
    const b = await ui.families(k42);
    for (const f of b.families) {
      const old = a.families.find((x) => x.id === f.id);
      if (!old || f.proposed.validity !== "real" || f.validityMix.tolerated || f.validityMix.false_positive) continue;
      const fresh = f.groupIds.filter((g) => !old.groupIds.includes(g));
      const kept = f.groupIds.filter((g) => old.groupIds.includes(g));
      if (fresh.length && kept.length) return { old, f, fresh, kept };
    }
    throw new Error("fixture has no family with a new instance");
  }

  it("triage payload and families endpoint expose families and problem types", async () => {
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    expect(tri.families!.length).toBeGreaterThan(10);
    expect(tri.problemTypes!.map((p) => p.code)).toContain("PT14");
    const g = tri.groups[0]!;
    expect(g.familyId).toMatch(/^F-/);
    expect(g.inheritance?.state).toBe("none");
    const fam = await ui.family(k42, g.familyId!);
    expect(fam.groupIds).toContain(g.id);
    expect(fam.state).toBe("sin_decidir");
  });

  it("approve on v41 → inherited; on v42 the new instance is inherited_pending until a human confirms; exceptions survive", async () => {
    const { old, f, fresh, kept } = await familyWithNewInstance();
    // spot-check is mandatory
    await expect(ui.decideFamily(old.id, { testId: k41, decision: "approve", spotChecked: [] }, HUMAN)).rejects.toThrow(/al menos 1/);
    const d1 = await ui.decideFamily(old.id, { testId: k41, decision: "approve", spotChecked: [old.groupIds[0]!], solutionOption: "Desviar" }, HUMAN);
    expect(d1.state).toBe("decidida");
    expect(d1.decision).toMatchObject({ version: 1, status: "approved", validity: "real", action: "create_issue", issueMode: "family", decidedBy: HUMAN.name });
    expect(d1.instances.every((i) => i.inheritance.state === "inherited")).toBe(true);

    const v42 = await ui.family(k42, f.id);
    // Review fix #1: a kept instance inherits silently only when unchanged AND not engine-gated.
    const cls42 = (await coord.requireClassified(k42)).cls;
    const gated = new Set(cls42.groups.filter((g) => g.reviewState === "needs_review").map((g) => g.id));
    const silent = kept.filter((g) => !gated.has(g));
    for (const g of kept) expect(v42.instances.find((i) => i.groupId === g)!.inheritance.state).toBe(gated.has(g) ? "inherited_pending" : "inherited");
    for (const g of fresh) expect(v42.instances.find((i) => i.groupId === g)!.inheritance.state).toBe("inherited_pending");
    expect(v42.counts.pendingInherited).toBe(fresh.length + kept.length - silent.length);

    // a pending instance is NOT in the batch (never auto-assigned)
    const b1 = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: k42 }, HUMAN).catch(() => undefined);
    const it1 = b1?.items.filter((i) => i.familyId === f.id) ?? [];
    expect(it1).toHaveLength(silent.length ? 1 : 0);
    for (const i of it1) for (const g of i.groupIds ?? []) expect(silent).toContain(g);
    if (b1) await ui.discard(b1.id, HUMAN);

    // exception on a kept instance, then confirm the pending ones
    const ex = await ui.addFamilyException(f.id, { testId: k42, groupId: kept[0]!, fields: { action: "escalate" }, reason: "tramo recto atraviesa el mueble" }, HUMAN);
    expect(ex.instances.find((i) => i.groupId === kept[0])!.inheritance).toMatchObject({ state: "exception", exceptionReason: "tramo recto atraviesa el mueble" });
    const conf = await ui.confirmInherited(f.id, { testId: k42 }, HUMAN);
    expect(conf.counts.pendingInherited).toBe(0);
    for (const g of fresh) expect(conf.instances.find((i) => i.groupId === g)!.inheritance.state).toBe("inherited");
    for (const g of kept.slice(1)) expect(conf.instances.find((i) => i.groupId === g)!.inheritance.state).toBe("inherited");

    // a new decision version keeps the exception and marks it "familia cambió"
    const d2 = await ui.decideFamily(f.id, { testId: k42, decision: "approve", spotChecked: [kept[0]!], issueMode: "per_instance" }, HUMAN);
    expect(d2.decision!.version).toBe(2);
    expect(d2.instances.find((i) => i.groupId === kept[0])!.inheritance).toMatchObject({ state: "exception", familyChanged: true });
    expect(d2.exceptions).toHaveLength(1);
    // per_instance: one assign per inherited instance, the exception excluded
    const b2 = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: k42 }, HUMAN);
    const it2 = b2.items.filter((i) => i.familyId === f.id);
    expect(it2).toHaveLength(f.groupIds.length - 1);
    expect(it2.every((i) => i.mcOperation === "clash.assign" && i.label.startsWith(`[${f.id}`))).toBe(true);
    await ui.discard(b2.id, HUMAN);
  });

  it("one assign per family: a single ACC issue holding every clash of the family (dry-run body)", async () => {
    const all = await ui.families(k42);
    const f = all.families.find((x) => x.state === "sin_decidir" && x.instanceCount >= 3 && x.proposed.validity === "real" && !x.validityMix.tolerated && !x.validityMix.false_positive)!;
    expect(f).toBeDefined();
    const preview = await ui.familyDecisionPreview(f.id, { testId: k42 });
    expect(preview).toMatchObject({ instances: f.instanceCount, issues: 1, validityChanges: [] });
    await ui.decideFamily(f.id, { testId: k42, decision: "approve", spotChecked: [f.groupIds[0]!], typicalDetail: { name: "Pasada tipo", note: "camisa Ø+50" } }, HUMAN);
    const b = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: k42 }, HUMAN);
    const items = b.items.filter((i) => i.familyId === f.id);
    expect(items).toHaveLength(1);
    const body = items[0]!.accNew as { title: string; description: string; clashes: number[] };
    expect(body.title).toMatch(new RegExp(`^\\[${f.id}\\] `));
    expect(body.title.length).toBeLessThanOrEqual(100);
    expect(body.description.length).toBeLessThanOrEqual(1000);
    expect(body.description).toMatch(/Ubicaciones por nivel: /);
    expect(body.description).toMatch(/Detalle típico: Pasada tipo/);
    // X1: clashes ACC already assigned or closed are never part of a new assign
    expect(body.clashes.length).toBe(f.rawClashCount - (f.acc?.existing ?? 0));
    const live = f.instances.filter((i) => (i.acc?.existing ?? 0) < i.rawClashCount).map((i) => i.groupId);
    expect(new Set(items[0]!.groupIds)).toEqual(new Set(live));
    // the group flow does not duplicate the family's instances
    expect(b.items.filter((i) => !i.familyId && i.groupId && f.groupIds.includes(i.groupId))).toHaveLength(0);
    // the decision is versioned and audited
    const audit = await ui.audit({ action: "family.decided", limit: 50 });
    expect(audit.items.some((e) => e.targetIds?.includes(f.id))).toBe(true);
    // dry-run apply: the ACC request carries ONE assigned group for the family
    await ui.approve(b.id, { confirmWord: "APLICAR", excludedItemIds: [], demo: true }, HUMAN);
    const dry = await ui.apply(b.id, {}, { type: "user", id: HUMAN.id, name: HUMAN.name });
    expect(dry.dryRun).toBe(true);
    const bodies = dry.requests
      .flatMap((r) => (Array.isArray(r.body) ? r.body : ((r.body as { groups?: unknown[] } | undefined)?.groups ?? [r.body])))
      .filter((x): x is { title: string; clashes: number[] } => typeof (x as { title?: unknown } | undefined)?.title === "string" && (x as { title: string }).title.startsWith(`[${f.id}]`));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.clashes).toHaveLength(f.rawClashCount - (f.acc?.existing ?? 0));
  });

  it("mixed-validity guard: approving a validity that differs from instances needs an explicit acknowledgement; real is never closed", async () => {
    const all = await ui.families(k42);
    const f = all.families.find((x) => x.tags.includes("validez_mixta") && x.state === "sin_decidir")!;
    expect(f).toBeDefined();
    const pv = await ui.familyDecisionPreview(f.id, { testId: k42, validity: "real", action: "create_issue" });
    expect(pv.validityChanges.length).toBeGreaterThan(0);
    expect(pv.validityChanges.every((c) => c.to === "real" && c.from !== "real")).toBe(true);
    await expect(ui.decideFamily(f.id, { testId: k42, decision: "approve", validity: "real", spotChecked: [f.groupIds[0]!] }, HUMAN)).rejects.toThrow(/cambiarían? de validez/);
    await expect(ui.decideFamily(f.id, { testId: k42, decision: "approve", validity: "real", action: "close", spotChecked: [f.groupIds[0]!] }, HUMAN)).rejects.toThrow(/no se cierra/);
    const ok = await ui.decideFamily(f.id, { testId: k42, decision: "approve", validity: "real", spotChecked: [f.groupIds[0]!], acknowledgeValidityChanges: true }, HUMAN);
    expect(ok.decision!.acknowledgedValidityChanges!.length).toBe(pv.validityChanges.length);
    const b = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: k42 }, HUMAN);
    const item = b.items.find((i) => i.familyId === f.id)!;
    expect(item.validityChanges!.map((c) => c.groupId).sort()).toEqual(pv.validityChanges.map((c) => c.groupId).sort());
    await ui.discard(b.id, HUMAN);
    // reject = new version, no batch item
    const rej = await ui.decideFamily(f.id, { testId: k42, decision: "reject" }, HUMAN);
    expect(rej.state).toBe("rechazada");
    expect(rej.decision!.version).toBe(2);
  });

  it("merge and detach are recorded and resolved server-side", async () => {
    const all = await ui.families(k42);
    const [a, b] = all.families.filter((x) => x.state === "sin_decidir" && x.instanceCount >= 2).slice(-2);
    const merged = await ui.mergeFamilies({ testId: k42, from: a!.id, into: b!.id }, HUMAN);
    const m = merged.families.find((x) => x.id === b!.id)!;
    expect(m.mergedFrom).toContain(a!.id);
    expect(m.instanceCount).toBe(a!.instanceCount + b!.instanceCount);
    const det = await ui.detachInstance(b!.id, { testId: k42, groupId: b!.groupIds[0]! }, HUMAN);
    const manual = det.families.find((x) => x.groupIds.includes(b!.groupIds[0]!))!;
    expect(manual.id).toMatch(/^F-M/);
    expect(manual.instances[0]!.inheritance.state).toBe("detached");
  });

  it("MCP: list_families / get_family read; propose_family_decision only proposes", async () => {
    const list = await coord.listFamilies({ testKey: k42, limit: 5 });
    expect(list.rows.length).toBe(5);
    expect(list.rows[0]![2]).toHaveProperty("untrusted");
    const fid = list.rows[1]![0] as string;
    const one = await coord.getFamily({ testKey: k42, familyId: fid });
    expect(one.instances.length).toBeGreaterThan(0);
    const before = (await ui.family(k42, fid)).state;
    const p = await coord.proposeFamilyDecision({ testKey: k42, familyId: fid, validity: "real", action: "create_issue", rationale: "Mismo detalle en todos los niveles." });
    expect(p.kind).toBe("family_decision");
    const after = await ui.family(k42, fid);
    expect(after.state).toBe(before);
    expect(after.pendingProposals.map((x) => x.id)).toContain(p.proposalId);
    await expect(coord.proposeFamilyDecision({ testKey: k42, familyId: fid, validity: "real", action: "close", rationale: "x" })).rejects.toThrow(/no se cierra/);
  });
});

describe("> 1,000 clashes in one family", () => {
  it("one family issue is split into chunks of ≤ 1,000 clashes", async () => {
    const t = tempHome();
    try {
      const coord = makeCoord(t.home);
      const ui = new CoordinatorUi(coord);
      const key = await ingest(coord, 42);
      // Replace the classification with a synthetic one: 3 levels × 46 beams × 8 pipes = 1,104 clashes, one family.
      const x = bundle({ beamsPerLevel: 46, pipesPerBeam: 8 });
      const out = run(x);
      expect(out.families).toHaveLength(1);
      const cls = (await coord.store.getClassification(key))!;
      await coord.store.putClassification({ ...cls, groups: out.groups, clashes: out.clashes, families: out.families });
      const f = (await ui.families(key)).families[0]!;
      expect(f.rawClashCount).toBe(1104);
      expect((await ui.familyDecisionPreview(f.id, { testId: key })).issues).toBe(2);
      await ui.decideFamily(f.id, { testId: key, decision: "approve", spotChecked: f.groupIds.slice(0, 3) }, HUMAN);
      const b = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: key }, HUMAN);
      const items = b.items.filter((i) => i.familyId === f.id);
      expect(items).toHaveLength(2);
      const sizes = items.map((i) => (i.accNew as { clashes: number[] }).clashes.length);
      expect(sizes).toEqual([1000, 104]);
      expect(items.map((i) => i.label)).toEqual([expect.stringMatching(/\(1\/2\)$/), expect.stringMatching(/\(2\/2\)$/)]);
      for (const i of items) {
        const title = (i.accNew as { title: string }).title;
        expect(title).toMatch(/\([12]\/2\)$/);
        expect(title.length).toBeLessThanOrEqual(100);
      }
    } finally {
      t.cleanup();
    }
  });
});

describe("clash fact sameOriginFile (FP-006 by origin file)", () => {
  it("is true for two elements of the same file seen through a linked copy, false across files", async () => {
    const { runCoordination } = await import("../../core/pipeline");
    const { normalizeLinkedExternalIds } = await import("../../server/group-titles");
    const LINK = "0a1b2c3d-0000-4000-8000-00000000abcd-0001f00d";
    const docs = [doc(0, "Estructura.rvt"), doc(1, "Instalaciones.rvt"), doc(2, "Otra-estructura.rvt")];
    const elements = normalizeLinkedExternalIds([
      el(0, 1, { externalId: "col-uid", category: "Structural Columns" }),
      el(0, 2, { externalId: "ftg-uid", category: "Structural Foundations" }),
      el(1, 3, { externalId: `${LINK}/col-uid`, category: "Structural Columns" }),
      el(2, 4, { externalId: "other-ftg", category: "Structural Foundations" }),
    ]);
    const res = runCoordination({ clashes: [clash(1, [1, 3], [0, 2], -50), clash(2, [2, 4], [0, 1], -50)], elements, documents: docs, rules: rs });
    const f = (id: string) => res.classified.find((c) => c.mcClashIds.includes(id))!.facts;
    expect(f("1")).toMatchObject({ sameOriginFile: true, sameModelFile: false });
    expect(f("2")).toMatchObject({ sameOriginFile: false, sameModelFile: false });
  });
});

describe("ACC issue title limits", () => {
  it("fitTitle keeps the chunk suffix and stays ≤ 100 characters", async () => {
    const { fitTitle } = await import("../../server/coordinator-ui");
    const base = "[F-0123456789] Tuberías gravitacionales ALC-servidas Ø41–105 cruzan sin pasada losas 3\" LW Concrete on 2\" Metal Deck · pasada en losa";
    const t = fitTitle(base, " (2/2)", 100);
    expect(t.length).toBeLessThanOrEqual(100);
    expect(t.endsWith("… (2/2)")).toBe(true);
    expect(fitTitle("corto", " (1/2)", 100)).toBe("corto (1/2)");
  });
});
