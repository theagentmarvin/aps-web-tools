/**
 * Rule-change suggestions of every kind (new · calibrate · edit · retire · restore) and the
 * read models of the Reglas page / the agent's discovery tool.
 *
 * One flow for agent and coordinator: build → preview (impact on a classified test, shadowing,
 * safety) → store as an ordinary `rule_change` proposal ("propuesta"). Approving and publishing
 * stay in server/rules-publish.ts (human, passkey, no-regression gate). Nothing here writes rules/.
 */
import { copyFile, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CompiledRuleSet } from "../core/rules/load";
import type { Coordinator } from "./coordinator";
import { CLOSABLE, loadRules, runEngine, type EngineOutput } from "./engine";
import { affectedCounts, describeRuleChange, ruleLabelEs } from "./rule-effect";
import {
  ACTIVE_FILE,
  ARCHIVE_FILE,
  CLOSING,
  FALLBACK_RULE,
  insertNewRuleInText,
  nextFreeId,
  normalizeText,
  parseArchive,
  replaceRuleInText,
  restoreRules,
  retireRules,
  RULE_ID_RE,
  ruleBlocks,
  ruleSides,
  sectionOf,
  serializeRule,
  setThreshold,
  thresholdsOf,
  touchesPolicyClass,
  unifiedDiff,
  type RawRule,
  type RuleFiles,
} from "./rule-authoring";
import { DEFAULT_RULES_DIR } from "./rules-loader";
import { mergeInto, MIN_ACCURACY_N, tallyTest, type AccuracyMap, type TallyFamilyDecision } from "./rule-accuracy";
import { checkAgentText } from "./sanitize";
import type { Actor, TestRecord } from "./store/types";
import type { RuleChangePreview, RuleInsights, RuleLibraryRow, RuleRow, RulesOverview, RuleShadow } from "./api/contract";
import { bareProjectId, CoordError, nowIso, round } from "./util";

/** Fields of the outcome a coordinator may calibrate. */
export interface OutcomeChange {
  validity?: string;
  responsibleDiscipline?: string;
  secondaryDiscipline?: string | null;
  severity?: string;
  suggestedAction?: string;
  humanReview?: boolean;
  confidence?: number;
}

export type RuleOp =
  | { kind: "new"; rule: RawRule | string }
  | { kind: "calibrate"; ruleId: string; then?: OutcomeChange; thresholds?: Array<{ path: string; value: number }>; nameEs?: string }
  | { kind: "edit"; ruleId: string; rule: RawRule | string }
  | { kind: "retire"; ruleIds: string[]; reason?: string }
  | { kind: "restore"; ruleIds: string[] };

export type ShadowInfo = RuleShadow;
export type RulePreview = RuleChangePreview;
export type RuleRowData = RuleRow;
export type ArchiveRow = RuleLibraryRow;
export type RulesOverviewData = RulesOverview;
export type { RuleInsights };


/** Section (id prefix) of a new rule from its outcome and sides: the server picks its precedence. */
export function sectionPrefixFor(r: Pick<RawRule, "when" | "then">): string {
  const v = String(r.then.validity);
  if (v === "false_positive") return r.then.nature === "duplicate" ? "DUP" : "FP";
  if (v === "tolerated") return "TOL";
  if (v === "needs_info") return "NI";
  const s = ruleSides(r);
  const has = (x: string) => s.includes(x);
  if (has("INC")) return "INC";
  if (has("ASC")) return "ELV";
  if (has("EST") && has("ARQ")) return "AE";
  if (has("EST")) return "EST";
  if (has("ARQ")) return "MA";
  return "MM";
}

/** Plain, fail-closed parse of one rule given as YAML (a map or a one-item list). */
export function parseRuleYaml(text: string): RawRule {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new CoordError("validation_error", `YAML inválido: ${(err as Error).message.slice(0, 300)}`);
  }
  if (doc && typeof doc === "object" && !Array.isArray(doc) && Array.isArray((doc as { rules?: unknown }).rules)) doc = (doc as { rules: unknown[] }).rules;
  if (Array.isArray(doc)) {
    if (doc.length !== 1) throw new CoordError("validation_error", "Indica exactamente una regla.");
    doc = doc[0];
  }
  if (!doc || typeof doc !== "object") throw new CoordError("validation_error", "La regla debe ser un mapa YAML (id, name, nameEs, when, then).");
  const r = doc as RawRule;
  if ((r.id !== undefined && typeof r.id !== "string") || !r.then || typeof r.then !== "object") throw new CoordError("validation_error", "La regla necesita when y then (id opcional en una regla nueva).");
  return { ...r, when: r.when ?? {} };
}

export class RuleAuthoring {
  private beforeCache = new Map<string, EngineOutput>();

  constructor(private readonly coord: Coordinator) {}

  get rulesDir(): string {
    return this.coord.rulePublisher.rulesDir;
  }

  rules(dir = this.rulesDir): CompiledRuleSet {
    return dir === DEFAULT_RULES_DIR ? loadRules() : loadRules(dir);
  }

  async files(): Promise<RuleFiles> {
    return {
      active: normalizeText(await readFile(join(this.rulesDir, ACTIVE_FILE), "utf8")),
      archive: normalizeText(await readFile(join(this.rulesDir, ARCHIVE_FILE), "utf8").catch(() => "")),
    };
  }

  private texts(fields: Record<string, string | undefined>): void {
    const problems: string[] = [];
    for (const [k, v] of Object.entries(fields)) if (v) problems.push(...checkAgentText(k, v, { urlAllowlist: [] }));
    if (problems.length) throw new CoordError("validation_error", `Texto no permitido: ${problems.join("; ")}`);
  }

  private checkRuleTexts(r: RawRule): void {
    if (!RULE_ID_RE.test(r.id)) throw new CoordError("validation_error", `Id de regla inválido: ${r.id} (formato ABC-123).`);
    if (!r.nameEs || !r.nameEs.trim()) throw new CoordError("validation_error", "El nombre en español (nameEs) es obligatorio.");
    if (r.nameEs.length > 120) throw new CoordError("validation_error", "El nombre en español supera 120 caracteres.");
    this.texts({ name: r.name, nameEs: r.nameEs, rationale: String(r.then?.rationale ?? "") });
  }

  /** Candidate files + unified diff of one operation (validates ids, texts and that the result loads). */
  async build(op: RuleOp): Promise<{ title: string; ruleIds: string[]; patch: string; after: RuleFiles; before: RuleFiles; focus?: RawRule; previous?: RawRule }> {
    const before = await this.files();
    const active = (parseYaml(before.active) as { rules: RawRule[] }).rules;
    const byId = new Map(active.map((r) => [r.id, r]));
    const archive = parseArchive(before.archive);
    const label = (r: RawRule) => r.nameEs ?? ruleLabelEs(r as never, this.rules());
    let after: RuleFiles;
    let title: string;
    let ruleIds: string[];
    let focus: RawRule | undefined;
    let previous: RawRule | undefined;
    try {
      switch (op.kind) {
        case "new": {
          const r = typeof op.rule === "string" ? parseRuleYaml(op.rule) : structuredClone(op.rule);
          if (!r.id) r.id = nextFreeId(sectionPrefixFor(r), [...byId.keys(), ...archive.map((e) => e.id)]);
          if (archive.some((e) => e.id === r.id)) throw new CoordError("validation_error", `${r.id} está en la Biblioteca: restáurala o usa otro id (siguiente libre: ${nextFreeId(sectionOf(r.id), [...byId.keys(), ...archive.map((e) => e.id)])}).`);
          this.checkRuleTexts(r);
          after = { active: insertNewRuleInText(before.active, r), archive: before.archive };
          title = `Nueva regla «${r.nameEs}»`;
          ruleIds = [r.id];
          focus = r;
          break;
        }
        case "calibrate": {
          const old = byId.get(op.ruleId);
          if (!old) throw new CoordError("not_found", `La regla ${op.ruleId} no está activa.`);
          if (op.ruleId === FALLBACK_RULE && op.then?.validity && op.then.validity !== "real") throw new CoordError("validation_error", "DEF-999 es la regla de respaldo: su resultado sigue siendo Conflicto con revisión humana.");
          let r: RawRule = structuredClone(old);
          for (const t of op.thresholds ?? []) r = setThreshold(r, t.path, t.value);
          const then = { ...r.then } as Record<string, unknown>;
          for (const [k, v] of Object.entries(op.then ?? {})) {
            if (v === undefined) continue;
            if (v === null) delete then[k];
            else then[k] = v;
          }
          if (then.humanReview === false) delete then.humanReview;
          r.then = then as RawRule["then"];
          if (op.nameEs !== undefined) r.nameEs = op.nameEs;
          if (!r.nameEs) r.nameEs = label(old);
          this.checkRuleTexts(r);
          after = { active: replaceRuleInText(before.active, r), archive: before.archive };
          title = `Calibrar «${r.nameEs}»`;
          ruleIds = [r.id];
          focus = r;
          previous = old;
          break;
        }
        case "edit": {
          const old = byId.get(op.ruleId);
          if (!old) throw new CoordError("not_found", `La regla ${op.ruleId} no está activa.`);
          const r = typeof op.rule === "string" ? parseRuleYaml(op.rule) : structuredClone(op.rule);
          if (r.id !== op.ruleId) throw new CoordError("validation_error", `El id no se cambia al editar (${op.ruleId}); para otra regla, el agente propone una nueva.`);
          if (op.ruleId === FALLBACK_RULE && (JSON.stringify(r.when) !== "{}" || r.then.validity !== "real")) throw new CoordError("validation_error", "DEF-999 debe seguir coincidiendo con todo y dar Conflicto (revisión humana).");
          this.checkRuleTexts(r);
          after = { active: replaceRuleInText(before.active, r), archive: before.archive };
          title = `Editar condiciones de «${r.nameEs}»`;
          ruleIds = [r.id];
          focus = r;
          previous = old;
          break;
        }
        case "retire": {
          if (op.reason) this.texts({ reason: op.reason });
          after = retireRules(before, op.ruleIds, { at: nowIso(this.coord.now()).slice(0, 10), ...(op.reason ? { reason: op.reason } : {}) });
          ruleIds = [...new Set(op.ruleIds)];
          title = ruleIds.length === 1 ? `Retirar «${label(byId.get(ruleIds[0]!)!)}»` : `Retirar ${ruleIds.length} reglas a la Biblioteca`;
          break;
        }
        case "restore": {
          after = restoreRules(before, op.ruleIds);
          ruleIds = [...new Set(op.ruleIds)];
          const e = archive.find((x) => x.id === ruleIds[0]);
          title = ruleIds.length === 1 ? `Restaurar «${e?.rule.nameEs ?? ruleIds[0]}»` : `Restaurar ${ruleIds.length} reglas de la Biblioteca`;
          if (ruleIds.length === 1 && e) focus = { ...e.rule, id: e.id } as RawRule;
          break;
        }
      }
    } catch (err) {
      if (err instanceof CoordError) throw err;
      throw new CoordError("validation_error", (err as Error).message);
    }
    const patch = unifiedDiff(ACTIVE_FILE, before.active, after.active) + unifiedDiff(ARCHIVE_FILE, before.archive, after.archive);
    if (!patch.trim()) throw new CoordError("validation_error", "La regla quedaría igual: no hay cambio que proponer.");
    return { title, ruleIds, patch, after, before, ...(focus ? { focus } : {}), ...(previous ? { previous } : {}) };
  }

  /** Default test: the active context's test when classified, else the most recent classified one. */
  async classifiedTests(): Promise<TestRecord[]> {
    const out: TestRecord[] = [];
    for (const t of await this.coord.store.listTests()) if (await this.coord.store.getClassification(t.testKey)) out.push(t);
    return out.sort((a, b) => (b.ingestedAt > a.ingestedAt ? 1 : b.ingestedAt < a.ingestedAt ? -1 : b.modelSetVersion - a.modelSetVersion));
  }

  async pickTest(testKey?: string): Promise<TestRecord | undefined> {
    const tests = await this.classifiedTests();
    if (testKey) return tests.find((t) => t.testKey === testKey);
    const ctx = await this.coord.store.getContext();
    return tests.find((t) => t.testKey === ctx?.testKey) ?? tests[0];
  }

  private async run(test: TestRecord, rs: CompiledRuleSet): Promise<EngineOutput> {
    const raw = await this.coord.loadRaw(test);
    return runEngine({ clashes: raw.clashes, elements: raw.elements, documents: raw.documents, config: this.coord.config, rules: rs, levelMap: this.coord.config.levelMap, projectDisciplines: await this.coord.disciplines.load(test.projectId) });
  }

  private async runBase(test: TestRecord, rs: CompiledRuleSet): Promise<EngineOutput> {
    const key = `${test.testKey}|${rs.hash}`;
    const hit = this.beforeCache.get(key);
    if (hit) return hit;
    const out = await this.run(test, rs);
    if (this.beforeCache.size > 4) this.beforeCache.clear();
    this.beforeCache.set(key, out);
    return out;
  }

  /** Temp rules dir = current rules/ with these active / archive texts (for analysis only). */
  private async dirWith(active: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "coord-rules-x-"));
    for (const f of await readdir(this.rulesDir)) if (/\.ya?ml$/.test(f)) await copyFile(join(this.rulesDir, f), join(dir, f));
    await writeFile(join(dir, ACTIVE_FILE), active);
    return dir;
  }

  /** Impact, shadowing and safety of one operation. Never writes rules/. */
  async preview(op: RuleOp, testKey?: string): Promise<RulePreview> {
    const b = await this.build(op);
    const errors: string[] = [];
    const warnings: string[] = [];
    // Same path the publisher uses: the patch must apply on the current files and load.
    const candDir = await this.coord.candidateRulesDir(Promise.resolve(b.patch), this.rulesDir);
    const base = this.rules();
    const cand = loadRules(candDir);
    const effect = describeRuleChange(base, cand);
    if (b.focus && b.focus.id !== FALLBACK_RULE && CLOSING.has(String(b.focus.then.validity)) && !b.focus.then.humanReview && touchesPolicyClass(b.focus)) {
      const was = b.previous;
      const tightening = was && CLOSING.has(String(was.then.validity)) && JSON.stringify(was.when) === JSON.stringify(b.focus.when);
      if (!tightening) errors.push("La regla cerraría interferencias de estructura o de seguridad de las personas sin revisión humana. Activa «Revisión humana» o deja la validez en Conflicto / Falta información (pasadas en estructura: solo el calculista).");
    }
    const out: RulePreview = { kind: op.kind, title: b.title, ruleIds: b.ruleIds, patch: b.patch, effect, errors, warnings };
    if (op.kind === "retire") {
      out.effect = [b.ruleIds.length === 1 ? "Se retira 1 regla a la Biblioteca (el motor deja de evaluarla; se puede restaurar)." : `Se retiran ${b.ruleIds.length} reglas a la Biblioteca (el motor deja de evaluarlas; se pueden restaurar).`, ...effect.filter((e) => !e.startsWith("Se elimina")).slice(0, 3)];
    }
    const test = await this.pickTest(testKey);
    if (!test) {
      warnings.push("No hay un test clasificado para medir el impacto.");
      return out;
    }
    let before: EngineOutput;
    let after: EngineOutput;
    try {
      before = await this.runBase(test, base);
      after = await this.run(test, cand);
    } catch {
      warnings.push(`No se pudo recalcular el test v${test.modelSetVersion} (sin datos en caché).`);
      return out;
    }
    const prev = new Map(before.clashes.map((c) => [c.id, c]));
    const groupOf = new Map(after.groups.map((g) => [g.id, g]));
    let ruleChanged = 0;
    let toFallback = 0;
    let newlyClosing = 0;
    let policyUnsafe = 0;
    for (const c of after.clashes) {
      const p = prev.get(c.id);
      if (!p) continue;
      if (p.ruleId !== c.ruleId) ruleChanged++;
      if (c.ruleId === FALLBACK_RULE && p.ruleId !== FALLBACK_RULE) toFallback++;
      if (!CLOSABLE.includes(p.validity) && CLOSABLE.includes(c.validity)) {
        newlyClosing++;
        const tags = c.tags ?? [];
        const policy = tags.includes("seguridad_personas") || tags.includes("requiere_calculista") || ["EST", "INC", "GAS", "ASC"].includes(c.a.discipline) || ["EST", "INC", "GAS", "ASC"].includes(c.b.discipline);
        if (policy && !groupOf.get(c.groupId)?.humanReview) policyUnsafe++;
      }
    }
    const n = affectedCounts(before, after);
    out.impact = { testKey: test.testKey, version: test.modelSetVersion, ...n, ruleChanged, toFallback, newlyClosing, policyUnsafe };
    if (policyUnsafe) errors.push(`${policyUnsafe} interferencias de estructura o seguridad de las personas pasarían a «No es problema / Dentro de tolerancia» sin revisión humana: no se propone.`);
    else if (newlyClosing) warnings.push(`${newlyClosing} interferencias pasarían de Conflicto / Falta información a cerrables. Revísalas antes de aprobar.`);
    if (op.kind === "retire" && toFallback) out.effect.push(`${toFallback} interferencias pasarían a la regla de respaldo (revisión humana).`);
    if (b.focus) {
      const fid = b.focus.id;
      const lines = normalizeText(b.after.active).split("\n");
      const blocks = ruleBlocks(lines);
      const own = blocks.find((x) => x.id === fid);
      const first = blocks[0];
      let matches = new Set<string>();
      if (own && first) {
        const moved = [...lines];
        moved.splice(own.start, own.end - own.start);
        moved.splice(first.start, 0, ...serializeRule(b.focus), "");
        try {
          const iso = await this.run(test, loadRules(await this.dirWith(moved.join("\n"))));
          matches = new Set(iso.clashes.filter((c) => c.ruleId === fid).map((c) => c.id));
        } catch {
          // shadow analysis is best effort
        }
      }
      const shadowedBy = new Map<string, number>();
      const shadows = new Map<string, number>();
      let wins = 0;
      for (const c of after.clashes) {
        if (c.ruleId === fid) {
          wins++;
          const p = prev.get(c.id);
          if (p?.ruleId && p.ruleId !== fid) shadows.set(p.ruleId, (shadows.get(p.ruleId) ?? 0) + 1);
        } else if (matches.has(c.id) && c.ruleId) shadowedBy.set(c.ruleId, (shadowedBy.get(c.ruleId) ?? 0) + 1);
      }
      const info = (m: Map<string, number>) =>
        [...m.entries()]
          .sort((x, y) => y[1] - x[1])
          .slice(0, 6)
          .map(([ruleId, clashes]) => {
            const r = cand.source.classification.rules.find((x) => x.id === ruleId) ?? base.source.classification.rules.find((x) => x.id === ruleId);
            return { ruleId, nameEs: r ? ruleLabelEs(r, cand) : ruleId, clashes };
          });
      out.focus = { ruleId: fid, matches: matches.size, wins, shadowedBy: info(shadowedBy), shadows: info(shadows) };
      if (matches.size > 0 && wins === 0) {
        const top = out.focus.shadowedBy[0];
        warnings.push(`Esta regla nunca se aplicaría en v${test.modelSetVersion}: ${top ? `«${top.nameEs}» (${top.ruleId}) la tapa` : "otra regla anterior la tapa"}.`);
      } else if (matches.size === 0) warnings.push(`La regla no coincide con ninguna interferencia de v${test.modelSetVersion}.`);
    }
    return out;
  }

  /**
   * Store the operation as an ordinary rule_change proposal (same shape for agent and coordinator).
   * Refuses when the preview has errors (safety, validation).
   */
  async suggest(op: RuleOp, input: { rationale: string; title?: string; feedbackIds?: string[]; testKey?: string }, actor: Actor): Promise<{ proposalId: string; preview: RulePreview }> {
    this.texts({ rationale: input.rationale, title: input.title });
    if (!input.rationale.trim()) throw new CoordError("validation_error", "Indica el motivo del cambio.");
    const preview = await this.preview(op, input.testKey);
    if (preview.errors.length) throw new CoordError("validation_error", preview.errors.join(" "));
    const ev = await this.coord.evaluateRuleset({ candidatePatch: preview.patch, suites: ["eval_scenarios"] }, { rulesDir: this.rulesDir }).catch(() => undefined);
    const test = preview.impact ? await this.pickTest(preview.impact.testKey) : undefined;
    let evidence: import("./store/types").RuleChangeEvidence | undefined;
    if (test && preview.impact) {
      const base = await this.runBase(test, this.rules());
      const cand = await this.run(test, loadRules(await this.coord.candidateRulesDir(Promise.resolve(preview.patch), this.rulesDir)));
      const count = (o: EngineOutput) => {
        const m: Record<string, number> = {};
        for (const c of o.clashes) m[c.validity] = (m[c.validity] ?? 0) + 1;
        return m;
      };
      const next = new Map(cand.clashes.map((c) => [c.id, c]));
      const changed = base.clashes.filter((c) => next.get(c.id) && next.get(c.id)!.validity !== c.validity);
      evidence = {
        kind: "real_data_evaluation",
        testKey: test.testKey,
        summary: `${preview.title}. ${preview.effect.slice(0, 3).join(" ")}`.slice(0, 1500),
        metrics: {
          changedUnique: new Set(changed.map((c) => c.uniqueKey ?? c.id)).size,
          changedMc: changed.length,
          validityBefore: count(base),
          validityAfter: count(cand),
          groupsBefore: base.groups.length,
          groupsAfter: cand.groups.length,
          needsReviewBefore: base.groups.filter((g) => g.humanReview).length,
          needsReviewAfter: cand.groups.filter((g) => g.humanReview).length,
          unsafeClosures: preview.impact.policyUnsafe,
          scenariosPassed: Number(ev?.candidate?.scenariosExactMatch ?? 0),
          scenariosTotal: Math.max(Number(ev?.candidate?.scenariosExactMatch ?? 0), Number(ev?.cases ?? 0)),
        },
      };
    }
    const b = ev?.baseline as Record<string, number> | undefined;
    const c = ev?.candidate as Record<string, number> | undefined;
    const evaluation: Record<string, number> = {
      ...(b ? { baselineMacroF1: b.macroF1 ?? 0, baselineRubricScore: b.rubricScore ?? 0 } : {}),
      ...(c ? { candidateMacroF1: c.macroF1 ?? 0, candidateRubricScore: c.rubricScore ?? 0, unsafeClosureRate: c.unsafeClosureRate ?? 0, criticalFalseNegatives: c.criticalFalseNegatives ?? 0 } : {}),
    };
    const p = await this.coord.storeRuleSuggestion({
      title: (input.title?.trim() || preview.title).slice(0, 120),
      patch: preview.patch,
      rationale: input.rationale,
      feedbackIds: input.feedbackIds ?? [],
      evaluation,
      scope: "company",
      changeKind: op.kind,
      ruleIds: preview.ruleIds,
      affected: preview.impact?.clashes ?? 0,
      ...(evidence ? { evidence } : {}),
      actor,
    });
    return { proposalId: p.proposalId, preview };
  }

  // ── Read models ────────────────────────────────────────────────────────────

  /** Agreement of human decisions with each rule's outcome (shared tally: server/rule-accuracy.ts). */
  async accuracy(): Promise<AccuracyMap> {
    const out: AccuracyMap = new Map();
    for (const t of await this.classifiedTests()) mergeInto(out, await this.accuracyForTest(t.testKey));
    return out;
  }

  /**
   * Tally of one classified test. `family` replaces the current decision of one family (preview of a
   * decision not taken yet: same function, so receipt numbers equal the Reglas page deltas).
   */
  async accuracyForTest(testKey: string, family?: { familyId: string; decision: TallyFamilyDecision | null }): Promise<AccuracyMap> {
    const cls = await this.coord.store.getClassification(testKey);
    if (!cls) return new Map();
    const decided = await this.coord.effectiveDecisions(testKey);
    // Group ("familia") decisions — the coordinator's usual way to decide — count too (see rule-accuracy.ts).
    const views = await this.coord.familyViewsFor(testKey).then((x) => x.views).catch(() => []);
    const familyDecisions: Array<TallyFamilyDecision | undefined> = views.map((v) => (family && v.id === family.familyId ? (family.decision ?? undefined) : v.decision));
    return tallyTest({ testKey, groups: cls.groups, decided, familyDecisions });
  }

  /** Winning-rule counts: per test (clashes + ubicaciones) and over all classified tests. */
  async usage(): Promise<{ perTest: Map<string, Map<string, { clashes: number; groups: Set<string> }>>; total: Map<string, number>; tests: TestRecord[] }> {
    const perTest = new Map<string, Map<string, { clashes: number; groups: Set<string> }>>();
    const total = new Map<string, number>();
    const tests = await this.classifiedTests();
    for (const t of tests) {
      const cls = (await this.coord.store.getClassification(t.testKey))!;
      const m = new Map<string, { clashes: number; groups: Set<string> }>();
      for (const c of cls.clashes) {
        if (!c.ruleId) continue;
        const e = m.get(c.ruleId) ?? { clashes: 0, groups: new Set<string>() };
        e.clashes++;
        e.groups.add(c.groupId);
        m.set(c.ruleId, e);
        total.set(c.ruleId, (total.get(c.ruleId) ?? 0) + 1);
      }
      perTest.set(t.testKey, m);
    }
    return { perTest, total, tests };
  }

  async overview(testKey?: string): Promise<RulesOverviewData> {
    const rs = this.rules();
    const { perTest, total, tests } = await this.usage();
    const selected = await this.pickTest(testKey);
    const acc = await this.accuracy();
    const files = await this.files();
    let library: ArchiveRow[] = [];
    let archiveError: string | undefined;
    try {
      library = parseArchive(files.archive).map((e) => ({
        id: e.id,
        nameEs: e.rule.nameEs ?? ruleLabelEs(e.rule as never, rs),
        section: e.section,
        sides: ruleSides(e.rule),
        validity: String(e.rule.then.validity),
        retiredAt: e.retiredAt,
        ...(e.reason ? { reason: e.reason } : {}),
      }));
    } catch (err) {
      archiveError = (err as Error).message.slice(0, 300);
    }
    const use = selected ? perTest.get(selected.testKey) : undefined;
    const rows: RuleRowData[] = rs.source.classification.rules.map((r) => {
      const raw = r as unknown as RawRule;
      const a = acc.get(r.id);
      const top = a ? [...a.corrections.entries()].sort((x, y) => y[1] - x[1])[0] : undefined;
      const u = use?.get(r.id);
      return {
        id: r.id,
        name: r.name,
        nameEs: ruleLabelEs(r, rs),
        section: sectionOf(r.id),
        sides: ruleSides(raw),
        validity: r.then.validity,
        responsible: r.then.responsibleDiscipline,
        severity: r.then.severity,
        action: r.then.suggestedAction,
        confidence: r.then.confidence,
        humanReview: !!r.then.humanReview,
        usage: selected ? { clashes: u?.clashes ?? 0, groups: u?.groups.size ?? 0 } : null,
        totalUse: total.get(r.id) ?? 0,
        accuracy: a ? { agree: a.agree, n: a.n, rate: a.n >= MIN_ACCURACY_N ? round(a.agree / a.n, 3) : null, ...(top ? { topCorrection: top[0] } : {}) } : { agree: 0, n: 0, rate: null },
        thresholds: thresholdsOf(raw),
        raw,
        fallback: r.id === FALLBACK_RULE,
      };
    });
    return {
      tests: tests.map((t) => ({ testKey: t.testKey, projectId: bareProjectId(t.projectId), modelSetId: t.modelSetId, version: t.modelSetVersion, label: `${t.projectName} · ${t.modelSetName} v${t.modelSetVersion}`, classifiedTests: tests.length })),
      ...(selected ? { selectedTestKey: selected.testKey } : {}),
      rules: rows,
      library,
      ...(archiveError ? { archiveError } : {}),
      annotations: rs.source.classification.annotations.map((x) => ({ id: x.id, tags: x.then.tags, ...(x.then.note ? { note: x.then.note } : {}) })),
      minAccuracyN: MIN_ACCURACY_N,
    };
  }

  /**
   * Deterministic discovery input for the agent (get_rule_insights): what the rules do not cover,
   * what humans keep correcting, what never fires, and which retired rules would cover the gaps.
   */
  async insights(q: { testKey?: string; projectId?: string } = {}): Promise<RuleInsights> {
    const all = await this.classifiedTests();
    const tests = q.testKey ? all.filter((t) => t.testKey === q.testKey) : q.projectId ? all.filter((t) => bareProjectId(t.projectId) === bareProjectId(q.projectId!)) : all;
    if (q.testKey && !tests.length) throw new CoordError("not_found", `Test ${q.testKey} no está clasificado.`);
    const rs = this.rules();
    // a) uncovered clusters (DEF-999 or needs_info) by pair / categories, with systems and levels.
    const clusters = new Map<string, { disciplinePair: string; categoryPair: string; ruleIds: Set<string>; clashes: number; groups: Set<string>; systems: Map<string, number>; levels: Map<string, number>; examples: string[]; testKeys: Set<string> }>();
    for (const t of tests) {
      const cls = (await this.coord.store.getClassification(t.testKey))!;
      for (const c of cls.clashes) {
        if (c.ruleId !== FALLBACK_RULE && c.validity !== "needs_info") continue;
        const key = `${c.disciplinePair}|${c.categoryPair}`;
        const e = clusters.get(key) ?? { disciplinePair: c.disciplinePair, categoryPair: c.categoryPair, ruleIds: new Set<string>(), clashes: 0, groups: new Set<string>(), systems: new Map<string, number>(), levels: new Map<string, number>(), examples: [] as string[], testKeys: new Set<string>() };
        e.clashes++;
        e.groups.add(c.groupId);
        if (c.ruleId) e.ruleIds.add(c.ruleId);
        e.testKeys.add(t.testKey);
        for (const s of [c.a.system, c.b.system]) if (s) e.systems.set(s, (e.systems.get(s) ?? 0) + 1);
        if (c.level) e.levels.set(c.level, (e.levels.get(c.level) ?? 0) + 1);
        if (e.examples.length < 5) e.examples.push(c.id);
        clusters.set(key, e);
      }
    }
    const top = (m: Map<string, number>, n = 3) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
    const uncovered = [...clusters.values()]
      .sort((a, b) => b.clashes - a.clashes)
      .slice(0, 15)
      .map((e) => ({ disciplinePair: e.disciplinePair, categoryPair: e.categoryPair, ruleIds: [...e.ruleIds], clashes: e.clashes, groups: e.groups.size, topSystems: top(e.systems), topLevels: top(e.levels), exampleClashIds: e.examples, exampleGroupIds: [...e.groups].slice(0, 3), testKeys: [...e.testKeys] }));
    // b) rules humans keep correcting.
    const acc = await this.accuracy();
    const corrected = [...acc.entries()]
      .filter(([, a]) => a.n > a.agree)
      .map(([ruleId, a]) => ({ ruleId, nameEs: this.nameOf(rs, ruleId), n: a.n, agree: a.agree, rate: round(a.agree / a.n, 3), reliable: a.n >= MIN_ACCURACY_N, topCorrection: [...a.corrections.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "" }))
      .sort((x, y) => x.rate - y.rate || y.n - x.n)
      .slice(0, 15);
    // c) active rules with 0 use over every classified test.
    const { total } = await this.usage();
    const zeroUse = rs.source.classification.rules.filter((r) => r.id !== FALLBACK_RULE && !total.get(r.id)).map((r) => ({ ruleId: r.id, nameEs: ruleLabelEs(r, rs) }));
    // d) library rules that would take current DEF-999 clashes (all restored after the active ones).
    const reactivation: RuleInsights["reactivation"] = [];
    const files = await this.files();
    const lib = (() => {
      try {
        return parseArchive(files.archive);
      } catch {
        return [];
      }
    })();
    const picked = await this.pickTest();
    const latest = q.testKey ? tests[0] : (tests.find((t) => t.testKey === picked?.testKey) ?? tests[0]);
    if (lib.length && latest) {
      try {
        const base = await this.runBase(latest, rs);
        const restored = restoreRules(files, lib.map((e) => e.id));
        const out = await this.run(latest, loadRules(await this.dirWith(restored.active)));
        const fallback = new Set(base.clashes.filter((c) => c.ruleId === FALLBACK_RULE).map((c) => c.id));
        const libIds = new Set(lib.map((e) => e.id));
        const hits = new Map<string, number>();
        for (const c of out.clashes) if (fallback.has(c.id) && c.ruleId && libIds.has(c.ruleId)) hits.set(c.ruleId, (hits.get(c.ruleId) ?? 0) + 1);
        for (const [ruleId, clashes] of [...hits.entries()].sort((a, b) => b[1] - a[1])) {
          const e = lib.find((x) => x.id === ruleId)!;
          reactivation.push({ ruleId, nameEs: e.rule.nameEs ?? ruleId, clashes, testKey: latest.testKey });
        }
      } catch {
        // best effort
      }
    }
    return {
      testKeys: tests.map((t) => t.testKey),
      uncovered,
      corrected,
      zeroUse,
      reactivation,
      library: lib.map((e) => ({ ruleId: e.id, nameEs: e.rule.nameEs ?? e.id, retiredAt: e.retiredAt })),
      note: "Datos determinísticos. Proponer con propose_rule_change (changeKind new | calibrate | edit | retire | restore) y evidencia; nunca publicar.",
    };
  }

  private nameOf(rs: CompiledRuleSet, id: string): string {
    const r = rs.source.classification.rules.find((x) => x.id === id);
    return r ? ruleLabelEs(r, rs) : id;
  }
}
