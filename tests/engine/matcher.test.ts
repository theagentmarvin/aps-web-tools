import { describe, expect, it } from "vitest";
import { compileMatcher, withNormCache, type Facts, type MatcherEnv } from "../../core/rules/matcher";
import type { LoadIssue } from "../../core/rules/errors";

const env: MatcherEnv = {
  elementFields: new Set(["category", "type", "family", "sizeMm", "discipline", "disciplineGroup", "elementClass", "isFoo", "level", "structural", "modelAgeDays"]),
  clashFields: new Set(["distanceMm", "penetrationMm", "penetrationRatio", "sameType", "status"]),
  categorySets: new Map([["PIPE_CATS", new Set(["pipes", "pipe fittings"])]]),
  classSets: new Map([["STRUCTURE", new Set(["structure_framing", "structure_floor"])]]),
  disciplineCodes: new Set(["EST", "CLI", "ELE", "GAS"]),
  groups: new Set(["EST", "MEP"]),
  foreignField: "__foreign",
};

function m(spec: unknown, kind: "element" | "clash" = "element") {
  const issues: LoadIssue[] = [];
  const p = compileMatcher(spec, kind, env, "classification-rules", "t", issues);
  return { p, issues };
}
function ok(spec: unknown, f: Facts, ctx = {}, kind: "element" | "clash" = "element"): boolean {
  const { p, issues } = m(spec, kind);
  expect(issues).toEqual([]);
  return p(withNormCache({ ...f }), ctx);
}

const pipe = { category: "Pipes", type: "PVC Sanitário  ", sizeMm: 110, isFoo: false, level: "Piso 3", structural: true };
const empty = { isFoo: false };

describe("matcher DSL", () => {
  it("scalar equals, normalized (case, accents, whitespace)", () => {
    expect(ok({ type: "pvc sanitario" }, pipe)).toBe(true);
    expect(ok({ category: "PIPES" }, pipe)).toBe(true);
    expect(ok({ category: "Ducts" }, pipe)).toBe(false);
    expect(ok({ isFoo: false }, pipe)).toBe(true);
    expect(ok({ structural: true }, pipe)).toBe(true);
    expect(ok({ sizeMm: 110 }, pipe)).toBe(true);
    expect(ok({ category: "Pipes" }, empty)).toBe(false); // missing -> false
  });

  it("list = in", () => {
    expect(ok({ category: ["Ducts", "Pipes"] }, pipe)).toBe(true);
    expect(ok({ category: ["Ducts"] }, pipe)).toBe(false);
    expect(ok({ category: ["Ducts", "Pipes"] }, empty)).toBe(false);
  });

  it("eq / ne", () => {
    expect(ok({ category: { eq: "pipes" } }, pipe)).toBe(true);
    expect(ok({ category: { eq: "Pipes" } }, empty)).toBe(false);
    expect(ok({ category: { ne: "Ducts" } }, pipe)).toBe(true);
    expect(ok({ category: { ne: "Pipes" } }, pipe)).toBe(false);
    expect(ok({ category: { ne: "Pipes" } }, empty)).toBe(true); // negative op on missing -> true
  });

  it("in / notIn", () => {
    expect(ok({ category: { in: ["Pipes", "Ducts"] } }, pipe)).toBe(true);
    expect(ok({ category: { in: ["Pipes"] } }, empty)).toBe(false);
    expect(ok({ category: { notIn: ["Ducts"] } }, pipe)).toBe(true);
    expect(ok({ category: { notIn: ["Pipes"] } }, pipe)).toBe(false);
    expect(ok({ category: { notIn: ["Pipes"] } }, empty)).toBe(true);
  });

  it("matches / notMatches on the normalized string", () => {
    expect(ok({ type: { matches: "^pvc sanitario$" } }, pipe)).toBe(true);
    expect(ok({ type: { matches: "sanitário" } }, pipe)).toBe(false); // patterns are written without accents
    expect(ok({ type: { matches: "pvc" } }, empty)).toBe(false);
    expect(ok({ type: { notMatches: "acero" } }, pipe)).toBe(true);
    expect(ok({ type: { notMatches: "pvc" } }, pipe)).toBe(false);
    expect(ok({ type: { notMatches: "pvc" } }, empty)).toBe(true);
  });

  it("gt / gte / lt / lte / between", () => {
    expect(ok({ sizeMm: { gt: 100 } }, pipe)).toBe(true);
    expect(ok({ sizeMm: { gt: 110 } }, pipe)).toBe(false);
    expect(ok({ sizeMm: { gte: 110 } }, pipe)).toBe(true);
    expect(ok({ sizeMm: { lt: 110 } }, pipe)).toBe(false);
    expect(ok({ sizeMm: { lte: 110 } }, pipe)).toBe(true);
    expect(ok({ sizeMm: { between: [100, 110] } }, pipe)).toBe(true);
    expect(ok({ sizeMm: { between: [111, 200] } }, pipe)).toBe(false);
    expect(ok({ sizeMm: { gt: 0 } }, empty)).toBe(false);
    expect(ok({ sizeMm: { between: [0, 1e9] } }, empty)).toBe(false);
    expect(ok({ sizeMm: { gte: 100, lte: 120 } }, pipe)).toBe(true); // all ops must hold
    expect(ok({ sizeMm: { gte: 100, lte: 105 } }, pipe)).toBe(false);
  });

  it("exists true / false", () => {
    expect(ok({ level: { exists: true } }, pipe)).toBe(true);
    expect(ok({ level: { exists: true } }, empty)).toBe(false);
    expect(ok({ level: { exists: false } }, empty)).toBe(true);
    expect(ok({ level: { exists: false } }, { ...empty, level: "" })).toBe(true); // empty string is missing
  });

  it("inSet on category (categorySets) and elementClass (classSets)", () => {
    expect(ok({ category: { inSet: "PIPE_CATS" } }, pipe)).toBe(true);
    expect(ok({ category: { inSet: "PIPE_CATS" } }, { category: "Ducts" })).toBe(false);
    expect(ok({ category: { inSet: "PIPE_CATS" } }, empty)).toBe(false);
    expect(ok({ elementClass: { inSet: "STRUCTURE" } }, { elementClass: "structure_floor" })).toBe(true);
    expect(ok({ elementClass: { inSet: "STRUCTURE" } }, { elementClass: "pipe" })).toBe(false);
  });

  it("anyOf / not / AND across keys", () => {
    expect(ok({ anyOf: [{ category: "Ducts" }, { sizeMm: { gte: 100 } }] }, pipe)).toBe(true);
    expect(ok({ anyOf: [{ category: "Ducts" }, { sizeMm: { gte: 200 } }] }, pipe)).toBe(false);
    expect(ok({ not: { category: "Ducts" } }, pipe)).toBe(true);
    expect(ok({ not: { category: "Pipes" } }, pipe)).toBe(false);
    expect(ok({ category: "Pipes", sizeMm: { lt: 50 } }, pipe)).toBe(false);
    expect(ok({}, pipe)).toBe(true);
  });

  it("numeric refs with factor; missing ref -> false", () => {
    const a = withNormCache({ sizeMm: 20 });
    const b = withNormCache({ sizeMm: 150 });
    const spec = { sizeMm: { lte: { ref: "b.sizeMm", factor: 0.333 } } };
    expect(ok(spec, a, { a, b })).toBe(true);
    expect(ok(spec, { sizeMm: 63 }, { a, b })).toBe(false);
    expect(ok(spec, a, { a, b: withNormCache({}) })).toBe(false);
    expect(ok({ sizeMm: { gt: { ref: "clash.penetrationMm" } } }, a, { clash: { penetrationMm: 10 } })).toBe(true);
  });

  it("disciplinePair in clash matchers: unordered, codes, @GROUP, *", () => {
    const a = { discipline: "GAS", disciplineGroup: "MEP" };
    const b = { discipline: "ELE", disciplineGroup: "MEP" };
    const c = { distanceMm: -5 };
    expect(ok({ disciplinePair: ["ELE", "GAS"] }, c, { a, b }, "clash")).toBe(true);
    expect(ok({ disciplinePair: ["GAS", "ELE"] }, c, { a: b, b: a }, "clash")).toBe(true);
    expect(ok({ disciplinePair: [["EST", "*"], ["@MEP", "@MEP"]] }, c, { a, b }, "clash")).toBe(true);
    expect(ok({ disciplinePair: ["EST", "*"] }, c, { a, b }, "clash")).toBe(false);
  });

  it("foreignCheck reads the engine-native flag", () => {
    expect(ok({ foreignCheck: true }, { __foreign: true })).toBe(true);
    expect(ok({ foreignCheck: true }, { __foreign: false })).toBe(false);
    expect(ok({ foreignCheck: false }, {})).toBe(true);
  });

  describe("load errors carry precise paths", () => {
    const cases: Array<[string, unknown, "element" | "clash", string, RegExp]> = [
      ["unknown field", { colour: "red" }, "element", "t.colour", /unknown element field 'colour'/],
      ["unknown op", { sizeMm: { approx: 3 } }, "element", "t.sizeMm.approx", /unknown operator 'approx'/],
      ["unknown category set", { category: { inSet: "NOPE" } }, "element", "t.category.inSet", /unknown categorySets name 'NOPE'/],
      ["unknown class set", { elementClass: { inSet: "NOPE" } }, "element", "t.elementClass.inSet", /unknown classSets name 'NOPE'/],
      ["inSet on wrong field", { type: { inSet: "PIPE_CATS" } }, "element", "t.type.inSet", /only valid/],
      ["bad regex", { type: { matches: "(" } }, "element", "t.type.matches", /invalid regex/],
      ["bad between", { sizeMm: { between: [5] } }, "element", "t.sizeMm.between", /between expects/],
      ["bad ref", { sizeMm: { lte: { ref: "c.sizeMm" } } }, "element", "t.sizeMm.lte.ref", /bad ref/],
      ["unknown ref field", { sizeMm: { lte: { ref: "b.weight" } } }, "element", "t.sizeMm.lte.ref", /unknown element field 'weight'/],
      ["nested anyOf path", { anyOf: [{ category: "Pipes" }, { colour: 1 }] }, "element", "t.anyOf[1].colour", /unknown element field/],
      ["clash field in element matcher", { distanceMm: { lt: 0 } }, "element", "t.distanceMm", /unknown element field/],
      ["unknown discipline token", { disciplinePair: ["EST", "XYZ"] }, "clash", "t.disciplinePair[0][1]", /unknown discipline token/],
      ["disciplinePair in element matcher", { disciplinePair: ["EST", "*"] }, "element", "t.disciplinePair", /only valid in clash/],
    ];
    it.each(cases)("%s", (_name, spec, kind, path, msg) => {
      const { issues } = m(spec, kind);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]!.path).toBe(path);
      expect(issues[0]!.message).toMatch(msg);
    });
  });
});
