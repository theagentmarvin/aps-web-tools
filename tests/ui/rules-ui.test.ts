/** Reglas UI logic: form ↔ rule round-trip over the real rules, grouping by discipline pair, i18n. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import es from "../../src/i18n/es.json";
import en from "../../src/i18n/en.json";
import type { RuleDefinition, RuleRow } from "../../src/lib/api/types";
import { formToRule, normalizeRule, ruleToForm } from "../../src/features/rules/rule-form";
import { accuracyTone, GROUP_GENERAL, GROUP_HYGIENE, groupRulesByPair, pairKeyOf } from "../../src/features/rules/rule-groups";

const rules = (parse(readFileSync(join(__dirname, "..", "..", "rules", "classification-rules.yaml"), "utf8")) as { rules: RuleDefinition[] }).rules;

describe("rule form", () => {
  it("round-trips every rule the guided form can express; the rest go to the YAML editor", () => {
    let fit = 0;
    for (const r of rules) {
      const f = ruleToForm(r);
      if (!f) continue;
      fit++;
      expect(normalizeRule(formToRule(f))).toEqual(normalizeRule(r));
    }
    expect(fit).toBeGreaterThan(rules.length / 2);
    // anyOf / refs exceed the form.
    expect(ruleToForm(rules.find((r) => r.id === "INC-001")!)).toBeNull();
    expect(ruleToForm(rules.find((r) => r.id === "EST-005")!)).toMatchObject({ a: { classSet: "MEP_DIST", sizeMin: 100 }, b: { classes: ["structure_framing"] } });
  });

  it("editing the form changes only what was edited", () => {
    const f = ruleToForm(rules.find((r) => r.id === "EST-005")!)!;
    f.a.sizeMin = 150;
    f.penetrationMinMm = 25;
    f.nameEs = "Instalación ≥ 150 mm atraviesa viga";
    const r = formToRule(f);
    expect(r.when).toEqual({ clash: { penetrationMm: { gte: 25 } }, a: { elementClass: { inSet: "MEP_DIST" }, sizeMm: { gte: 150 } }, b: { elementClass: "structure_framing" } });
    expect(r.nameEs).toBe("Instalación ≥ 150 mm atraviesa viga");
    expect(r.then).toEqual(rules.find((x) => x.id === "EST-005")!.then);
  });
});

describe("grouping by discipline pair", () => {
  const row = (id: string, section: string, sides: [string | null, string | null], fallback = false) => ({ id, section, sides, fallback }) as Pick<RuleRow, "section" | "sides" | "fallback"> & { id: string };
  it("hygiene first, pairs in file order (unordered), general last", () => {
    const g = groupRulesByPair([row("EST-001", "EST", ["MEP", "EST"]), row("HYG-002", "HYG", [null, null]), row("MA-001", "MA", ["MEP", "ARQ"]), row("EST-005", "EST", ["EST", "MEP"]), row("DUP-001", "DUP", [null, null]), row("DEF-999", "DEF", [null, null], true), row("FP-001", "FP", [null, null])]);
    expect(g.map((x) => x.key)).toEqual([GROUP_HYGIENE, "EST×MEP", "ARQ×MEP", GROUP_GENERAL]);
    expect(g[1]!.rows.map((r) => r.id)).toEqual(["EST-001", "EST-005"]);
    expect(g[3]!.rows.map((r) => r.id)).toEqual(["DEF-999", "FP-001"]);
    expect(pairKeyOf(row("X", "MM", ["MEP", null]))).toBe("MEP×*");
  });
  it("acierto: sin datos below the minimum n, low below 70 %", () => {
    expect(accuracyTone({ agree: 1, n: 2, rate: null })).toBe("none");
    expect(accuracyTone({ agree: 3, n: 6, rate: 0.5 })).toBe("low");
    expect(accuracyTone({ agree: 6, n: 6, rate: 1 })).toBe("ok");
  });
});

describe("i18n", () => {
  it("every rules.board key exists in es and en", () => {
    const flat = (o: Record<string, unknown>, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));
    const esKeys = flat((es as Record<string, Record<string, unknown>>).rules.board as Record<string, unknown>);
    const enKeys = flat((en as Record<string, Record<string, unknown>>).rules.board as Record<string, unknown>);
    expect(esKeys.length).toBeGreaterThan(20);
    expect(enKeys.sort()).toEqual(esKeys.sort());
  });
});
