/**
 * Validity wording (owner decision 2026-11-10): the UI never says "Real" /
 * "Falso positivo"; each label has a one-line definition (tooltip). API values
 * (real, false_positive, tolerated, needs_info) are unchanged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const load = (lang: string) => JSON.parse(readFileSync(join(__dirname, "../../src/i18n", `${lang}.json`), "utf8")) as { validity: Record<string, unknown> };

describe("validity labels", () => {
  it("use the owner's wording in es and en", () => {
    const es = load("es").validity;
    const en = load("en").validity;
    expect([es.valid, es.falsePositive, es.tolerable, es.needsInfo]).toEqual(["Conflicto", "No es problema", "Dentro de tolerancia", "Falta información"]);
    expect([en.valid, en.falsePositive, en.tolerable, en.needsInfo]).toEqual(["Clash", "Not an issue", "Within tolerance", "Needs info"]);
  });

  it("every label has a definition that starts with the label", () => {
    for (const lang of ["es", "en"]) {
      const v = load(lang).validity as Record<string, string> & { tip: Record<string, string> };
      for (const k of ["valid", "falsePositive", "tolerable", "needsInfo"]) expect(v.tip[k].startsWith(`${v[k]}:`)).toBe(true);
    }
  });
});
