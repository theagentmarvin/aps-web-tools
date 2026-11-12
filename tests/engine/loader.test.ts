import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuleSet, RulesLoadError } from "../../core/rules";
import { loadRulesFromDisk } from "../../server/rules-loader";
import { ROOT, sources } from "./helpers";

function issuesOf(mutate: (s: ReturnType<typeof sources>) => void) {
  const s = sources();
  mutate(s);
  try {
    loadRuleSet(s);
  } catch (e) {
    expect(e).toBeInstanceOf(RulesLoadError);
    return (e as RulesLoadError).issues;
  }
  throw new Error("expected RulesLoadError");
}

describe("rules loader", () => {
  it("loads the repository rule files (objects and YAML strings give the same hash)", () => {
    const fromDisk = loadRulesFromDisk();
    expect(fromDisk.rules.length).toBeGreaterThan(70);
    expect(fromDisk.rules[fromDisk.rules.length - 1]!.id).toBe("DEF-999");
    expect(fromDisk.holidays.has("2026-12-08")).toBe(true);
    const s = sources();
    const fromObjects = loadRuleSet(s);
    expect(fromObjects.hash).toBe(fromDisk.hash);
    const read = (f: string) => readFileSync(path.join(ROOT, "rules", f), "utf8");
    const fromText = loadRuleSet({ matrix: read("discipline-matrix.yaml"), classification: read("classification-rules.yaml"), scoring: read("priority-scoring.yaml") });
    expect(fromText.hash).toBe(fromDisk.hash);
  });

  const cases: Array<[string, (s: ReturnType<typeof sources>) => void, string, string, RegExp]> = [
    ["unknown top-level field", (s) => { s.classification.extra = 1; }, "classification-rules", "", /unknown field\(s\): extra/],
    ["unknown field in rule then", (s) => { s.classification.rules[3].then.priority = 2; }, "classification-rules", "rules[3].then", /unknown field\(s\): priority/],
    ["unknown when block", (s) => { s.classification.rules[0].when.c = {}; }, "classification-rules", "rules[0].when", /unknown field\(s\): c/],
    ["bad enum", (s) => { s.classification.rules[0].then.validity = "maybe"; }, "classification-rules", "rules[0].then.validity", /./],
    ["bad rule id", (s) => { s.classification.rules[0].id = "hyg-1"; }, "classification-rules", "rules[0].id", /\[A-Z\]/],
    ["unknown matcher field", (s) => { s.classification.rules[5].when.a = { colour: "red" }; }, "classification-rules", "rules[5].when.a.colour", /unknown element field 'colour'/],
    ["unknown operator", (s) => { s.classification.rules[5].when.a = { sizeMm: { near: 3 } }; }, "classification-rules", "rules[5].when.a.sizeMm.near", /unknown operator 'near'/],
    ["unknown set name", (s) => { s.classification.rules[5].when.b = { elementClass: { inSet: "MEP_ALL" } }; }, "classification-rules", "rules[5].when.b.elementClass.inSet", /unknown classSets name 'MEP_ALL'/],
    ["duplicate rule id", (s) => { s.classification.rules[1].id = s.classification.rules[0].id; }, "classification-rules", "rules[1].id", /duplicate rule id/],
    ["unknown discipline ref", (s) => { s.classification.rules[0].then.responsibleDiscipline = "PLOM"; }, "classification-rules", "rules[0].then.responsibleDiscipline", /unknown discipline code 'PLOM'/],
    ["bad placeholder", (s) => { s.classification.rules[0].then.rationale = "x {a.colour} y"; }, "classification-rules", "rules[0].then.rationale", /unknown field 'colour'/],
    ["malformed placeholder", (s) => { s.classification.rules[0].then.rationale = "x {weird} y"; }, "classification-rules", "rules[0].then.rationale", /bad placeholder/],
    ["annotation matcher error", (s) => { s.classification.annotations[0].when.a = { modelAge: { gt: 1 } }; }, "classification-rules", "annotations[0].when.a.modelAge", /unknown element field/],
    ["matrix: unknown class in classSets", (s) => { s.matrix.classSets.STRUCTURE.push("beam"); }, "discipline-matrix", "classSets.STRUCTURE[6]", /unknown element class 'beam'/],
    ["matrix: bad flag matcher", (s) => { s.matrix.derivedFlags[0].when = { phase: "x" }; }, "discipline-matrix", "derivedFlags[0].when.phase", /unknown element field/],
    ["matrix: unknown discipline group", (s) => { s.matrix.disciplines[0].group = "XX"; }, "discipline-matrix", "disciplines[0].group", /unknown group/],
    ["matrix: tolerance class token", (s) => { s.matrix.tolerances.entries[2].classes[1] = "@NOPE"; }, "discipline-matrix", "tolerances.entries[2].classes[1]", /unknown class set '@NOPE'/],
    ["matrix: whoMoves mover", (s) => { s.matrix.whoMoves.overrides[0].mover = "pipez"; }, "discipline-matrix", "whoMoves.overrides[0].mover", /unknown element class 'pipez'/],
    ["matrix: bad regex", (s) => { s.matrix.systemClassificationAliases.Storm.push("(("); }, "discipline-matrix", "systemClassificationAliases.Storm[2]", /invalid regex/],
    ["scoring: weights must sum to 1", (s) => { s.scoring.weights.severity = 0.5; }, "priority-scoring", "weights", /sum to 1/],
    ["scoring: unknown override field", (s) => { s.scoring.overrides[0].when = { colour: "red" }; }, "priority-scoring", "overrides[0].when.colour", /unknown field 'colour'/],
    ["scoring: unknown override value", (s) => { s.scoring.overrides[1].when = { severity: "huge" }; }, "priority-scoring", "overrides[1].when.severity", /unknown severity value/],
    ["scoring: unsorted points", (s) => { s.scoring.factors.penetration.points = [[10, 0], [0, 1]]; }, "priority-scoring", "factors.penetration.points", /sorted/],
    ["scoring: unknown factor field", (s) => { s.scoring.factors.groupCount.cap = 3; }, "priority-scoring", "factors.groupCount", /unknown field\(s\): cap/],
    ["holidays: unquoted/invalid date", (s) => { s.holidays.holidays[0].date = "1/1/2026"; }, "holidays", "holidays[0].date", /YYYY-MM-DD/],
  ];

  it.each(cases)("%s", (_name, mutate, file, p, msg) => {
    const issues = issuesOf(mutate);
    const hit = issues.find((i) => i.file === file && i.path === p);
    expect(hit, JSON.stringify(issues)).toBeDefined();
    expect(hit!.message).toMatch(msg);
  });

  it("reports YAML syntax errors and collects all issues before throwing", () => {
    let err: RulesLoadError | undefined;
    try {
      loadRuleSet({ matrix: "a: [1,", classification: "{}", scoring: "{}" });
    } catch (e) {
      err = e as RulesLoadError;
    }
    expect(err).toBeInstanceOf(RulesLoadError);
    expect(err!.issues.some((i) => i.file === "discipline-matrix" && /YAML parse error/.test(i.message))).toBe(true);
    expect(err!.issues.some((i) => i.file === "priority-scoring")).toBe(true);
    expect(err!.message).toMatch(/priority-scoring\.yaml/);
  });

  it("an unquoted comma in a flow mapping is caught (fail closed)", () => {
    const text = readFileSync(path.join(ROOT, "rules", "discipline-matrix.yaml"), "utf8").replace(
      'es: "Proteccion contra incendio (red humeda, red seca, rociadores)"',
      "es: Proteccion contra incendio (red humeda, red seca, rociadores)",
    );
    expect(() => loadRuleSet({ ...sources(), matrix: text })).toThrow(/disciplines\[14\]: unknown field/);
  });
});
