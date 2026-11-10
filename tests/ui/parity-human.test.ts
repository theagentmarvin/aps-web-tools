/** Human-side parity UI helpers: cycle report builder, notes parsing, merge candidates, i18n coverage. */
import { describe, expect, it } from "vitest";
import es from "../../src/i18n/es.json";
import en from "../../src/i18n/en.json";
import type { ReportData, TriageFamily } from "../../src/lib/api/types";
import { cycleReportMarkdown, markdownToPrintableHtml, reportFileName } from "../../src/features/modelset/cycle-report";
import { noteLines } from "../../src/features/modelset/project-notes";
import { mergeCandidates } from "../../src/features/triage/family-regroup";

const report: ReportData = {
  scope: { projectId: "p", modelSetId: "m" },
  kpis: { activeClashes: 120, activeClashesPrev: 150, groups: 40, rawClashes: 300, groupsReviewed: 12, issuesCreated: 3, aiAccepted: 10, aiCorrected: 2, aiRejected: 1, rawClashesReviewed: 80, actualReviewSeconds: 600 },
  burndown: [],
  disciplines: [],
  matrix: {},
  byStatusPair: [{ pair: "CLI×EST", active: 30, reviewed: 4, resolved: 2, closed: 1 }],
  newVsResolved: [{ label: "v42", new: 12, resolved: 40 }],
  reasons: [{ code: "R02", count: 4 }],
  calibration: [],
  p1Aging: { lt1w: 1, w1to2: 2, w2to4: 0, gt4w: 0 },
};

describe("cycle report", () => {
  it("lays out only server numbers, with the delta vs the previous version", () => {
    const md = cycleReportMarkdown(report, { projectName: "Edificio <A>", modelSetName: "Coordinación", date: "2026-11-10" });
    expect(md).toMatch(/^# Informe del ciclo de coordinación/);
    expect(md).toContain("| Interferencias activas | 120 (-30 vs versión anterior) |");
    expect(md).toContain("| CLI×EST | 30 | 4 | 2 | 1 |");
    expect(md).toContain("- R02: 4");
  });
  it("escapes everything in the printable HTML (model and project names are untrusted)", () => {
    const md = cycleReportMarkdown(report, { projectName: "<script>alert(1)</script>", modelSetName: "x", date: "2026-11-10" });
    const html = markdownToPrintableHtml(md, "Informe");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<table>");
  });
  it("file names are slugged", () => {
    expect(reportFileName({ projectName: "p", modelSetName: "Coordinación General / Torre A", date: "2026-11-10" }, "md")).toBe("2026-11-10-informe-ciclo-Coordinacion-General-Torre-A.md");
  });
});

describe("project notes", () => {
  it("keeps only the dated bullet lines", () => {
    expect(noteLines("# Notas del proyecto x\n\n- 2026-11-10 · [convención] A (confirmado por coordinador)\n\ntexto suelto\n- 2026-11-11 · [decisión] B (confirmado por coordinador)\n")).toEqual([
      "2026-11-10 · [convención] A (confirmado por coordinador)",
      "2026-11-11 · [decisión] B (confirmado por coordinador)",
    ]);
  });
});

describe("family merge candidates", () => {
  const fam = (id: string, pair: [string, string] | undefined, instanceCount: number) => ({ id, pair, instanceCount }) as unknown as TriageFamily;
  it("excludes the family itself and puts the same discipline pair first", () => {
    const f = fam("F-1", ["CLI", "EST"], 3);
    const out = mergeCandidates(f, [f, fam("F-2", ["SAN", "EST"], 9), fam("F-3", ["CLI", "EST"], 1), fam("F-4", ["CLI", "EST"], 5)]);
    expect(out.map((x) => x.id)).toEqual(["F-4", "F-3", "F-2"]);
  });
});

describe("i18n", () => {
  it("every parity key exists in es and en", () => {
    const keys = (o: unknown, p = ""): string[] => (typeof o === "string" ? [p] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k)));
    expect(keys((en as Record<string, unknown>).parity).sort()).toEqual(keys((es as Record<string, unknown>).parity).sort());
  });
});
