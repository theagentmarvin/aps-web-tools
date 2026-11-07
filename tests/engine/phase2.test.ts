import { describe, expect, it } from "vitest";
import { buildLevelCanon, levelKey } from "../../core/enrich/level";
import { attachPairKeys, elementLookupFromTables, normalizeClashTest } from "../../core/ingest";
import { detectReappeared, diffWithLedger, emptyLedger, historyBefore, parseLedger, reappearedIn, updateLedger } from "../../core/ingest/ledger";
import { isGenericName, ruleNameEs, titleName } from "../../core/group";
import { isStructuralOpening, type ReviewPolicy } from "../../core/group/review";
import { coveredBySleeve, runCoordination } from "../../core/pipeline";
import { loadRuleSet } from "../../core/rules";
import { elementTables, fixtureJson, rawVersion, truth } from "../helpers";
import { clash, doc, el, rules, sources } from "./helpers";

const rs = rules();
const documents = [doc(1, "P2401-SLF-ZZ-ZZ-M3-S-0001.rvt"), doc(2, "P2401_ARQ_TorreA.rvt"), doc(3, "P2401-SAN-TorreA.rvt"), doc(4, "P2401-CLI.rvt"), doc(6, "P2401-ELE.rvt")];

describe("level normalization", () => {
  it("keys numbered storeys, basements and roofs across languages", () => {
    expect(levelKey("Level 1")).toBe("L:1");
    expect(levelKey("Nivel 01")).toBe("L:1");
    expect(levelKey("N+3")).toBe("L:3");
    expect(levelKey("Piso -2")).toBe("L:-2");
    expect(levelKey("Subterráneo -1")).toBe("L:-1");
    expect(levelKey("Sótano 1")).toBe("L:-1");
    expect(levelKey("B2")).toBe("L:-2");
    expect(levelKey("Roof")).toBe("ROOF");
    expect(levelKey("Cubierta")).toBe("ROOF");
    expect(levelKey("Mezzanine")).toBe("T:mezzanine");
  });

  it("displays the project's dominant name, Spanish first on ties; project map wins", () => {
    const canon = buildLevelCanon(["Nivel 1", "Nivel 1", "Level 1", "Level 2", "Nivel 2", "Roof", "Cubierta"]);
    expect(canon("Level 1")).toBe("Nivel 1");
    expect(canon("Level 2")).toBe("Nivel 2");
    expect(canon("Roof")).toBe("Cubierta");
    expect(buildLevelCanon(["Level 1"], { "level 1": "N01" })("Level 1")).toBe("N01");
  });

  it("the pipeline groups an English ELE model with the Spanish models", () => {
    const ducts = [el(4, 1, { category: "Ducts", systemName: "INY", widthMm: 300, heightMm: 300, level: "Nivel 1" }), el(4, 2, { category: "Ducts", systemName: "INY", widthMm: 300, heightMm: 300, level: "Nivel 1" })];
    const trays = [el(6, 1, { category: "Cable Tray", widthMm: 200, heightMm: 100, level: "Level 1" }), el(6, 2, { category: "Cable Tray", widthMm: 200, heightMm: 100, level: "Level 1" })];
    const r = runCoordination({ clashes: [clash(1, [4, 1], [6, 1], -40), clash(2, [4, 2], [6, 2], -40)], elements: [...ducts, ...trays], documents, rules: rs });
    expect(new Set(r.classified.map((c) => c.level))).toEqual(new Set(["Nivel 1"]));
    expect(r.classified.every((c) => c.facts.sameLevel)).toBe(true);
    expect(r.classified[0]!.right.levelRaw ?? r.classified[0]!.left.levelRaw).toBe("Level 1");
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.levels).toEqual(["Nivel 1"]);
  });
});

describe("coveredBySleeve (cross-clash fact)", () => {
  const box = (x: number, y: number, z: number, dx: number, dy: number, dz: number) => ({ min: { x, y, z }, max: { x: x + dx, y: y + dy, z: z + dz } });
  const slab = el(1, 10, { category: "Floors", type: "Losa HA e=20", thicknessMm: 200, level: "Nivel 2", bbox: box(0, 0, 3, 10, 10, 0.2) });
  const sleeve = el(3, 20, { category: "Generic Models", family: "Pasada circular", type: "Ø160", diameterMm: 160, level: "Nivel 2", bbox: box(4.9, 4.9, 3, 0.2, 0.2, 0.2) });
  const pipeIn = el(3, 21, { category: "Pipes", systemClassification: "Sanitario", diameterMm: 110, level: "Nivel 2", bbox: box(4.95, 4.95, 0, 0.11, 0.11, 6) });
  const pipeOut = el(3, 22, { category: "Pipes", systemClassification: "Sanitario", diameterMm: 110, level: "Nivel 2", bbox: box(8, 8, 0, 0.11, 0.11, 6) });
  const r = runCoordination({
    clashes: [clash(1, [3, 20], [1, 10], -200), clash(2, [3, 21], [1, 10], -200), clash(3, [3, 22], [1, 10], -200)],
    elements: [slab, sleeve, pipeIn, pipeOut],
    documents,
    rules: rs,
  });
  const byId = new Map(r.classified.map((c) => [c.id, c]));

  it("is true only for the pipe whose crossing lies inside a sleeve of the same host", () => {
    expect(byId.get("1")!.classification.ruleId).toBe("FP-010");
    expect(byId.get("1")!.facts.coveredBySleeve).toBe(false); // the sleeve itself
    expect(byId.get("2")!.facts.coveredBySleeve).toBe(true);
    expect(byId.get("3")!.facts.coveredBySleeve).toBe(false);
  });

  it("is false without bboxes (conservative)", () => {
    const a = { ...byId.get("2")!.left, bbox: undefined } as never;
    expect(coveredBySleeve(a, byId.get("2")!.right, new Map())).toBe(false);
  });

  it("is a DSL clash field, so FP-016 (pending rules merge) loads", () => {
    const s = sources();
    const fp016 = {
      id: "FP-016", name: "MEP through a modeled sleeve", nameEs: "Instalación por pasada modelada",
      when: { clash: { coveredBySleeve: true }, a: { elementClass: { inSet: "MEP_DIST" } }, b: { elementClass: { inSet: "STRUCTURE" } } },
      then: { validity: "false_positive", nature: "hard", rootCause: "not_applicable", responsibleDiscipline: "COORD", secondaryDiscipline: "EST", severity: "none", confidence: 0.9, suggestedAction: "close_not_issue",
        rationale: "{a.category} pasa por la camisa/pasada modelada en {b.category} '{b.type}'. Confirmar que la pasada figura en el plano de pasadas aprobado por el calculista." },
    };
    const i = s.classification.rules.findIndex((x: { id: string }) => x.id === "FP-010");
    s.classification.rules.splice(i + 1, 0, fp016);
    const cand = loadRuleSet(s);
    const rr = runCoordination({ clashes: [clash(1, [3, 20], [1, 10], -200), clash(2, [3, 21], [1, 10], -200)], elements: [slab, sleeve, pipeIn], documents, rules: cand });
    const c2 = rr.classified.find((c) => c.id === "2")!;
    expect(c2.classification.ruleId).toBe("FP-016");
    expect(c2.classification.tags).toContain("pasada_estructural");
    // The closure stays in human review through the structural-opening trigger.
    const g = rr.groups.find((x) => x.memberKeys.includes(c2.key))!;
    expect(g.needsReview).toBe(true);
    expect(g.reviewReasons).toContain("pasada en estructura (requiere calculista)");
    expect(ruleNameEs("FP-016", undefined, cand)).toBe("Instalación por pasada modelada");
  });
});

describe("structural-opening review trigger (hard-coded)", () => {
  it("cannot be configured away", () => {
    const permissive: ReviewPolicy = {
      autoAccept: { real: 0, false_positive: 0, duplicate: 0, tolerance: 0 },
      reviewFloor: 0,
      alwaysReview: { severity: [], minClashCount: 1e9, unmatched: false, rulesConflict: false },
      bulkClosureMax: 1e9,
    };
    const slabs = [el(1, 1, { category: "Floors", type: "Losa HA e=15", thicknessMm: 150, level: "Nivel 3" }), el(1, 2, { category: "Floors", type: "Losa HA e=15", thicknessMm: 150, level: "Nivel 3" })];
    const risers = [el(3, 1, { category: "Pipes", systemClassification: "Domestic Hot Water", diameterMm: 75, level: "Nivel 3", orientation: "vertical" } as never), el(3, 2, { category: "Pipes", systemClassification: "Domestic Hot Water", diameterMm: 75, level: "Nivel 3", orientation: "vertical" } as never)];
    const r = runCoordination({ clashes: [clash(1, [3, 1], [1, 1], -75), clash(2, [3, 2], [1, 2], -75)], elements: [...slabs, ...risers], documents, rules: rs, options: { review: permissive } });
    expect(r.classified.every((c) => c.classification.ruleId === "EST-009")).toBe(true);
    const g = r.groups[0]!;
    expect(r.groups).toHaveLength(1);
    expect(g.strategy).toBe("zone");
    expect(g.title).toBe("Nivel 3: 2 losas EST vs 2 tuberías de AP (2 interf.)");
    expect(g.needsReview).toBe(true);
    expect(g.reviewReasons).toEqual(["pasada en estructura (requiere calculista)"]);
  });

  it("isStructuralOpening: closures and missing openings with the tag", () => {
    const t = new Set(["pasada_estructural"]);
    expect(isStructuralOpening("tolerated", "not_applicable", t)).toBe(true);
    expect(isStructuralOpening("real", "missing_opening", t)).toBe(true);
    expect(isStructuralOpening("real", "routing_conflict", t)).toBe(false);
    expect(isStructuralOpening("tolerated", "not_applicable", new Set())).toBe(false);
  });

  it("uses the calibrated thresholds", async () => {
    const { DEFAULT_REVIEW_POLICY } = await import("../../core/group/review");
    expect(DEFAULT_REVIEW_POLICY.autoAccept).toEqual({ real: 0.75, false_positive: 0.88, duplicate: 0.9, tolerance: 0.85 });
  });
});

describe("grouping follows the responsible side", () => {
  it("runs need 3 clashes; zones are not split by rule; generic names stay out of titles", () => {
    const beams = Array.from({ length: 4 }, (_, i) => el(1, 10 + i, { category: "Structural Framing", family: "Viga", type: "V 25x60", widthMm: 250, heightMm: 600, level: "Nivel 1" }));
    // Two ducts of one generic-named system (EST-005, high) + two of another system (EST-006 would be medium; keep high via size).
    const ducts = [
      el(4, 1, { category: "Ducts", family: "Ducto rectangular", type: "Uniones por radio / Te", systemName: "RET-1", widthMm: 300, heightMm: 250, level: "Nivel 1" }),
      el(4, 2, { category: "Ducts", family: "Ducto rectangular", type: "Uniones por radio / Te", systemName: "RET-1", widthMm: 300, heightMm: 250, level: "Nivel 1" }),
      el(4, 3, { category: "Ducts", family: "Ducto rectangular", type: "Uniones por radio / Te", systemName: "IMP-2", widthMm: 350, heightMm: 250, level: "Nivel 1" }),
    ];
    const r = runCoordination({
      clashes: [clash(1, [4, 1], [1, 10], -120), clash(2, [4, 2], [1, 11], -120), clash(3, [4, 3], [1, 12], -120)],
      elements: [...beams, ...ducts],
      documents,
      rules: rs,
    });
    expect(r.groups).toHaveLength(1); // a run of 2 is not a run: one zone item for the level
    expect(r.groups[0]!.strategy).toBe("zone");
    expect(r.groups[0]!.title).toBe("Nivel 1: 3 ductos CLI vs 3 vigas de EST (3 interf.)");
    expect(isGenericName("Muro básico")).toBe(true);
    expect(isGenericName("Uniones por radio / Te")).toBe(true);
    expect(titleName({ systemName: undefined, systemType: undefined, type: "Uniones por radio / Te", family: "Ducto rectangular", discipline: "CLI", disciplineGroup: "MEP", elementClass: "duct" })).toBe("");
  });
});

describe("Spanish rule names from the YAML (nameEs)", () => {
  it("prefers nameEs, warns when missing", () => {
    const s = sources();
    s.classification.rules[0].nameEs = "Elemento demolido (YAML)";
    const cand = loadRuleSet(s);
    expect(ruleNameEs("HYG-001", undefined, cand)).toBe("Elemento demolido (YAML)");
    expect(ruleNameEs("HYG-002", undefined, cand)).toBe("Objeto no físico o analítico"); // labels.ts fallback
    expect(cand.warnings.join(" ")).toMatch(/without nameEs/);
    expect(cand.warnings.join(" ")).not.toMatch(/HYG-001\b(?!\d)/);
  });
});

describe("clash-id ledger", () => {
  function ingest(v: 41 | 42) {
    const raw = rawVersion(v);
    const res = normalizeClashTest(raw, { documentVersions: raw.modelSetVersion.documentVersions });
    const { tables, externalIds } = elementTables(v);
    return { clashes: attachPairKeys(res.clashes, res.documents, elementLookupFromTables(tables)), externalIds };
  }
  const v40 = fixtureJson<string[]>("mc/history-v40-clash-ids.json").map((id) => ({ id }));
  const p = ingest(41);
  const n = ingest(42);

  it("detects the 13 reappeared clashes of the fixture once v40 is in the ledger", () => {
    let ledger = updateLedger(emptyLedger(truth().modelSetId), { version: 40, clashes: v40 });
    const { diff, ledger: l2 } = diffWithLedger(ledger, { version: 41, clashes: p.clashes }, { version: 42, clashes: n.clashes }, { nextElementKeys: n.externalIds });
    ledger = l2;
    expect(diff.counts).toEqual({ new: 70, persisting: 220, resolved: 65, element_deleted: 15, reappeared: 13 });
    expect(diff.reappeared).toEqual(truth().expectedDiff.reappeared);
    expect(reappearedIn(ledger, 42)).toEqual(diff.reappeared);
    expect(ledger.versions).toEqual([40, 41, 42]);
    const e = ledger.entries[diff.reappeared[0]!]!;
    expect(e.seenIn).toContain(40);
    expect(e.seenIn).not.toContain(41);
    expect(e.states.at(-1)).toEqual({ version: 42, state: "reappeared" });
    expect(detectReappeared(ledger, 42).length).toBeGreaterThan(0);
    // Resolved and deleted clashes are recorded at the version they disappeared, separately.
    const del = ledger.entries[diff.element_deleted[0]!]!;
    expect(del.states.at(-1)).toEqual({ version: 42, state: "element_deleted" });
  });

  it("without the ledger (only prev) the same clashes look new — the P0 bug", () => {
    const { diff } = diffWithLedger(emptyLedger("x"), { version: 41, clashes: p.clashes }, { version: 42, clashes: n.clashes });
    expect(diff.counts.reappeared).toBe(0);
  });

  it("is pure, idempotent and JSON round-trips", () => {
    const base = updateLedger(emptyLedger("m"), { version: 40, clashes: v40 });
    const once = diffWithLedger(base, { version: 41, clashes: p.clashes }, { version: 42, clashes: n.clashes }).ledger;
    const twice = diffWithLedger(once, { version: 41, clashes: p.clashes }, { version: 42, clashes: n.clashes }).ledger;
    expect(twice).toEqual(once);
    expect(base.versions).toEqual([40]);
    expect(parseLedger(JSON.parse(JSON.stringify(once)))).toEqual(once);
    expect(() => parseLedger({ schema: 99 })).toThrow();
    expect(historyBefore(once, 41).size).toBeGreaterThanOrEqual(v40.length);
  });

  it("pairKey renames keep firstSeen and the previous id", () => {
    let l = updateLedger(emptyLedger("m"), { version: 1, clashes: [{ id: "10", pairKey: "a|b" }] });
    l = diffWithLedger(l, { version: 1, clashes: [{ id: "10", pairKey: "a|b" }] }, { version: 2, clashes: [{ id: "99", pairKey: "a|b" }] }).ledger;
    expect(l.entries["99"]).toMatchObject({ firstSeen: 1, lastSeen: 2, previousIds: ["10"], states: [{ version: 2, state: "persisting" }] });
  });
});
