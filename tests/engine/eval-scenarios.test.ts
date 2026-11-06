import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ASSERTED_FIELDS, evaluateScenarios, parseScenarioMarkdown, runScenario } from "../../core/eval/scenarios";
import { evaluatePair } from "../../core/pipeline";
import { ROOT, rules } from "./helpers";

const scenarios = parseScenarioMarkdown(readFileSync(path.join(ROOT, "docs/domain/eval-scenarios.md"), "utf8"));

describe("eval scenarios (docs/domain/eval-scenarios.md)", () => {
  it("parses all 25 scenarios", () => {
    expect(scenarios).toHaveLength(25);
  });

  it.each(scenarios.map((s) => [s.id, s.title, s] as const))("%s %s", (_id, _title, s) => {
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

  it("has zero unsafe closures and 100 % field accuracy", () => {
    const rep = evaluateScenarios(rules(), scenarios);
    expect(rep.unsafeClosures).toEqual([]);
    expect(rep.passed).toBe(rep.total);
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
    // Rules with `a`/`b` bind the same element to `a` in both orientations, so even the
    // rationale is identical. Rules without `a`/`b` bind a = left by spec (§3): only the
    // order of the two elements in the text may change.
    const rule = rs.rules.find((r) => r.id === fwd.classification.ruleId)!;
    if (rule.when.symmetric) expect(rev.classification.rationale).toBe(fwd.classification.rationale);
  });

  it("binding records which raw side was bound to `a`", () => {
    const s = scenarios.find((x) => x.id === "EV-20")!; // left = beam, right = ceiling; rule binds a = ceiling
    const fwd = evaluatePair(rules(), { distanceMm: s.dist * 1000 }, s.left, s.right);
    const rev = evaluatePair(rules(), { distanceMm: s.dist * 1000 }, s.right, s.left);
    expect(fwd.classification.binding.a).toBe("right");
    expect(rev.classification.binding.a).toBe("left");
  });
});
