/**
 * Rule authoring helpers (server/rule-authoring.ts): serialisation round-trip, precedence of
 * new / restored rules, retire ↔ restore, thresholds, sides, and diffs that apply cleanly.
 * Works on strings only: the repository rules/ is never written.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { applyUnifiedPatch } from "../../server/coordinator";
import {
  ACTIVE_FILE,
  insertNewRuleInText,
  nextFreeId,
  parseArchive,
  replaceRuleInText,
  restoreRules,
  retireRules,
  ruleBlocks,
  ruleSides,
  serializeRule,
  setThreshold,
  thresholdsOf,
  touchesPolicyClass,
  unifiedDiff,
  type RawRule,
} from "../../server/rule-authoring";
import { loadRuleSet } from "../../core/rules/load";
import { ROOT } from "./helpers";

const text = readFileSync(join(ROOT, "rules", ACTIVE_FILE), "utf8").replace(/\r\n/g, "\n");
const matrix = readFileSync(join(ROOT, "rules", "discipline-matrix.yaml"), "utf8");
const scoring = readFileSync(join(ROOT, "rules", "priority-scoring.yaml"), "utf8");
const rules = (parse(text) as { rules: RawRule[] }).rules;
const ids = (t: string) => (parse(t) as { rules: RawRule[] }).rules.map((r) => r.id);
const load = (t: string) => loadRuleSet({ matrix, classification: t, scoring });

/** Apply a diff produced by unifiedDiff with the same applier the publisher uses. */
function applyDiff(before: string, diff: string): string | undefined {
  const hunks: Array<{ oldStart: number; lines: string[] }> = [];
  for (const l of diff.split("\n")) {
    const h = /^@@ -(\d+)/.exec(l);
    if (h) hunks.push({ oldStart: Number(h[1]), lines: [] });
    else if (hunks.length && !l.startsWith("---") && !l.startsWith("+++")) hunks[hunks.length - 1]!.lines.push(l);
  }
  return applyUnifiedPatch(before, hunks);
}

describe("rule authoring", () => {
  it("serialises every rule so that YAML parses back to the same object", () => {
    for (const r of rules) {
      const back = (parse(["rules:", ...serializeRule(r)].join("\n")) as { rules: RawRule[] }).rules[0];
      expect(back).toEqual(r);
    }
  });

  it("calibrate/edit keep the position; the result loads", () => {
    const r = structuredClone(rules.find((x) => x.id === "EST-005")!);
    r.then.severity = "critical";
    const out = replaceRuleInText(text, r);
    expect(ids(out)).toEqual(ids(text));
    expect(load(out).source.classification.rules.find((x) => x.id === "EST-005")!.then.severity).toBe("critical");
    expect(applyDiff(text, unifiedDiff(ACTIVE_FILE, text, out))).toBe(out);
  });

  it("a new rule goes at the end of its section, always before DEF-999", () => {
    const base = structuredClone(rules.find((x) => x.id === "FP-001")!);
    const fp = { ...base, id: nextFreeId("FP", ids(text)), nameEs: "Prueba" };
    const out = insertNewRuleInText(text, fp);
    const order = ids(out);
    const i = order.indexOf(fp.id);
    expect(order[i - 1]).toBe("FP-015");
    expect(order[i + 1]).toBe("SEI-001");
    const zz = { ...base, id: "ZZ-001" };
    const out2 = insertNewRuleInText(text, zz);
    expect(ids(out2).slice(-2)).toEqual(["ZZ-001", "DEF-999"]);
    expect(() => load(out2)).not.toThrow();
    expect(() => insertNewRuleInText(text, { ...base, id: "FP-001" })).toThrow(/Ya existe/);
  });

  it("retire moves rules to the Biblioteca; restore puts them back in the same precedence", () => {
    const retired = retireRules({ active: text, archive: "" }, ["FP-003", "FP-004", "EST-005", "MM-010"], { at: "2026-11-10", reason: "sin uso" });
    expect(ids(retired.active)).not.toContain("FP-003");
    expect(ids(retired.active)).toContain("DEF-999");
    expect(() => load(retired.active)).not.toThrow();
    const lib = parseArchive(retired.archive);
    expect(lib.map((e) => e.id)).toEqual(["FP-003", "FP-004", "EST-005", "MM-010"]);
    expect(lib.find((e) => e.id === "FP-004")!.precededBy[0]).toBe("FP-003");
    // Restore one whose nearest predecessor is still retired: anchors on the next one up.
    const r1 = restoreRules(retired, ["FP-004"]);
    const o1 = ids(r1.active);
    expect(o1[o1.indexOf("FP-004") - 1]).toBe("FP-002");
    // Restoring all gives back the original order and an empty Biblioteca.
    const all = restoreRules(retired, ["MM-010", "FP-004", "EST-005", "FP-003"]);
    expect(ids(all.active)).toEqual(ids(text));
    expect(parseArchive(all.archive)).toEqual([]);
    expect(load(all.active).source.classification.rules).toEqual(load(text).source.classification.rules);
    // Diffs for both files apply cleanly (archive created from nothing).
    expect(applyDiff(text, unifiedDiff(ACTIVE_FILE, text, retired.active))).toBe(retired.active);
    expect(applyDiff("", unifiedDiff("x.yaml", "", retired.archive))).toBe(retired.archive);
    expect(() => retireRules({ active: text, archive: "" }, ["DEF-999"], { at: "x" })).toThrow(/respaldo/);
    expect(() => restoreRules(retired, ["HYG-001"])).toThrow(/Biblioteca/);
  });

  it("bulk retire of everything but a few keeps a loadable file", () => {
    const keep = new Set(["HYG-002", "EST-001", "DEF-999"]);
    const out = retireRules({ active: text, archive: "" }, ids(text).filter((i) => !keep.has(i)), { at: "2026-11-10" });
    expect(ids(out.active)).toEqual(["HYG-002", "EST-001", "DEF-999"]);
    expect(load(out.active).source.classification.annotations.length).toBe(6);
  });

  it("thresholds, sides and the structural / life-safety policy check", () => {
    const est5 = rules.find((x) => x.id === "EST-005")!;
    expect(thresholdsOf(est5)).toEqual([{ path: "a.sizeMm.gte", block: "a", field: "sizeMm", op: "gte", value: 100 }]);
    expect(thresholdsOf(setThreshold(est5, "a.sizeMm.gte", 150))[0]!.value).toBe(150);
    expect(() => setThreshold(est5, "a.sizeMm.lt", 1)).toThrow();
    expect(ruleSides(est5)).toEqual(["MEP", "EST"]);
    expect(ruleSides(rules.find((x) => x.id === "MM-010")!)).toEqual(["MEP", "MEP"]);
    expect(ruleSides(rules.find((x) => x.id === "DEF-999")!)).toEqual([null, null]);
    expect(touchesPolicyClass(est5)).toBe(true);
    expect(touchesPolicyClass(rules.find((x) => x.id === "INC-001")!)).toBe(true);
    expect(touchesPolicyClass(rules.find((x) => x.id === "MA-004")!)).toBe(false);
    expect(ruleBlocks(text.split("\n")).length).toBe(rules.length);
  });
});
