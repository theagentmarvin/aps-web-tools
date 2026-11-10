/**
 * Rule changes as suggestions (server/rule-suggest.ts): coordinator calibrate / edit / retire /
 * restore and the agent's structured propose_rule_change share one flow (propuesta → aprobada →
 * publicada with the no-regression gate). Every write goes to a TEMP copy of rules/.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { CHAT_READ_TOOLS } from "../../server/chat/bridge";
import { TOOLS } from "../../server/mcp/contracts";
import { ACTIVE_FILE, ARCHIVE_FILE, parseArchive, type RawRule } from "../../server/rule-authoring";
import { RulePublisher } from "../../server/rules-publish";
import { HUMAN, ingest, makeCoord, ROOT, tempHome } from "./helpers";

const SRC = join(ROOT, "rules");
const original = readFileSync(join(SRC, ACTIVE_FILE), "utf8").replace(/\r\n/g, "\n");
const ids = (t: string) => (parse(t) as { rules: RawRule[] }).rules.map((r) => r.id);
const rawOf = (id: string) => structuredClone((parse(original) as { rules: RawRule[] }).rules.find((r) => r.id === id)!);
/** Rules with matches on the real project (the other 71 are the bulk-retire candidates). */
const USED = ["HYG-002", "HYG-004", "DUP-001", "FP-009", "TOL-003", "EST-001", "EST-002", "EST-005", "EST-006", "EST-007", "EST-008", "EST-009", "EST-011", "MM-001", "MM-002", "MM-005", "DEF-999"];

let home: string;
let cleanup: () => void;
let coord: Coordinator;
let ui: CoordinatorUi;
let testKey: string;
let dir: string;

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  cleanup = t.cleanup;
  coord = makeCoord(home);
  ui = new CoordinatorUi(coord);
  await ingest(coord, 41);
  testKey = await ingest(coord, 42);
  dir = mkdtempSync(join(tmpdir(), "coord-rules-sug-"));
  cpSync(SRC, dir, { recursive: true });
  coord.rulePublisher = new RulePublisher(coord, { rulesDir: dir });
}, 180_000);
afterAll(() => {
  cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const current = () => readFileSync(join(dir, ACTIVE_FILE), "utf8");

describe("coordinator rule changes → suggestions", () => {
  it("overview: rules with sides, use in the selected test, Biblioteca and alerts", async () => {
    const o = await ui.rulesOverview();
    expect(o.selectedTestKey).toBe(testKey);
    expect(o.rules.length).toBe(ids(original).length);
    const def = o.rules.find((r) => r.id === "DEF-999")!;
    expect(def.fallback).toBe(true);
    const cls = (await coord.store.getClassification(testKey))!;
    const top = cls.stats.topRules[0]!;
    expect(o.rules.find((r) => r.id === top.ruleId)!.usage!.clashes).toBe(cls.clashes.filter((c) => c.ruleId === top.ruleId).length);
    expect(o.rules.find((r) => r.id === "EST-005")!.sides).toEqual(["MEP", "EST"]);
    expect(o.rules.find((r) => r.id === "EST-005")!.thresholds[0]!.path).toBe("a.sizeMm.gte");
    expect(o.annotations.map((a) => a.id)).toContain("ANN-006");
    expect(o.library).toEqual([]);
  }, 120_000);

  it("calibrate keeps the position and becomes a 'coordinador' suggestion at stage propuesta", async () => {
    const before = ids(current());
    const pv = await ui.previewRuleChange({ kind: "calibrate", ruleId: "EST-005", then: { severity: "critical" }, thresholds: [{ path: "a.sizeMm.gte", value: 150 }] });
    expect(pv.errors).toEqual([]);
    expect(pv.patch).toContain("+      a: { elementClass: { inSet: MEP_DIST }, sizeMm: { gte: 150 } }");
    const s = await ui.createRuleSuggestion({ change: { kind: "calibrate", ruleId: "EST-005", then: { severity: "critical" }, thresholds: [{ path: "a.sizeMm.gte", value: 150 }] }, rationale: "En este proyecto las pasadas ≥ 150 mm en vigas son críticas." }, HUMAN);
    expect(s).toMatchObject({ origin: "coordinador", changeKind: "calibrate", ruleIds: ["EST-005"], state: "pending" });
    expect(s.title).toContain("Calibrar");
    // Nothing was written: suggestions never touch rules/.
    expect(ids(current())).toEqual(before);
    expect(current()).toBe(readFileSync(join(SRC, ACTIVE_FILE), "utf8"));
    const p = (await coord.store.getProposal(s.id))!;
    expect(p.createdBy.type).toBe("user");
    const patched = await coord.candidateRulesDir(Promise.resolve(s.patch), dir);
    expect(ids(readFileSync(join(patched, ACTIVE_FILE), "utf8"))).toEqual(before);
    expect((await coord.store.listAudit()).some((e) => e.action === "rule.suggested" && e.details?.origin === "coordinador")).toBe(true);
  }, 120_000);

  it("edit keeps the position; id, nameEs and free-text rules are enforced", async () => {
    const r = rawOf("MA-007");
    r.nameEs = "Instalación grande atraviesa tabique";
    r.when = { a: { elementClass: { inSet: "MEP_DIST" }, sizeMm: { gt: 200 } }, b: { elementClass: "arch_wall" } };
    const pv = await ui.previewRuleChange({ kind: "edit", ruleId: "MA-007", rule: r as never });
    expect(pv.errors).toEqual([]);
    const cand = await coord.candidateRulesDir(Promise.resolve(pv.patch), dir);
    expect(ids(readFileSync(join(cand, ACTIVE_FILE), "utf8"))).toEqual(ids(current()));
    await expect(ui.previewRuleChange({ kind: "edit", ruleId: "MA-007", rule: { ...r, id: "MA-099" } as never })).rejects.toThrow(/id no se cambia/);
    await expect(ui.previewRuleChange({ kind: "edit", ruleId: "MA-007", rule: { ...r, nameEs: "" } as never })).rejects.toThrow(/nameEs/);
    await expect(ui.previewRuleChange({ kind: "edit", ruleId: "MA-007", rule: { ...r, nameEs: "Ver https://evil.example.com" } as never })).rejects.toThrow(/URL no permitida/);
    await expect(ui.createRuleSuggestion({ change: { kind: "edit", ruleId: "MA-007", rule: r as never }, rationale: "escribir a jefe@empresa.cl" }, HUMAN)).rejects.toThrow(/correos/);
    await expect(ui.previewRuleChange({ kind: "edit", ruleId: "MA-007", rule: "id: MA-007\nname: x\nnameEs: y\nwhen: { a: { noSuchField: 1 } }\nthen: { validity: real, nature: hard, rootCause: design_coordination, responsibleDiscipline: COORD, severity: low, confidence: 0.5, suggestedAction: create_issue, rationale: x }" })).rejects.toThrow(/no cargan|noSuchField/i);
    // YAML (advanced editor) is accepted for the same rule.
    const yaml = ["id: MA-007", "name: large MEP through partition", "nameEs: Instalación grande atraviesa tabique", "when:", "  a: { elementClass: { inSet: MEP_DIST }, sizeMm: { gt: 180 } }", "  b: { elementClass: arch_wall }", "then: { validity: real, nature: hard, rootCause: missing_opening, responsibleDiscipline: \"$a\", secondaryDiscipline: ARQ, severity: low, confidence: 0.7, suggestedAction: create_issue, rationale: \"Pasada en tabique.\" }"].join("\n");
    expect((await ui.previewRuleChange({ kind: "edit", ruleId: "MA-007", rule: yaml })).errors).toEqual([]);
  }, 120_000);

  it("refuses to close structure / life-safety classes without human review", async () => {
    const r = rawOf("EST-001");
    r.nameEs = "Pasada en pilar";
    r.then = { ...r.then, validity: "false_positive", severity: "none", suggestedAction: "close_not_issue" };
    const pv = await ui.previewRuleChange({ kind: "edit", ruleId: "EST-001", rule: r as never });
    expect(pv.errors.join(" ")).toMatch(/estructura o de seguridad/);
    await expect(ui.createRuleSuggestion({ change: { kind: "edit", ruleId: "EST-001", rule: r as never }, rationale: "cerrar" }, HUMAN)).rejects.toThrow(/estructura/);
    await expect(ui.createRuleSuggestion({ change: { kind: "calibrate", ruleId: "INC-001", then: { validity: "tolerated", suggestedAction: "mark_reviewed" } }, rationale: "tolerar" }, HUMAN)).rejects.toThrow(/estructura o de seguridad/);
    // With human review it is a proposal like any other (the human still decides each group).
    const ok = await ui.previewRuleChange({ kind: "calibrate", ruleId: "INC-001", then: { validity: "needs_info", suggestedAction: "request_info", severity: "low" } });
    expect(ok.errors).toEqual([]);
    await expect(ui.previewRuleChange({ kind: "calibrate", ruleId: "DEF-999", then: { validity: "false_positive" } })).rejects.toThrow(/respaldo/);
  }, 120_000);

  it("shadow detection: a rule hidden by an earlier one, and a new rule that takes clashes", async () => {
    const cls = (await coord.store.getClassification(testKey))!;
    const order = ids(current());
    const top = cls.stats.topRules.map((x) => x.ruleId).find((x) => x !== "DEF-999" && order.indexOf(x) < order.indexOf("MM-010"))!;
    const late = rawOf("MM-010");
    late.nameEs = "Copia tardía";
    late.when = rawOf(top).when;
    const pv = await ui.previewRuleChange({ kind: "edit", ruleId: "MM-010", rule: late as never });
    expect(pv.focus!.matches).toBeGreaterThan(0);
    expect(pv.focus!.wins).toBe(0);
    expect(pv.focus!.shadowedBy[0]!.ruleId).toBe(top);
    expect(pv.warnings.join(" ")).toMatch(new RegExp(`nunca se aplicaría.*${top}.*la tapa`));
    // A structured NEW rule (agent path) lands at the end of its section and takes the clashes of `top`.
    const fresh = { ...rawOf(top), id: undefined as unknown as string, nameEs: "Necesita información (prueba)" };
    fresh.then = { ...fresh.then, validity: "needs_info", severity: "low", suggestedAction: "request_info", humanReview: true };
    const res = await coord.proposeRuleChange({ changeKind: "new", rule: JSON.stringify(fresh), rationale: "Prueba de regla nueva desde el agente.", scope: "company" });
    const p = (await coord.store.getProposal(res.proposalId))!;
    expect(p.createdBy.type).toBe("agent");
    if (p.payload.kind !== "rule_change") throw new Error("kind");
    const newId = p.payload.ruleIds![0]!;
    expect(newId).toMatch(/^NI-\d{3}$/);
    const cand = ids(readFileSync(join(await coord.candidateRulesDir(Promise.resolve(readFileSync(p.payload.patchFile, "utf8")), dir), ACTIVE_FILE), "utf8"));
    expect(cand[cand.indexOf(newId) - 1]).toBe("NI-002");
    expect(cand.indexOf(newId)).toBeLessThan(cand.indexOf("DEF-999"));
    expect((res as { impact?: { ruleChanged: number } }).impact?.ruleChanged).toBeGreaterThan(0);
    expect(p.payload.evidence?.metrics.unsafeClosures).toBe(0);
    const sug = (await ui.ruleSuggestions()).find((s) => s.id === res.proposalId)!;
    expect(sug).toMatchObject({ origin: "agente", changeKind: "new" });
  }, 180_000);

  it("bulk retire (agent path) → approve → publish (demo) → Biblioteca; restore puts the rules back", async () => {
    const retire = ids(current()).filter((x) => !USED.includes(x));
    // 88 ids in the file = 82 rules + 6 annotations (ANN-001..006, never retired): 82 - 17 used = 65.
    expect(retire.length).toBe(65);
    const pv = await ui.previewRuleChange({ kind: "retire", ruleIds: retire });
    expect(pv.errors).toEqual([]);
    expect(pv.effect[0]).toMatch(/Se retiran 65 reglas a la Biblioteca/);
    // eslint-disable-next-line no-console
    console.log("[bulk-retire-65 preview]", JSON.stringify({ impact: pv.impact, effect: pv.effect, warnings: pv.warnings }));
    const ev = await coord.evaluateRuleset({ candidatePatch: pv.patch, suites: ["eval_scenarios", "feedback_replay"] }, { rulesDir: dir });
    // eslint-disable-next-line no-console
    console.log("[bulk-retire-65 gate]", JSON.stringify({ regressionCount: ev.regressionCount, fallbackScenarios: ev.fallbackScenarios?.length, nonFallbackScenarios: ev.nonFallbackScenarios, criticalFnAllFallback: ev.criticalFnAllFallback, baseline: ev.baseline, candidate: ev.candidate }));

    // The gate refuses this bulk set on the fixtures: some scenarios land on another rule, not on DEF-999.
    expect(ev.nonFallbackScenarios?.length).toBeGreaterThan(0);
    // Without the rules those scenarios assert (EST-003, EST-004, TOL-005, TOL-006) every regression lands on DEF-999.
    const keep = new Set(["EST-003", "EST-004", "TOL-005", "TOL-006"]);
    const pv2 = await ui.previewRuleChange({ kind: "retire", ruleIds: retire.filter((x) => !keep.has(x)) });
    const ev2 = await coord.evaluateRuleset({ candidatePatch: pv2.patch, suites: ["eval_scenarios", "feedback_replay"] }, { rulesDir: dir });
    // eslint-disable-next-line no-console
    console.log("[bulk-retire-61]", JSON.stringify({ impact: pv2.impact, nonFallback: ev2.nonFallbackScenarios, fallback: ev2.fallbackScenarios?.length, criticalFnAllFallback: ev2.criticalFnAllFallback, candidate: ev2.candidate }));
    // A single retirement end to end (HYG-003 has no use in the fixtures).
    const res = await coord.proposeRuleChange({ changeKind: "retire", ruleIds: ["HYG-003"], rationale: "Sin uso en los tests clasificados.", scope: "company" });
    const id = res.proposalId;
    await ui.decideRuleSuggestion(id, "approve", HUMAN);
    const pub = await ui.publishRuleSuggestion(id, { demo: true }, HUMAN);
    expect(pub.state).toBe("published");
    expect(pub.publication!.files.sort()).toEqual([`rules/${ACTIVE_FILE}`, `rules/${ARCHIVE_FILE}`].sort());
    expect(ids(current())).not.toContain("HYG-003");
    const lib = parseArchive(readFileSync(join(dir, ARCHIVE_FILE), "utf8"));
    expect(lib.map((e) => e.id)).toEqual(["HYG-003"]);
    expect((await ui.rulesOverview()).library.map((x) => x.id)).toEqual(["HYG-003"]);
    // The repository rules are untouched.
    expect(existsSync(join(SRC, ARCHIVE_FILE))).toBe(false);
    expect(readFileSync(join(SRC, ACTIVE_FILE), "utf8").replace(/\r\n/g, "\n")).toBe(original);

    const back = await ui.createRuleSuggestion({ change: { kind: "restore", ruleIds: ["HYG-003"] }, rationale: "Volver a usarla." }, HUMAN);
    expect(back).toMatchObject({ origin: "coordinador", changeKind: "restore" });
    await ui.decideRuleSuggestion(back.id, "approve", HUMAN);
    await ui.publishRuleSuggestion(back.id, { demo: true }, HUMAN);
    expect(ids(current())).toEqual(ids(original));
    expect(parseArchive(readFileSync(join(dir, ARCHIVE_FILE), "utf8"))).toEqual([]);
    await expect(ui.previewRuleChange({ kind: "retire", ruleIds: ["DEF-999"] })).rejects.toThrow(/respaldo/);
  }, 300_000);

  it("the relaxed retire gate needs a patch that only removes rules (a mislabelled edit gets the strict gate)", async () => {
    const r = rawOf("TOL-005");
    r.nameEs = "Conduit pequeño en losa";
    r.then = { ...r.then, validity: "real", severity: "low", suggestedAction: "create_issue" };
    const pv = await ui.previewRuleChange({ kind: "edit", ruleId: "TOL-005", rule: r as never });
    const res = await coord.storeRuleSuggestion({ title: "Retiro (etiqueta falsa)", patch: pv.patch, rationale: "prueba", feedbackIds: [], evaluation: {}, scope: "company", changeKind: "retire", ruleIds: ["TOL-005"], affected: 0, actor: { type: "agent", id: "agent", name: "agente" } });
    await ui.decideRuleSuggestion(res.proposalId, "approve", HUMAN);
    const before = current();
    await expect(ui.publishRuleSuggestion(res.proposalId, { demo: true }, HUMAN)).rejects.toThrow(/regresión/);
    expect(current()).toBe(before);
  }, 180_000);

  it("get_rule_insights: uncovered clusters, zero-use rules, read-only tool for the chat; no publish tool", async () => {
    const ins = await coord.ruleInsights({});
    expect(ins.testKeys.length).toBeGreaterThan(0);
    expect(ins.zeroUse.length).toBeGreaterThan(0);
    expect(ins.zeroUse.some((z) => z.ruleId === "DEF-999")).toBe(false);
    const cls = (await coord.store.getClassification(testKey))!;
    if (cls.clashes.some((c) => c.ruleId === "DEF-999")) expect(ins.uncovered.length).toBeGreaterThan(0);
    expect(TOOLS.find((t) => t.name === "get_rule_insights")!.annotations.readOnlyHint).toBe(true);
    expect(CHAT_READ_TOOLS).toContain("mcp__coord__get_rule_insights");
    expect(TOOLS.map((t) => t.name).filter((n) => /publish|approve_rule|decide_rule|revert/.test(n))).toEqual([]);
  }, 120_000);
});
