import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ASSERTED_FIELDS, evaluateScenarios, parseScenarioMarkdown, runScenario } from "../../core/eval/scenarios";
import { evaluatePair } from "../../core/pipeline";
import { ROOT, rules } from "./helpers";

const scenarios = parseScenarioMarkdown(readFileSync(path.join(ROOT, "docs/domain/eval-scenarios.md"), "utf8"));

/**
 * EV-05 ("Sin RF" = non-rated) needs matrix patch M1 (isFireRated "none" list),
 * which awaits a human merge of the discipline matrix (v2). Until then the
 * engine classifies it MA-006 (real): stricter, never an unsafe closure.
 */
const awaitingM1 = rules().versions.matrix < 2;
const blocked = new Set(awaitingM1 ? ["EV-05"] : []);

describe("eval scenarios (docs/domain/eval-scenarios.md)", () => {
  it("parses all 26 scenarios", () => {
    expect(scenarios).toHaveLength(26);
  });

  it.each(scenarios.filter((s) => !blocked.has(s.id)).map((s) => [s.id, s.title, s] as const))("%s %s", (_id, _title, s) => {
    const r = runScenario(rules(), s);
    const expected: Record<string, unknown> = {};
    const actual: Record<string, unknown> = {};
    for (const f of ASSERTED_FIELDS) {
      if (!(f in s.expected)) continue;
      expected[f] = s.expected[f];
      actual[f] = r.actual[f];
    }
    expect(actual).toEqual(expected);
    expect(r.clash.classification.source).toBe("rule");
    expect(r.clash.classification.rationale).not.toMatch(/\{[a-z]+\.[A-Za-z]+\}/);
  });

  it.skipIf(!awaitingM1)("EV-05 without M1 stays real (MA-006), never tolerated", () => {
    const r = runScenario(rules(), scenarios.find((s) => s.id === "EV-05")!);
    expect(r.actual.validity).toBe("real");
  });

  it("has zero unsafe closures and 100 % field accuracy (except scenarios awaiting a rules merge)", () => {
    const rep = evaluateScenarios(rules(), scenarios);
    expect(rep.unsafeClosures).toEqual([]);
    expect(rep.results.filter((r) => r.diffs.length && !blocked.has(r.scenario.id)).map((r) => r.scenario.id)).toEqual([]);
  });

  it("EV-22 carries penetracion_mayor; EV-23 goes to human review", () => {
    const by = (id: string) => runScenario(rules(), scenarios.find((s) => s.id === id)!);
    expect(by("EV-22").clash.classification.tags).toContain("penetracion_mayor");
    const ev23 = by("EV-23").clash.classification;
    expect(ev23.humanReview).toBe(true);
    expect(ev23.confidence).toBe(0.4);
  });

  it("EV-01 reproduces the priority-scoring worked example (67 -> floor 75)", () => {
    const r = runScenario(rules(), scenarios.find((s) => s.id === "EV-01")!);
    expect(r.clash.priority.rawScore).toBe(67);
    expect(r.clash.priority.score).toBe(75);
    expect(r.clash.priority.overrides).toContain("OVR-002");
  });
});

describe("symmetry: swapping left and right never changes the outcome", () => {
  it.each(scenarios.map((s) => [s.id, s] as const))("%s", (_id, s) => {
    const rs = rules();
    const fwd = evaluatePair(rs, { distanceMm: s.dist * 1000 }, s.left, s.right);
    const rev = evaluatePair(rs, { distanceMm: s.dist * 1000 }, s.right, s.left);
    const pick = (c: typeof fwd) => ({
      ruleId: c.classification.ruleId,
      validity: c.classification.validity,
      nature: c.classification.nature,
      rootCause: c.classification.rootCause,
      responsibleDiscipline: c.classification.responsibleDiscipline,
      secondaryDiscipline: c.classification.secondaryDiscipline,
      severity: c.classification.severity,
      moverDiscipline: c.classification.moverDiscipline,
      tags: [...c.classification.tags].sort(),
      score: c.priority.score,
      band: c.priority.band,
    });
    expect(pick(rev)).toEqual(pick(fwd));
    // Binding follows the mover / discipline order (resolution 12), never ACC left/right,
    // so even the rationale is identical for every rule.
    expect(rev.classification.rationale).toBe(fwd.classification.rationale);
    expect(rev.classification.notes).toEqual(fwd.classification.notes);
  });

  it("binding records which raw side was bound to `a`", () => {
    const s = scenarios.find((x) => x.id === "EV-20")!; // left = beam, right = ceiling; rule binds a = ceiling
    const fwd = evaluatePair(rules(), { distanceMm: s.dist * 1000 }, s.left, s.right);
    const rev = evaluatePair(rules(), { distanceMm: s.dist * 1000 }, s.right, s.left);
    expect(fwd.classification.binding.a).toBe("right");
    expect(rev.classification.binding.a).toBe("left");
  });
});
