import { describe, expect, it } from "vitest";
import { addBusinessDays, buildIssueDraft, computeDueDate, lastBusinessDayBefore, nextWeekdayOnOrAfter } from "../../core/issues";
import { runCoordination } from "../../core/pipeline";
import { clash, doc, el, rules } from "./helpers";

const rs = rules();
const publishDate = "2026-11-12"; // Thursday after a Wednesday meeting (issue guide §7)

describe("business-day calendar", () => {
  it("skips weekends and Chilean holidays", () => {
    expect(addBusinessDays("2026-11-12", 3, rs.holidays)).toBe("2026-11-17");
    expect(addBusinessDays("2026-12-07", 1, rs.holidays)).toBe("2026-12-09"); // 08-12 Inmaculada Concepción
    expect(nextWeekdayOnOrAfter("2026-11-18", 3)).toBe("2026-11-18");
    expect(lastBusinessDayBefore("2026-12-09", rs.holidays)).toBe("2026-12-07");
  });
});

describe("due-date algorithm reproduces the issue-writing guide examples", () => {
  const base = { validity: "real", secondaryDiscipline: "EST", suggestedAction: "create_issue" } as const;
  it.each([
    ["Ex.1 P1 EST-004 (critical, no calculista extension)", { ...base, severity: "critical", rootCause: "design_coordination" }, "P1", "2026-11-17", /P1 · 3 días hábiles, antes de la reunión del 18-11/],
    ["Ex.2 P1 EST-002", { ...base, severity: "critical", rootCause: "design_coordination" }, "P1", "2026-11-17", /18-11/],
    ["Ex.3 P2 INC-001", { ...base, secondaryDiscipline: "CLI", severity: "high", rootCause: "design_coordination" }, "P2", "2026-11-24", /25-11/],
    ["Ex.4 P3 EST-009 (owner EST, secondary AP)", { ...base, secondaryDiscipline: "AP", severity: "medium", rootCause: "missing_opening" }, "P3", "2026-12-01", /02-12/],
    ["Ex.5 hygiene", { ...base, validity: "false_positive", severity: "none", rootCause: "duplicate_model", suggestedAction: "hygiene_issue" }, "P3", "2026-11-23", /higiene · próximo corte/],
  ] as const)("%s", (_n, g, band, due, rule) => {
    const r = computeDueDate(rs, g, band, { publishDate });
    expect(r.dueDate).toBe(due);
    expect(r.dueRule).toMatch(rule);
  });

  it("adds 5 business days for a calculista approval (non-critical opening in structure)", () => {
    const r = computeDueDate(rs, { validity: "real", severity: "high", rootCause: "missing_opening", secondaryDiscipline: "EST", suggestedAction: "create_issue" }, "P2", { publishDate });
    // bd(7) = 23-11, +5 = 30-11, meeting 02-12 -> 01-12
    expect(r.dueDate).toBe("2026-12-01");
    expect(r.dueRule).toMatch(/\+ 5 por aprobación del calculista/);
  });

  it("needs_info: 5 business days, snapped to the meeting", () => {
    const r = computeDueDate(rs, { validity: "needs_info", severity: "low", rootCause: "lod_mismatch", suggestedAction: "request_info" }, "P3", { publishDate });
    // bd(5) = 19-11 (Thu) -> first meeting >= 19-11 is 25-11 -> last business day before = 24-11
    expect(r.dueDate).toBe("2026-11-24");
    expect(r.dueRule).toMatch(/^solicitud de información · 5 días hábiles, antes de la reunión del 25-11$/);
  });
});

describe("issue draft from a group (compact plain-text template)", () => {
  const documents = [doc(1, "P2401-SLF-ZZ-ZZ-M3-S-0001.rvt"), doc(4, "P2401-CLI.rvt"), doc(2, "P2401_ARQ_TorreA.rvt")];
  const duct = el(4, 1, { category: "Revit Ducts", family: "Ducto rectangular", type: "Galvanizado", systemName: "INY-UMA-2", systemType: "Inyección", widthMm: 600, heightMm: 400, level: "Piso 4", documentName: "P2401-CLI.rvt" });
  const beams = Array.from({ length: 14 }, (_, i) => el(1, 100 + i, { category: "Revit Structural Framing", family: "Viga HA", type: "V 30x70", widthMm: 300, heightMm: 700, level: "Piso 4" }));
  const r = runCoordination({ clashes: beams.map((b, i) => clash(8800 + i, [4, 1], [1, b.lmvId], -320)), elements: [duct, ...beams], documents, rules: rs });
  const opts = { publishDate, location: "Eje B-E/2-3", testId: "8812", modelSetVersion: 37, assignees: { CLI: { type: "company" as const, name: "Clima Ingeniería Ltda." } } };
  const draft = buildIssueDraft(rs, r.groups[0]!, r.classified, opts);

  it("builds the guide's title pattern (band, pair, level, location, what, max penetration)", () => {
    expect(draft.title).toBe("[P1][CLI×EST] Piso 4 · Eje B-E/2-3 · Ducto INY-UMA-2 600x400 atraviesa 14 vigas EST (máx. 320 mm)");
    expect(draft.title.length).toBeLessThanOrEqual(100);
  });

  it("drops location, then names, then the max penetration when the title is long", () => {
    const long = buildIssueDraft(rs, r.groups[0]!, r.classified, { ...opts, location: "Pasillo central del sector norte, entre los ejes B y E" });
    expect(long.title.length).toBeLessThanOrEqual(100);
    expect(long.title.startsWith("[P1][CLI×EST] Piso 4 · ")).toBe(true);
    expect(long.title).toContain("14 vigas");
  });

  it("is plain text, ≤ 950 characters, with the template sections in order", () => {
    expect(draft.format).toBe("text");
    expect(draft.description.length).toBeLessThanOrEqual(950);
    expect(draft.description).not.toMatch(/\*\*|^#|`/m);
    const labels = ["PROBLEMA:", "UBICACIÓN:", "POR QUÉ:", "ACCIÓN (CLI (Clima Ingeniería Ltda.)):", "CONSULTAR: EST (calculista).", "PLAZO: 17-11-2026 (P1 · 3 días hábiles, antes de la reunión del 18-11).", "REF: "];
    let pos = -1;
    for (const l of labels) {
      const i = draft.description.indexOf(l);
      expect(i, l).toBeGreaterThan(pos);
      pos = i;
    }
    expect(draft.description).toMatch(/REF: G-[0-9a-f]{10} · 14 interf\. · EST-004 · conjunto v37/);
    expect(draft.description).toMatch(/sujeta a aprobación del calculista/);
    expect(draft.description).not.toMatch(/\baprobad[oa]\b/);
    expect(draft).toMatchObject({ band: "P1", responsibleDiscipline: "CLI", secondaryDiscipline: "EST", dueDate: "2026-11-17", ruleIds: ["EST-004"], draftedBy: "engine" });
    expect(draft.watchers).toEqual(["EST"]);
    expect(draft.clashIds).toHaveLength(14);
    expect(draft.placement.externalId).toBe("4-1");
  });

  it("multi-element groups describe the size range, not one element", () => {
    const ducts = Array.from({ length: 4 }, (_, i) => el(4, 20 + i, { category: "Ducts", systemName: `RET-${i}`, widthMm: 250 + 30 * i, heightMm: 250, level: "Nivel 1" }));
    const bs = Array.from({ length: 4 }, (_, i) => el(1, 300 + i, { category: "Structural Framing", type: "V 25x60", widthMm: 250, heightMm: 600, level: "Nivel 1" }));
    const rr = runCoordination({ clashes: ducts.map((d, i) => clash(9000 + i, [4, d.lmvId], [1, bs[i]!.lmvId], -120)), elements: [...ducts, ...bs], documents, rules: rs });
    const g = rr.groups.find((x) => x.strategy === "zone")!;
    expect(g.title).toBe("Nivel 1: 4 ductos CLI vs 4 vigas de EST (4 interf.)");
    const d = buildIssueDraft(rs, g, rr.classified, { publishDate });
    expect(d.title).toMatch(/^\[P\d\]\[CLI×EST\] Nivel 1 · 4 ductos CLI atraviesan vigas EST \(máx\. 120 mm\)$/);
    expect(d.description).toMatch(/PROBLEMA: 4 ductos de CLI \(RET-0, RET-1, RET-2…; 250x250 a 340x250\) atraviesan vigas de EST\. Penetración máx\. 120 mm\./);
  });

  it("builds hygiene drafts too (P3, cut-off date, single owner)", () => {
    const arq = Array.from({ length: 3 }, (_, i) => el(2, 50 + i, { category: "Revit Muros", type: "Muro HA 20", widthMm: 200, level: "Piso 3" }));
    const est = Array.from({ length: 3 }, (_, i) => el(1, 50 + i, { category: "Revit Muros", type: "M HA e=20", widthMm: 200, level: "Piso 3" }));
    const rr = runCoordination({ clashes: arq.map((a, i) => clash(10 + i, [2, a.lmvId], [1, est[i]!.lmvId], -200)), elements: [...arq, ...est], documents, rules: rs });
    const g = rr.groups.find((x) => x.strategy === "hygiene")!;
    const d = buildIssueDraft(rs, g, rr.classified, { publishDate });
    expect(d.title).toBe("[P3][ARQ] Piso 3 · Higiene · ARQ remodela muros estructurales en P2401_ARQ_TorreA.rvt (3)");
    expect(d.dueDate).toBe("2026-11-23");
    expect(d.description).toMatch(/ACCIÓN \(ARQ\): 1\. Eliminar los muros HA del modelo ARQ/);
    expect(d.description.length).toBeLessThanOrEqual(950);
  });
});
