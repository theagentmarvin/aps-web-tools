import { describe, expect, it } from "vitest";
import { whoMoves } from "../../core/classify";
import { canonicalCategory, computeClashFacts, enrichElement, fileDiscipline, orientationFromBbox, resolveTolerance } from "../../core/enrich";
import { evaluatePair } from "../../core/pipeline";
import { curve, scoreFromFactors, computeFactors } from "../../core/score";
import { rules } from "./helpers";

const rs = rules();
const E = (p: Record<string, unknown>) => enrichElement(rs, p);

describe("element enrichment", () => {
  it("normalizes categories (prefix, Spanish, accents)", () => {
    expect(canonicalCategory(rs, "Revit Tuberías")).toBe("Pipes");
    expect(canonicalCategory(rs, "Revit Techos")).toBe("Ceilings");
    expect(canonicalCategory(rs, "OST_Foo Bar")).toBe("foo bar");
    expect(canonicalCategory(rs, undefined)).toBeUndefined();
  });

  it("detects model discipline: ISO 19650 role, Chilean alias role, tokens, MEP fallback", () => {
    expect(fileDiscipline(rs, "P2401-SLF-ZZ-ZZ-M3-S-0001.rvt")).toBe("EST");
    expect(fileDiscipline(rs, "P2401-SLF-ZZ-ZZ-M3-ARQ-0001.rvt")).toBe("ARQ");
    expect(fileDiscipline(rs, "P2401_ARQ_TorreA.rvt")).toBe("ARQ");
    expect(fileDiscipline(rs, "Torre B - Clima.rvt")).toBe("CLI");
    expect(fileDiscipline(rs, "P2401-MEP.rvt")).toBe("UNK");
    expect(fileDiscipline(rs, "random.rvt")).toBeUndefined();
  });

  it("refines discipline by system inside a combined SAN file; category fallback otherwise", () => {
    const ap = E({ documentName: "P2401-SAN.rvt", category: "Pipes", systemClassification: "Domestic Cold Water" });
    expect(ap.modelDiscipline).toBe("SAN");
    expect(ap.discipline).toBe("AP");
    const wet = E({ documentName: "P2401-SAN.rvt", category: "Pipes", systemClassification: "Fire Protection Wet" });
    expect(wet.discipline).toBe("INC");
    const unknownFile = E({ documentName: "x.rvt", category: "Revit Muros" });
    expect(unknownFile.discipline).toBe("ARQ");
    expect(E({}).discipline).toBe("UNK");
  });

  it("derives sizeMm per category (walls width, slabs thickness, beams height, insulation host + 2t)", () => {
    expect(E({ category: "Walls", widthMm: 200, heightMm: 3000 }).sizeMm).toBe(200);
    expect(E({ category: "Floors", thicknessMm: 150, widthMm: 9000 }).sizeMm).toBe(150);
    expect(E({ category: "Structural Framing", widthMm: 250, heightMm: 600 }).sizeMm).toBe(600);
    expect(E({ category: "Ducts", widthMm: 600, heightMm: 400 }).sizeMm).toBe(600);
    expect(E({ category: "Pipes", diameterMm: 100, outsideDiameterMm: 110 }).sizeMm).toBe(110);
    expect(E({ category: "Pipe Insulation", diameterMm: 80, insulationThicknessMm: 25 }).sizeMm).toBe(130);
    expect(E({ category: "Pipe Insulation", insulationThicknessMm: 25 }).sizeMm).toBe(25);
  });

  it("derives flags and classes; insulation inherits the host rank", () => {
    const ins = E({ documentName: "P2401-CLI.rvt", category: "Duct Insulation", widthMm: 600, heightMm: 400, insulationThicknessMm: 25 });
    expect(ins.isInsulation).toBe(true);
    expect(ins.elementClass).toBe("insulation");
    expect(ins.moveRank).toBe(80); // host = duct >= 400 -> duct_large
    const pins = E({ category: "Pipe Insulation", diameterMm: 50 });
    expect(pins.moveRank).toBe(40);
    const gravity = E({ documentName: "P2401-SAN.rvt", category: "Pipes", systemClassification: "Sanitario", diameterMm: 110 });
    expect(gravity.isGravity).toBe(true);
    expect(gravity.elementClass).toBe("gravity_pipe");
    const col = E({ documentName: "P2401_ARQ.rvt", category: "Structural Columns", widthMm: 400, heightMm: 400 });
    expect(col.isForeign).toBe(true);
    expect(E({ documentName: "P2401_ARQ.rvt", category: "Walls" }).isForeign).toBe(false); // exempt category
    expect(E({ category: "Walls", type: "Muro HA 20" }).elementClass).toBe("structure_wall");
    expect(E({ category: "Walls", type: "Tabique F-120" }).isFireRated).toBe(true);
    expect(E({ category: "Generic Models", family: "Zona de mantención UMA" }).elementClass).toBe("clearance_zone");
  });

  it("derives orientation from a bbox (metres) for run categories only", () => {
    expect(orientationFromBbox({ min: { x: 0, y: 0, z: 0 }, max: { x: 0.1, y: 0.1, z: 3 } })).toBe("vertical");
    expect(orientationFromBbox({ min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 0.1, z: 0.1 } })).toBe("horizontal");
    expect(orientationFromBbox({ min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 0.1, z: 2 } })).toBe("sloped");
    expect(orientationFromBbox({ min: { x: 0, y: 0, z: 0 }, max: { x: 0.2, y: 0.2, z: 0.2 } })).toBeUndefined();
    const bbox = { min: { x: 0, y: 0, z: 0 }, max: { x: 0.1, y: 0.1, z: 3 } };
    expect(E({ category: "Pipes", bbox }).orientation).toBe("vertical");
    expect(E({ category: "Walls", bbox }).orientation).toBeUndefined();
    expect(E({ category: "Pipes", bbox, orientation: "horizontal" }).orientation).toBe("horizontal");
  });
});

describe("clash facts, tolerance and who-moves", () => {
  const duct = E({ documentName: "P2401-CLI.rvt", category: "Ducts", widthMm: 300, heightMm: 200, systemName: "INY-3", level: "Piso 3" });
  const beam = E({ documentName: "P2401-EST.rvt", category: "Structural Framing", widthMm: 250, heightMm: 500, level: "Piso 3" });
  const gas = E({ documentName: "P2401-GAS.rvt", category: "Pipes", systemType: "Gas natural", diameterMm: 28 });
  const conduit = E({ documentName: "P2401-ELE.rvt", category: "Conduits", diameterMm: 25 });

  it("resolves the tolerance entry first-match, unordered", () => {
    expect(resolveTolerance(rs, duct, beam)).toMatchObject({ hardMm: 5, clearanceMm: 25 });
    expect(resolveTolerance(rs, beam, duct)).toMatchObject({ hardMm: 5 });
    expect(resolveTolerance(rs, conduit, gas)).toMatchObject({ hardMm: 0, clearanceMm: 50, index: 0 }); // GAS-ELE before conduit
  });

  it("computes clash facts", () => {
    const f = computeClashFacts(rs, { distanceMm: -4, status: "reviewed" }, duct, beam);
    expect(f).toMatchObject({ penetrationMm: 4, withinTolerance: true, clearanceViolation: false, status: 2, sameLevel: true, sameDocument: false });
    expect(f.penetrationRatio).toBeCloseTo(4 / 300);
    const g = computeClashFacts(rs, { distanceMm: 10 }, duct, beam);
    expect(g).toMatchObject({ penetrationMm: 0, withinTolerance: false, clearanceViolation: true });
    expect(g.penetrationRatio).toBeUndefined();
  });

  it("who moves: overrides, rank, size tie-break, true tie", () => {
    expect(whoMoves(rs, beam, duct).mover).toBe(duct); // structure never moves
    const tray = E({ category: "Cable Tray", widthMm: 300, heightMm: 100 });
    const bigDuct = E({ category: "Ducts", widthMm: 500, heightMm: 300 });
    expect(whoMoves(rs, bigDuct, tray).mover).toBe(tray); // 80 vs 65
    const p1 = E({ category: "Pipes", diameterMm: 50 });
    const p2 = E({ category: "Pipes", diameterMm: 63 });
    expect(whoMoves(rs, p1, p2)).toMatchObject({ mover: p1, basis: "section" });
    // Resolution 6: a 300x100 tray against a 300x250 duct is not a tie (ranks 65 vs 60): the tray moves.
    const tray3 = E({ category: "Cable Tray", widthMm: 300, heightMm: 100 });
    const duct3 = E({ category: "Ducts", widthMm: 300, heightMm: 250 });
    expect(whoMoves(rs, duct3, tray3)).toMatchObject({ mover: tray3, basis: "section" });
    const p3 = E({ category: "Pipes", diameterMm: 50 });
    expect(whoMoves(rs, p1, p3)).toMatchObject({ basis: "tie" });
    expect(whoMoves(rs, p1, p3).mover).toBeUndefined();
    const g1 = E({ category: "Pipes", systemClassification: "Sanitary", diameterMm: 110 });
    const g2 = E({ category: "Pipes", systemClassification: "Storm", diameterMm: 110 });
    expect(whoMoves(rs, g1, g2).mover).toBeUndefined(); // gravity vs gravity: no mover
  });

  it("@mover resolves to COORD on a tie (MM-010) and never renders \"mueve COORD\"", () => {
    const c = evaluatePair(rs, { distanceMm: -40 }, { category: "Pipes", diameterMm: 50, systemName: "A", documentName: "P-CLI.rvt" }, { category: "Pipes", diameterMm: 50, systemName: "B", documentName: "P-AP.rvt" });
    expect(c.classification.ruleId).toBe("MM-010");
    expect(c.classification.responsibleDiscipline).toBe("COORD");
    expect(c.classification.secondaryDiscipline).toBe("COORD");
    expect(c.classification.mover).toBeUndefined();
    expect(c.classification.rationale).not.toMatch(/COORD/);
    expect(c.classification.rationale).toBe("Tubería B (50 mm) cruza tubería A (50 mm). Coordinación define quién desvía (sin jerarquía clara).");
    // Binding no longer depends on ACC left/right: AP sorts before CLI, so a = the AP pipe either way.
    const rev = evaluatePair(rs, { distanceMm: -40 }, { category: "Pipes", diameterMm: 50, systemName: "B", documentName: "P-AP.rvt" }, { category: "Pipes", diameterMm: 50, systemName: "A", documentName: "P-CLI.rvt" });
    expect(rev.classification.rationale).toBe(c.classification.rationale);
  });
});

describe("classification post-processing", () => {
  it("forces severity none for false positives and tolerated", () => {
    const c = evaluatePair(rs, { distanceMm: -25 }, { documentName: "A-CLI.rvt", modelFile: "f", category: "Pipe Insulation", systemName: "S1" }, { documentName: "A-CLI.rvt", modelFile: "f", category: "Pipes", systemName: "S1", diameterMm: 50 });
    expect(c.classification.ruleId).toBe("FP-001");
    expect(c.classification.severity).toBe("none");
  });
  it("humanReview: critical, low confidence, needs_info and rule flag", () => {
    const crit = evaluatePair(rs, { distanceMm: -80 }, { documentName: "X-CLI.rvt", category: "Pipes", diameterMm: 22 }, { documentName: "X-EST.rvt", category: "Structural Columns", widthMm: 500, heightMm: 500 });
    expect(crit.classification.humanReview).toBe(true);
    expect(crit.classification.humanReviewReasons).toContain("critical");
    const est011 = evaluatePair(rs, { distanceMm: -80 }, { documentName: "X-CLI.rvt", category: "Ducts", widthMm: 300, heightMm: 200 }, { documentName: "X-EST.rvt", category: "Floors", type: "Losa HA", thicknessMm: 150 });
    expect(est011.classification.ruleId).toBe("EST-011");
    expect(est011.classification.humanReviewReasons).toEqual(expect.arrayContaining(["rule", "low_confidence"]));
    expect(est011.classification.tags).toContain("sin_orientacion");
  });
  it("renders {x.category} with the Spanish label and missing values as —", () => {
    const c = evaluatePair(rs, { distanceMm: -60 }, { documentName: "X-SAN.rvt", category: "Revit Tuberías", systemClassification: "Sanitario", diameterMm: 110 }, { documentName: "X-EST.rvt", category: "Structural Framing", heightMm: 600 });
    expect(c.classification.ruleId).toBe("EST-002");
    expect(c.classification.rationale).toMatch(/interfiere viga '—' \(60 mm\)/);
    expect(c.classification.rationale).toMatch(/Ø110 mm/);
  });
  it("annotations add tags and notes; extra tags merge (regresion -> +15)", () => {
    const base = { documentName: "X-CLI.rvt", category: "Ducts", widthMm: 300, heightMm: 300, systemName: "A" };
    const other = { documentName: "X-ELE.rvt", category: "Cable Tray", widthMm: 300, heightMm: 100 };
    const plain = evaluatePair(rs, { distanceMm: -40 }, { ...base, modelAgeDays: 30 }, other);
    expect(plain.classification.tags).toContain("modelo_desactualizado");
    expect(plain.classification.notes.join(" ")).toMatch(/X-CLI\.rvt tiene más de 21 días/);
    const reg = evaluatePair(rs, { distanceMm: -40 }, base, other, { extraTags: ["regresion"] });
    const noReg = evaluatePair(rs, { distanceMm: -40 }, base, other);
    expect(reg.priority.score - noReg.priority.score).toBe(15);
    expect(reg.priority.overrides).toContain("OVR-006");
  });
});

describe("priority scoring", () => {
  it("piecewise-linear curve", () => {
    const pts = [[0, 0], [10, 0.15], [50, 0.45]] as const;
    expect(curve(pts, -5)).toBe(0);
    expect(curve(pts, 30)).toBeCloseTo(0.3);
    expect(curve(pts, 999)).toBe(0.45);
  });

  it("worked example from priority-scoring.yaml: 0.67175 -> 67 -> OVR-002 -> 75 P1, with breakdown", () => {
    const values = computeFactors(rs, {
      subject: { severity: "critical", validity: "real", tags: [] },
      disciplines: ["ALC", "EST"],
      distanceMm: -60,
      penetrationMm: 60,
      sizeMm: 110,
      levels: ["Piso 3", "Piso 3"],
      count: 1,
    });
    expect(values.disciplineCriticality.value).toBeCloseTo(0.955);
    expect(values.penetration.value).toBeCloseTo(0.48);
    expect(values.elementSize.value).toBeCloseTo(0.415);
    expect(values.zoneCriticality.value).toBe(0.4);
    expect(values.groupCount.value).toBe(0);
    expect(values.scheduleProximity.value).toBe(0.5);
    const r = scoreFromFactors(rs, values, { severity: "critical", validity: "real", tags: [] });
    expect(r.rawScore).toBe(67);
    expect(r.score).toBe(75);
    expect(r.band).toBe("P1");
    expect(r.factors.severity).toMatchObject({ value: 1, weight: 0.35, points: 35 });
    const sum = Object.values(r.factors).reduce((s, f) => s + f.points, 0);
    expect(sum).toBeCloseTo(67.175, 2);
  });

  it("overrides: non-issue set is terminal; needs_info cap; hygiene cap; life-safety floor", () => {
    const v = computeFactors(rs, { subject: { severity: "high", tags: [] }, disciplines: ["INC", "CLI"], distanceMm: -400, penetrationMm: 400, sizeMm: 800, levels: ["Sala de bombas"], count: 50 });
    expect(scoreFromFactors(rs, v, { validity: "tolerated", severity: "none", tags: ["regresion"] })).toMatchObject({ score: 0, band: "NONE", overrides: ["OVR-001"] });
    expect(scoreFromFactors(rs, v, { validity: "needs_info", severity: "high", tags: [] }).score).toBe(60);
    expect(scoreFromFactors(rs, v, { validity: "real", severity: "high", suggestedAction: "hygiene_issue", tags: [] }).score).toBe(45);
    const low = computeFactors(rs, { subject: { severity: "high", tags: [] }, disciplines: ["INC", "ARQ"], distanceMm: -5, penetrationMm: 5, levels: [] });
    const r = scoreFromFactors(rs, low, { validity: "real", severity: "high", tags: ["seguridad_personas"] });
    expect(r.rawScore).toBeLessThan(70);
    expect(r.score).toBe(70);
    expect(r.band).toBe("P2");
  });

  it("project zone patterns are evaluated before the defaults; schedule factor uses the curve", () => {
    const base = { subject: { severity: "medium", tags: [] }, disciplines: ["CLI", "ELE"] as const, distanceMm: -20, levels: ["Piso 3"] };
    expect(computeFactors(rs, base).zoneCriticality.value).toBe(0.4);
    expect(computeFactors(rs, base, { zonePatterns: [{ match: "^piso 3$", value: 0.9 }] }).zoneCriticality.value).toBe(0.9);
    expect(computeFactors(rs, { ...base, daysToInstall: 60 }).scheduleProximity.value).toBeCloseTo(0.6);
  });
});
