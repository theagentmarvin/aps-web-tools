import { describe, expect, it } from "vitest";
import { runCoordination } from "../../core/pipeline";
import { groupId, STRATEGY_ORDER } from "../../core/group";
import type { ElementProps, NormalizedClash } from "../../core/types";
import { clash, doc, el, rules, shuffled, syntheticProject } from "./helpers";

const SEV = { none: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;
const documents = [doc(1, "P2401-SLF-ZZ-ZZ-M3-S-0001.rvt"), doc(2, "P2401_ARQ_TorreA.rvt"), doc(4, "P2401-CLI.rvt"), doc(6, "P2401-ELE.rvt")];

function run(elements: ElementProps[], clashes: NormalizedClash[]) {
  return runCoordination({ clashes, elements, documents, rules: rules() });
}

describe("grouping invariants (synthetic project)", () => {
  const p = syntheticProject(3000, 7);
  const r = runCoordination({ ...p, rules: rules() });
  const byKey = new Map(r.classified.map((c) => [c.key, c]));

  it("each unique clash belongs to exactly one group", () => {
    const seen = new Map<string, number>();
    for (const g of r.groups) for (const k of g.memberKeys) seen.set(k, (seen.get(k) ?? 0) + 1);
    expect(seen.size).toBe(r.classified.length);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(r.groups.reduce((s, g) => s + g.stats.count, 0)).toBe(r.classified.length);
  });

  it("one validity and one responsible discipline per group; severity = max member", () => {
    for (const g of r.groups) {
      const ms = g.memberKeys.map((k) => byKey.get(k)!.classification);
      expect(new Set(ms.map((c) => c.validity))).toEqual(new Set([g.validity]));
      expect(new Set(ms.map((c) => c.responsibleDiscipline))).toEqual(new Set([g.responsibleDiscipline]));
      expect(SEV[g.severity]).toBe(Math.max(...ms.map((c) => SEV[c.severity])));
      expect(g.confidence).toBe(Math.min(...ms.map((c) => c.confidence)));
      if (ms.some((c) => c.severity === "critical")) expect(g.band).toBe("P1");
    }
  });

  it("max 60 clashes for G3–G6; ids are G- + 10 hex of sha1(strategy|key) and unique", () => {
    for (const g of r.groups) {
      if (!["nonissue", "hygiene"].includes(g.strategy)) expect(g.stats.count).toBeLessThanOrEqual(60);
      expect(g.id).toMatch(/^G-[0-9a-f]{10}$/);
      expect(g.id).toBe(groupId(g.strategy, g.canonicalKey));
      expect(g.title.length).toBeGreaterThan(5);
    }
    expect(new Set(r.groups.map((g) => g.id)).size).toBe(r.groups.length);
  });

  it("real clashes never land in non-issue groups and vice versa", () => {
    for (const g of r.groups) {
      if (g.strategy === "nonissue") expect(["false_positive", "tolerated"]).toContain(g.validity);
      if (["hub-mover", "hub-fixed", "run", "zone"].includes(g.strategy)) expect(g.validity).toBe("real");
      if (g.strategy === "needsinfo") expect(g.validity).toBe("needs_info");
    }
  });

  it("groups are ordered by priority, then strategy, then key", () => {
    for (let i = 1; i < r.groups.length; i++) {
      const a = r.groups[i - 1]!;
      const b = r.groups[i]!;
      expect(a.priorityScore > b.priorityScore || (a.priorityScore === b.priorityScore && STRATEGY_ORDER.indexOf(a.strategy) <= STRATEGY_ORDER.indexOf(b.strategy))).toBe(true);
    }
  });

  it("stats add up", () => {
    const s = r.stats;
    expect(Object.values(s.byValidity).reduce((x, y) => x + y, 0)).toBe(s.clashes.unique);
    expect(Object.values(s.byBand).reduce((x, y) => x + y, 0)).toBe(s.clashes.unique);
    expect(s.clashes.input).toBe(3000);
    expect(s.clashes.duplicatesMerged).toBe(3000 - s.clashes.unique);
    expect(s.groups.total).toBe(r.groups.length);
    expect(s.needsReview.groups).toBe(r.groups.filter((g) => g.needsReview).length);
    expect(s.groups.confidence.alta + s.groups.confidence.media + s.groups.confidence.baja).toBe(r.groups.length);
  });
});

describe("grouping strategies (hand-made cases)", () => {
  const duct = el(4, 1, { category: "Revit Ducts", family: "Ducto rectangular", type: "Galvanizado", systemName: "INY-UMA-2", widthMm: 600, heightMm: 400, level: "Piso 4" });
  const beams = Array.from({ length: 130 }, (_, i) => el(1, 100 + i, { category: "Revit Structural Framing", family: "Viga HA", type: "V 30x70", widthMm: 300, heightMm: 700, level: "Piso 4" }));

  it("G0 dedupe keeps the worst penetration and records every MC clash id", () => {
    const r = run([duct, beams[0]!], [clash(5, [4, 1], [1, 100], -200), clash(7, [1, 100], [4, 1], -350), clash(6, [4, 1], [1, 100], -100)]);
    expect(r.classified).toHaveLength(1);
    expect(r.classified[0]!.id).toBe("7");
    expect(r.classified[0]!.mcClashIds).toEqual(["5", "6", "7"]);
    expect(r.classified[0]!.facts.penetrationMm).toBe(350);
    expect(r.groups[0]!.mcClashIds).toEqual(["5", "6", "7"]);
  });

  it("G4 mover hub: one duct crossing many beams = one group (split at 60, tagged posible_error_de_cota)", () => {
    const cl = beams.slice(0, 14).map((b, i) => clash(1000 + i, [4, 1], [1, b.lmvId], -320));
    const r = run([duct, ...beams], cl);
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0]!;
    expect(g.strategy).toBe("hub-mover");
    expect(g.canonicalKey).toBe("hub-mover|4-1|CLI");
    expect(g.title).toBe("Ducto INY-UMA-2 600x400 vs 14 vigas — Piso 4");
    expect(g.tags).toContain("posible_error_de_cota");
    expect(g.hubElement).toMatchObject({ externalId: "4-1", systemName: "INY-UMA-2" });
    expect(g.severity).toBe("critical");
    expect(g.band).toBe("P1");
    expect(g.needsReview).toBe(true);
    expect(g.reviewReasons).toContain("severidad crítica");

    const big = run([duct, ...beams], beams.map((b, i) => clash(2000 + i, [4, 1], [1, b.lmvId], -50)));
    expect(big.groups.map((x) => x.stats.count).sort((a, b) => b - a)).toEqual([60, 60, 10]);
    expect(big.groups.every((x) => /\|part:\d$/.test(x.canonicalKey))).toBe(true);
  });

  it("G4 fixed hub: one beam crossed by several pipes of one discipline", () => {
    const beam = beams[0]!;
    const pipes = Array.from({ length: 4 }, (_, i) => el(4, 10 + i, { category: "Pipes", systemName: `AH ${i}`, systemClassification: "Hydronic Supply", diameterMm: 80, level: "Piso 3" }));
    const r = run([beam, ...pipes], pipes.map((p, i) => clash(3000 + i, [4, p.lmvId], [1, beam.lmvId], -60)));
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.strategy).toBe("hub-fixed");
    expect(r.groups[0]!.title).toMatch(/^Viga V 30x70 atravesada por 4 tuberías de CAL — Piso 4$/);
  });

  it("G1 batches non-issues; G2 takes hygiene rules even when they are false positives", () => {
    const arq = Array.from({ length: 3 }, (_, i) => el(2, 50 + i, { category: "Revit Muros", type: "Muro HA 20", widthMm: 200, level: "Piso 3" }));
    const est = Array.from({ length: 3 }, (_, i) => el(1, 50 + i, { category: "Revit Muros", type: "M HA e=20", widthMm: 200, level: "Piso 3" }));
    const lights = Array.from({ length: 4 }, (_, i) => el(6, 70 + i, { category: "Revit Luminarias", family: "Panel LED", level: "Piso 2" }));
    const ceiling = el(2, 90, { category: "Revit Techos", type: "Cielo americano", thicknessMm: 15, level: "Piso 2" });
    const r = run([...arq, ...est, ...lights, ceiling], [
      ...arq.map((a, i) => clash(10 + i, [2, a.lmvId], [1, est[i]!.lmvId], -200)),
      ...lights.map((l, i) => clash(20 + i, [6, l.lmvId], [2, 90], -70)),
    ]);
    const hyg = r.groups.find((g) => g.strategy === "hygiene")!;
    expect(hyg.stats.count).toBe(3);
    expect(hyg.ruleIds).toEqual(["DUP-005"]);
    expect(hyg.title).toBe("Higiene: ARQ remodela muros estructurales en P2401_ARQ_TorreA.rvt");
    const non = r.groups.find((g) => g.strategy === "nonissue")!;
    expect(non.stats.count).toBe(4);
    expect(non.title).toBe("4 × Artefacto embutido en cielo (ARQ×ELE)");
    expect(non.band).toBe("NONE");
    expect(non.sample).toHaveLength(3);
  });

  it("G7 singleton title", () => {
    const pipe = el(4, 5, { category: "Revit Pipes", systemClassification: "Other", systemType: "Refrigerante VRF", diameterMm: 22, level: "Piso 7" });
    const col = el(1, 5, { category: "Revit Pilares estructurales", type: "P 50x50", widthMm: 500, heightMm: 500, level: "Piso 7" });
    const r = run([pipe, col], [clash(1, [1, 5], [4, 5], -80)]);
    expect(r.groups[0]!.strategy).toBe("single");
    expect(r.groups[0]!.title).toBe("Tubería vs pilar — Piso 7");
  });
});

describe("determinism", () => {
  it("same input in any order -> same classified list, group ids and order", () => {
    const p = syntheticProject(2000, 99);
    const a = runCoordination({ ...p, rules: rules() });
    const b = runCoordination({ ...p, clashes: shuffled(p.clashes, 1), elements: shuffled(p.elements, 2), rules: rules() });
    expect(b.groups.map((g) => g.id)).toEqual(a.groups.map((g) => g.id));
    expect(b.groups.map((g) => g.memberKeys)).toEqual(a.groups.map((g) => g.memberKeys));
    expect(b.groups.map((g) => g.title)).toEqual(a.groups.map((g) => g.title));
    expect(b.classified.map((c) => [c.key, c.id, c.classification.ruleId, c.priority.score])).toEqual(
      a.classified.map((c) => [c.key, c.id, c.classification.ruleId, c.priority.score]),
    );
    const strip = (x: typeof a) => JSON.stringify({ ...x.stats, timings: undefined });
    expect(strip(b)).toBe(strip(a));
  });

  it("group ids are key-based: they survive membership changes", () => {
    const p = syntheticProject(2000, 99);
    const a = runCoordination({ ...p, rules: rules() });
    const b = runCoordination({ ...p, clashes: p.clashes.slice(0, 1900), rules: rules() });
    const ids = new Set(a.groups.map((g) => g.id));
    const kept = b.groups.filter((g) => ids.has(g.id)).length;
    expect(kept / b.groups.length).toBeGreaterThan(0.8);
  });
});

describe("performance", () => {
  it("runs 10,000 clashes in under 2 s", () => {
    const p = syntheticProject(10_000, 3);
    const t = performance.now();
    const r = runCoordination({ ...p, rules: rules() });
    const ms = performance.now() - t;
    expect(r.stats.clashes.input).toBe(10_000);
    expect(ms).toBeLessThan(2000);
  });
});
