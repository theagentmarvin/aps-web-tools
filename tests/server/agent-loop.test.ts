/**
 * Agent ↔ coordinator loop (docs/ux/agent-human-loop-proposal.md): provenance of a family /
 * ubicación proposal, the agent-values fix («Aceptar propuesta» accepts what is shown), learning
 * receipts equal to the Reglas accuracy deltas, batch state on families, undo, the cycle dashboard
 * and the chat «Rechazar» (proposal rejected + feedback to the agent).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Coordinator } from "../../server/coordinator";
import type { AccuracyMap } from "../../server/rule-accuracy";
import { CoordinatorUi, HUMAN, ingest, makeCoord, MODEL_SET_ID, tempHome } from "./helpers";

const P = "demo-proyecto";

function sums(m: AccuracyMap): Map<string, { agree: number; n: number }> {
  return new Map([...m.entries()].map(([k, v]) => [k, { agree: v.agree, n: v.n }]));
}

describe("agent ↔ coordinator loop", () => {
  let home: string;
  let cleanup: () => void;
  let coord: Coordinator;
  let ui: CoordinatorUi;
  let k41: string;
  let k42: string;
  beforeAll(async () => {
    ({ home, cleanup } = tempHome());
    coord = makeCoord(home);
    ui = new CoordinatorUi(coord);
    k41 = await ingest(coord, 41);
    k42 = await ingest(coord, 42);
  });
  afterAll(() => cleanup());

  const realFamilies = async (k: string) => (await ui.families(k)).families.filter((f) => f.state === "sin_decidir" && f.proposed.validity === "real" && !f.validityMix.tolerated && !f.validityMix.false_positive && !f.pendingProposals.length);

  it("provenance: engine rules with accuracy and n; DEF-999 flagged; groups carry it too", async () => {
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    const f = tri.families!.find((x) => x.state === "sin_decidir")!;
    expect(f.provenance?.source).toBe("rule");
    expect(f.provenance!.rules.length).toBeGreaterThan(0);
    const top = f.provenance!.rules[0]!;
    expect(top.id).toMatch(/^[A-Z]{2,4}-\d{3}$/);
    expect(top.accuracy).toMatchObject({ n: expect.any(Number), agree: expect.any(Number) });
    // Same accuracy as the Reglas page.
    const row = (await coord.ruleAuthoring.overview(k42)).rules.find((r) => r.id === top.id);
    if (row) expect(top.accuracy.rate).toBe(row.accuracy.rate);
    for (const r of tri.families!.flatMap((x) => x.provenance?.rules ?? [])) expect(!!r.fallback).toBe(r.id === "DEF-999");
    const g = tri.groups.find((x) => x.provenance)!;
    expect(["rule", "agent", "inherited", "human"]).toContain(g.provenance!.source);
  });

  it("agent proposal: provenance agent with «≠ regla» diffs; Aceptar (proposalId, no fields) accepts the AGENT values; receipt counts a correction of the rule", async () => {
    const f = (await realFamilies(k42)).find((x) => x.instanceCount >= 2)!;
    expect(f).toBeDefined();
    const r = await coord.proposeFamilyDecision({ testKey: k42, familyId: f.id, validity: "needs_info", action: "escalate", rationale: "Falta confirmar la cota del cielo." });
    const withAgent = await ui.family(k42, f.id);
    expect(withAgent.provenance?.source).toBe("agent");
    expect(withAgent.provenance?.agent?.proposalId).toBe(r.proposalId);
    expect(withAgent.provenance?.agent?.diffs).toEqual(
      expect.arrayContaining([
        { field: "validity", ruleValue: "real", agentValue: "needs_info" },
        { field: "action", ruleValue: f.proposed.action, agentValue: "escalate" },
      ]),
    );
    // Preview with the proposal id (what the dialog sends) previews the agent values.
    const prev = await ui.familyDecisionPreview(f.id, { testId: k42, proposalId: r.proposalId });
    expect(prev.validityChanges.every((c) => c.to === "needs_info")).toBe(true);
    expect(prev.learning!.some((l) => l.corrections.length > 0)).toBe(true);
    // The fix: no fields in the request → the agent's values, not the engine's.
    const d = await ui.decideFamily(f.id, { testId: k42, decision: "approve", proposalId: r.proposalId, acknowledgeValidityChanges: true }, HUMAN);
    expect(d.decision).toMatchObject({ validity: "needs_info", action: "escalate", status: "approved" });
    expect((await coord.store.getProposal(r.proposalId))!.state).toBe("applied");
    expect(d.receipt?.kind).toBe("approved");
    expect(d.receipt?.agent).toEqual({ proposalId: r.proposalId, unchanged: true });
    // Same learning as the preview (same function, nothing changed in between).
    expect(d.receipt!.learning).toEqual(prev.learning);
    expect(d.provenance?.source).toBe("human");
  });

  it("learning numbers equal accuracy() deltas (preview = receipt = Reglas)", async () => {
    const f = (await realFamilies(k42))[0]!;
    const before = sums(await coord.ruleAuthoring.accuracy());
    const prev = await ui.familyDecisionPreview(f.id, { testId: k42 });
    const d = await ui.decideFamily(f.id, { testId: k42, decision: "approve" }, HUMAN);
    const after = sums(await coord.ruleAuthoring.accuracy());
    expect(d.receipt!.learning).toEqual(prev.learning);
    expect(d.receipt!.learning.length).toBeGreaterThan(0);
    for (const l of d.receipt!.learning) {
      const b = before.get(l.ruleId) ?? { agree: 0, n: 0 };
      const a = after.get(l.ruleId)!;
      expect(a.agree - b.agree).toBe(l.hits);
      expect(a.n - b.n).toBe(l.hits + l.corrections.reduce((n, c) => n + c.count, 0));
      expect(l.after.n).toBe(a.n);
    }
    // Undo: back to undecided, learning reversed, audited.
    const u = await ui.undoFamilyDecision(f.id, { testId: k42, version: d.decision!.version }, HUMAN);
    expect(u.state).toBe("sin_decidir");
    expect(u.receipt?.kind).toBe("undone");
    expect(sums(await coord.ruleAuthoring.accuracy())).toEqual(before);
    await expect(ui.undoFamilyDecision(f.id, { testId: k42, version: d.decision!.version }, HUMAN)).rejects.toThrow(/no es la vigente/);
    expect((await coord.store.listAudit()).some((e) => e.action === "family.undone" && e.targetIds.includes(f.id))).toBe(true);
  });

  it("undo of a second version restores the first one (new version, append-only)", async () => {
    const f = (await realFamilies(k42))[0]!;
    const d1 = await ui.decideFamily(f.id, { testId: k42, decision: "approve" }, HUMAN);
    const d2 = await ui.decideFamily(f.id, { testId: k42, decision: "approve", action: "escalate" }, HUMAN);
    expect(d2.decision!.version).toBe(d1.decision!.version + 1);
    const u = await ui.undoFamilyDecision(f.id, { testId: k42, version: d2.decision!.version }, HUMAN);
    expect(u.decision).toMatchObject({ version: d2.decision!.version + 1, action: d1.decision!.action, status: "approved" });
  });

  it("inherited provenance on the next version; batch state on the family after «Enviar a aprobación»", async () => {
    const a = await ui.families(k41);
    const b = await ui.families(k42);
    const f = a.families.find((x) => x.state === "sin_decidir" && x.proposed.validity === "real" && !x.validityMix.tolerated && !x.validityMix.false_positive && b.families.some((y) => y.id === x.id && y.state === "sin_decidir"))!;
    await ui.decideFamily(f.id, { testId: k41, decision: "approve" }, HUMAN);
    const in42 = await ui.family(k42, f.id);
    expect(in42.provenance?.source).toBe("inherited");
    expect(in42.provenance?.inheritedFrom).toMatchObject({ version: 41, source: "family", decidedBy: HUMAN.name });

    const batch = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: k41 }, HUMAN);
    const fam = await ui.family(k41, f.id);
    expect(fam.batch).toMatchObject({ id: batch.id, state: "ready", items: expect.any(Number), applied: 0, failed: 0 });
    // Lote items say who proposed them.
    const item = batch.items.find((i) => i.familyId === f.id)!;
    expect(item.proposer).toBe("motor");
    await ui.discard(batch.id, HUMAN);
    expect((await ui.family(k41, f.id)).batch).toBeUndefined();
  });

  it("chat «Rechazar»: the agent proposal moves to rejected and the rejection is feedback to the agent", async () => {
    const f = (await realFamilies(k42))[0]!;
    const r = await coord.proposeFamilyDecision({ testKey: k42, familyId: f.id, validity: "real", action: "escalate", rationale: "Escalar." });
    const out = await ui.rejectAgentProposal(r.proposalId, { reason: "no corresponde escalar" }, HUMAN);
    expect(out.state).toBe("rejected");
    expect((await coord.store.getProposal(r.proposalId))!.state).toBe("rejected");
    const fb = (await coord.store.listFeedback()).find((x) => x.id === out.feedbackId)!;
    expect(fb).toMatchObject({ verdict: "incorrect", source: "ui", target: { proposalId: r.proposalId } });
    expect(fb.coordinatorStatement).toContain("no corresponde escalar");
    await expect(ui.rejectAgentProposal(r.proposalId, {}, HUMAN)).rejects.toThrow(/ya fue decidida/);
    expect((await ui.family(k42, f.id)).pendingProposals).toHaveLength(0);
  });

  it("cycle-loop: proposals, decisions, batch, learning and engine accuracy per version from the server", async () => {
    const c = await ui.cycleLoop(P, k42);
    expect(c.testKey).toBe(k42);
    expect(c.version).toBe(42);
    expect(c.proposals.engine + c.proposals.agent).toBe(c.decisions.total);
    expect(c.decisions.accepted + c.decisions.corrected + c.decisions.pending + c.decisions.oneByOne).toBe(c.decisions.total);
    expect(c.decisions.accepted + c.decisions.corrected).toBeGreaterThan(0);
    expect(c.agent.decided).toBeGreaterThanOrEqual(2);
    expect(c.agent.acceptedUnchanged).toBeGreaterThanOrEqual(1);
    expect(c.agent.rejected).toBeGreaterThanOrEqual(1);
    expect(c.accuracyByVersion.map((x) => x.version)).toContain(42);
    for (const v of c.accuracyByVersion) expect(v.agree).toBeLessThanOrEqual(v.n);
    expect(c.learning.corrections).toBeGreaterThanOrEqual(1);
    // Default test: the latest classified.
    expect((await ui.cycleLoop(P)).version).toBe(42);
  });

  it("ubicación decisions return their learning (same tally)", async () => {
    const tri = await ui.triage(P, MODEL_SET_ID, k41);
    const g = tri.groups.find((x) => x.ruleId && x.reviewState !== "decided" && !x.inherited && x.provenance?.source === "rule")!;
    const prop = tri.proposals.find((p) => p.targetId === g.id)!;
    const before = sums(await coord.ruleAuthoring.accuracy());
    const res = await ui.saveDecisions(
      [{ id: `D-loop-${g.id}`, proposalId: prop.id, targetType: "group", targetId: g.id, testId: k41, modelSetId: MODEL_SET_ID, projectId: P, kind: "accept", changes: [], viewedInViewerMs: 0, decidedAt: new Date().toISOString(), userId: "x", userName: "x" }],
      HUMAN,
    );
    const after = sums(await coord.ruleAuthoring.accuracy());
    const l = res.learning?.find((x) => x.targetId === g.id);
    expect(l).toBeDefined();
    for (const e of l!.entries) expect(after.get(e.ruleId)!.agree - (before.get(e.ruleId)?.agree ?? 0)).toBe(e.hits);
  });
});
