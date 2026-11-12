/**
 * G15 rule publication: propuesta → aprobada (pendiente de publicar) → publicada → revertida.
 * Every write goes to a TEMP copy of the repository rules directory (never the real one).
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { describeRuleChange } from "../../server/rule-effect";
import { RulePublisher } from "../../server/rules-publish";
import { loadRules } from "../../server/engine";
import { TOOLS } from "../../server/mcp/contracts";
import { SoftAuthenticator } from "./authenticator";
import { enrollPasskey, HUMAN, ingest, makeCoord, makeLiveLike, ROOT, tempHome } from "./helpers";

const RULES_FILE = "classification-rules.yaml";
const SRC = join(ROOT, "rules");

function tempRules(): string {
  const dir = mkdtempSync(join(tmpdir(), "coord-rules-pub-"));
  cpSync(SRC, dir, { recursive: true });
  return dir;
}

/** One-line unified diff on the rules file: `edit` maps the line that `find` matches (after `after`). */
function patchFor(text: string, after: RegExp, find: RegExp, edit: (line: string) => string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => after.test(l));
  const i = lines.findIndex((l, k) => k > start && find.test(l));
  if (start < 0 || i < 0) throw new Error("line not found");
  return [`--- a/rules/${RULES_FILE}`, `+++ b/rules/${RULES_FILE}`, `@@ -${i + 1},1 +${i + 1},1 @@`, `-${lines[i]}`, `+${edit(lines[i]!)}`, ""].join("\n");
}

const original = readFileSync(join(SRC, RULES_FILE), "utf8");
/** Harmless: renames HYG-001's English log name (no metric can change). */
const renamePatch = () => patchFor(original, /- id: HYG-001/, /^\s+name: /, (l) => `${l} (v2)`);

async function propose(coord: Coordinator, testKey: string, patch: string, title = "Renombrar HYG-001") {
  const r = await coord.proposeRuleChange({
    title,
    patch,
    rationale: "Prueba de publicación de reglas.",
    evidence: { kind: "real_data_evaluation", testKey, summary: "sin cambios", metrics: { changedUnique: 0, changedMc: 0, validityBefore: {}, validityAfter: {}, groupsBefore: 0, groupsAfter: 0, needsReviewBefore: 0, needsReviewAfter: 0, unsafeClosures: 0, scenariosPassed: 1, scenariosTotal: 1 } },
    evaluation: {},
    scope: "project",
  });
  return r.proposalId;
}

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
  testKey = await ingest(coord, 42);
  dir = tempRules();
  coord.rulePublisher = new RulePublisher(coord, { rulesDir: dir });
}, 120_000);
afterAll(() => {
  cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("G15 publish chain (fixtures: labelled demo proof)", () => {
  it("propuesta → aprobada (pendiente de publicar) → publicada → revertida, with backup and audit", async () => {
    const id = await propose(coord, testKey, renamePatch());
    const sug = async () => (await ui.ruleSuggestions()).find((s) => s.id === id)!;
    expect((await sug()).state).toBe("pending");
    await expect(ui.publishRuleSuggestion(id, { demo: true }, HUMAN)).rejects.toMatchObject({ code: "invalid_state" });

    await ui.decideRuleSuggestion(id, "approve", HUMAN);
    expect((await sug()).state).toBe("approved");
    // Approving twice is refused (the stage moves only forward).
    await expect(ui.decideRuleSuggestion(id, "reject", HUMAN)).rejects.toMatchObject({ code: "invalid_state" });
    // Agents read the stage through list_proposals.
    const listed = await coord.listProposals({ kind: ["rule_change"], ids: [id], limit: 5 });
    expect(String(listed.rows[0]![4])).toContain("[aprobada · pendiente de publicar]");

    await expect(ui.publishRuleSuggestion(id, {}, HUMAN)).rejects.toMatchObject({ code: "approval_missing" });
    const published = await ui.publishRuleSuggestion(id, { demo: true }, HUMAN);
    expect(published.state).toBe("published");
    expect(published.publication).toMatchObject({ by: HUMAN.name, proof: "demo", files: [`rules/${RULES_FILE}`] });
    const written = readFileSync(join(dir, RULES_FILE), "utf8");
    expect(written).toContain("name: demolished element (v2)");
    // The repository rules are untouched (the test writes to a temp copy).
    expect(readFileSync(join(SRC, RULES_FILE), "utf8")).toBe(original);
    expect(loadRules(dir).source.classification.rules.find((r) => r.id === "HYG-001")!.name).toBe("demolished element (v2)");
    const pub = (await coord.rulePublisher.list()).at(-1)!;
    expect(readFileSync(coord.store.path("rule-publications", pub.id, "before", RULES_FILE), "utf8").replace(/\r\n/g, "\n")).toBe(original.replace(/\r\n/g, "\n"));
    expect((await coord.store.getProposal(id))!.state).toBe("applied");
    const audit = await coord.store.listAudit();
    expect(audit.find((e) => e.action === "rule.published")).toMatchObject({ actor: { type: "user", name: HUMAN.name }, targetIds: [id, pub.id] });
    expect(String((await coord.listProposals({ kind: ["rule_change"], ids: [id], limit: 5 })).rows[0]![4])).toContain("[publicada]");
    await expect(ui.publishRuleSuggestion(id, { demo: true }, HUMAN)).rejects.toMatchObject({ code: "invalid_state" });

    const reverted = await ui.revertRuleSuggestion(id, { demo: true }, HUMAN);
    expect(reverted.state).toBe("reverted");
    expect(reverted.publication?.reverted?.by).toBe(HUMAN.name);
    expect(readFileSync(join(dir, RULES_FILE), "utf8").replace(/\r\n/g, "\n")).toBe(original.replace(/\r\n/g, "\n"));
    expect((await coord.store.listAudit()).some((e) => e.action === "rule.reverted")).toBe(true);
    await expect(ui.revertRuleSuggestion(id, { demo: true }, HUMAN)).rejects.toMatchObject({ code: "invalid_state" });
  }, 180_000);

  it("revert refuses when the rules changed after publishing; a tampered patch is never published", async () => {
    const id = await propose(coord, testKey, renamePatch(), "Renombrar otra vez");
    await ui.decideRuleSuggestion(id, "approve", HUMAN);
    await ui.publishRuleSuggestion(id, { demo: true }, HUMAN);
    const file = join(dir, RULES_FILE);
    const published = readFileSync(file, "utf8");
    writeFileSync(file, published + "\n# editado a mano\n");
    await expect(ui.revertRuleSuggestion(id, { demo: true }, HUMAN)).rejects.toMatchObject({ code: "conflict" });
    writeFileSync(file, published);
    await ui.revertRuleSuggestion(id, { demo: true }, HUMAN);

    const t2 = await propose(coord, testKey, renamePatch(), "Patch alterado");
    await ui.decideRuleSuggestion(t2, "approve", HUMAN);
    const p = (await coord.store.getProposal(t2))!;
    if (p.payload.kind !== "rule_change") throw new Error("kind");
    writeFileSync(p.payload.patchFile, renamePatch().replace("(v2)", "(atacante)"));
    await expect(ui.publishRuleSuggestion(t2, { demo: true }, HUMAN)).rejects.toMatchObject({ code: "approval_invalid" });
    expect(readFileSync(file, "utf8")).not.toContain("atacante");
  }, 180_000);

  it("the evaluation gate refuses any regression and writes nothing", async () => {
    const id = await propose(coord, testKey, renamePatch(), "Regresión simulada");
    await ui.decideRuleSuggestion(id, "approve", HUMAN);
    const real = coord.evaluateRuleset.bind(coord);
    coord.evaluateRuleset = (async () => ({
      baseline: { macroF1: 0.9, unsafeClosureRate: 0, criticalFalseNegatives: 0, scenariosExactMatch: 10 },
      candidate: { macroF1: 0.8, unsafeClosureRate: 0, criticalFalseNegatives: 0, scenariosExactMatch: 10 },
      regressions: [{ scenario: "EV-01", field: "validity", expected: "real", got: "false_positive" }],
      schemaErrors: [],
      cases: 1,
    })) as never;
    try {
      const before = readFileSync(join(dir, RULES_FILE), "utf8");
      await expect(ui.publishRuleSuggestion(id, { demo: true }, HUMAN)).rejects.toThrow(/regresión|macro-F1/);
      expect(readFileSync(join(dir, RULES_FILE), "utf8")).toBe(before);
      expect((await ui.ruleSuggestions()).find((s) => s.id === id)!.state).toBe("approved");
    } finally {
      coord.evaluateRuleset = real;
    }
  }, 120_000);

  it("Spanish names and a plain-language effect with the impact on the current test", async () => {
    const rules = await ui.rules();
    const hyg = rules.find((r) => r.id === "HYG-001")!;
    expect(hyg.nameEs).toBe("Elemento demolido");
    expect(hyg.outcomeEs).toContain("No es problema");
    // Validity change of the most-hit rule of the test: effect sentence + impact counts.
    const cls = (await coord.store.getClassification(testKey))!;
    const top = cls.stats.topRules.find((r) => r.ruleId !== "DEF-999")!.ruleId;
    const rule = loadRules().source.classification.rules.find((r) => r.id === top)!;
    const to = rule.then.validity === "needs_info" ? "real" : "needs_info";
    const id = await propose(coord, testKey, patchFor(original, new RegExp(`- id: ${top}$`), /then: \{ validity: /, (l) => l.replace(/validity: \w+/, `validity: ${to}`)), `Cambiar ${top}`);
    const s = (await ui.ruleSuggestions()).find((x) => x.id === id)!;
    expect(s.effect?.join(" ")).toMatch(/pasan de .+ a (Falta información|Conflicto)/);
    expect(s.impact).toMatchObject({ testKey });
    expect(s.impact!.clashes).toBeGreaterThan(0);
    expect(s.impact!.groups).toBeGreaterThan(0);
  }, 180_000);

  it("describeRuleChange: new, changed and removed rules in coordinator language", () => {
    const base = loadRules();
    const cand = structuredClone(base.source.classification) as typeof base.source.classification;
    const fp = cand.rules.find((r) => r.id === "HYG-001")!;
    fp.then = { ...fp.then, severity: "low" };
    cand.rules = cand.rules.filter((r) => r.id !== "HYG-002");
    const fake = { ...base, source: { ...base.source, classification: cand } } as typeof base;
    const out = describeRuleChange(base, fake);
    expect(out.some((l) => l.includes("Elemento demolido") && l.includes("severidad"))).toBe(true);
    expect(out.some((l) => l.startsWith("Se elimina"))).toBe(true);
  });
});

describe("G15 live-like: only a passkey publishes", () => {
  it("demo proof is refused; a WebAuthn assertion over the exact files publishes", async () => {
    const t = tempHome();
    const liveDir = tempRules();
    try {
      const live = makeLiveLike(t.home);
      const lui = new CoordinatorUi(live);
      live.rulePublisher = new RulePublisher(live, { rulesDir: liveDir });
      const key = await ingest(live, 42);
      const id = await propose(live, key, renamePatch());
      await lui.decideRuleSuggestion(id, "approve", HUMAN);
      await expect(lui.publishRuleSuggestion(id, { demo: true }, HUMAN)).rejects.toMatchObject({ code: "approval_missing" });
      await expect(lui.rulePublishOptions(id, "publish")).rejects.toMatchObject({ code: "approval_missing" });
      const auth = new SoftAuthenticator();
      await enrollPasskey(live, auth);
      // A presence-only tap (no user verification) is refused.
      const o1 = await lui.rulePublishOptions(id, "publish");
      await expect(lui.publishRuleSuggestion(id, { webauthn: { nonce: o1.nonce, origin: auth.origin, response: auth.assert(o1.options as { challenge: string }, { userVerified: false }) } }, HUMAN)).rejects.toMatchObject({ code: "approval_invalid" });
      // An assertion for another suggestion's challenge does not publish this one.
      const o2 = await lui.rulePublishOptions(id, "publish");
      const res = await lui.publishRuleSuggestion(id, { webauthn: { nonce: o2.nonce, origin: auth.origin, response: auth.assert(o2.options as { challenge: string }) } }, HUMAN);
      expect(res.state).toBe("published");
      expect(res.publication?.proof).toBe("webauthn");
      expect(readFileSync(join(liveDir, RULES_FILE), "utf8")).toContain("(v2)");
      // Nonces are single use.
      await expect(lui.revertRuleSuggestion(id, { webauthn: { nonce: o2.nonce, origin: auth.origin, response: auth.assert(o2.options as { challenge: string }) } }, HUMAN)).rejects.toMatchObject({ code: "approval_invalid" });
      const o3 = await lui.rulePublishOptions(id, "revert");
      expect((await lui.revertRuleSuggestion(id, { webauthn: { nonce: o3.nonce, origin: auth.origin, response: auth.assert(o3.options as { challenge: string }) } }, HUMAN)).state).toBe("reverted");
    } finally {
      t.cleanup();
      rmSync(liveDir, { recursive: true, force: true });
    }
  }, 240_000);

  it("no MCP tool approves or publishes rules", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.filter((n) => /publish|approve_rule|decide_rule|revert/.test(n))).toEqual([]);
    expect(existsSync(join(ROOT, "server", "rules-publish.ts"))).toBe(true);
  });
});
