/**
 * WS-N "Qué sigue" (server/next-steps.ts): each step kind from fixture data in a temp store —
 * deterministic, server-only, ordered by priority, with flow actions for agent work and open
 * actions for human steps.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { approveBatch } from "../../server/approval";
import type { NextStep, NextStepKind } from "../../server/api/contract";
import type { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { join } from "node:path";
import { FlowRunStore } from "../../server/flows/store";
import { nextSteps } from "../../server/next-steps";
import { acceptGroups, HUMAN, ingest, makeCoord, MODEL_SET_ID, ROOT, tempHome } from "./helpers";

const PROJECT = "demo-proyecto";
let clock = Date.parse("2026-11-11T10:00:00Z");
const tick = (ms = 60_000) => (clock += ms);
let coord: Coordinator;
let ui: CoordinatorUi;
let testKey: string;

const kinds = (s: NextStep[]) => s.map((x) => x.kind);
const step = (s: NextStep[], k: NextStepKind) => s.find((x) => x.kind === k);
const run = async (q: { projectId?: string; testKey?: string } = { projectId: PROJECT }) => (await nextSteps(coord, q)).steps;

beforeAll(async () => {
  const t = tempHome();
  coord = makeCoord(t.home, { now: () => clock });
  ui = new CoordinatorUi(coord);
  await ingest(coord, 41);
  return t.cleanup;
}, 120_000);

describe("next steps (server state only)", () => {
  it("a newer version in ACC → preparar-ciclo first; an unclassified version → preparar-ciclo", async () => {
    const s = await run();
    expect(s[0]).toMatchObject({ kind: "new_version", priority: 5, action: { type: "flow", flow: "preparar-ciclo", args: { projectId: PROJECT } } });
    expect(s[0]!.counts).toEqual({ latestVersion: 42, analyzedVersion: 41 });
    const tk = await ingest(coord, 42, false);
    const s2 = await run({ testKey: tk });
    expect(kinds(s2)).toContain("not_classified");
    expect(kinds(s2)).not.toContain("new_version");
    expect(step(s2, "not_classified")!.action).toEqual({ type: "flow", flow: "preparar-ciclo", args: { projectId: PROJECT, testKey: tk } });
    await coord.classify({ testKey: tk });
    testKey = tk;
  }, 120_000);

  it("a classified cycle: AI review, issue drafts, issue checks, hygiene — ordered by priority, numbers from the store", async () => {
    const p = await nextSteps(coord, { projectId: PROJECT });
    expect(p.testKey).toBe(testKey);
    expect(p.version).toBe(42);
    const s = p.steps;
    expect(kinds(s)).toEqual(expect.arrayContaining(["ai_review", "issue_drafts", "issue_checks", "hygiene_unassigned", "hygiene_duplicates"]));
    expect(kinds(s)).not.toContain("new_version");
    expect(s.map((x) => x.priority)).toEqual([...s.map((x) => x.priority)].sort((a, b) => a - b));
    expect(step(s, "ai_review")!.action).toEqual({ type: "flow", flow: "triage", args: { projectId: PROJECT, testKey } });
    expect(step(s, "issue_drafts")!.action).toMatchObject({ type: "flow", flow: "redactar-issues" });
    expect(step(s, "hygiene_duplicates")!.action).toMatchObject({ type: "flow", flow: "auditar-modelo" });
    expect(step(s, "hygiene_unassigned")!.action).toEqual({ type: "open", route: "disciplines", params: { projectId: PROJECT, modelSetId: MODEL_SET_ID } });
    expect(step(s, "issue_checks")!.action).toMatchObject({ type: "open", route: "triage", params: { lente: "incidencias", testKey } });
    expect(step(s, "ai_review")!.counts.pending).toBeGreaterThan(0);
    // Deterministic: same state → same steps.
    expect((await run()).map((x) => x.id)).toEqual(s.map((x) => x.id));
    // Spanish titles, no internal validity values.
    for (const x of s) expect(`${x.title} ${x.reason}`).not.toMatch(/\b(false_positive|needs_info|tolerated)\b/);
  });

  it("a finished triage flow for the test suppresses the AI-review suggestion", async () => {
    const store = new FlowRunStore(coord.store);
    const r = await store.create({ flowId: "triage", label: "Revisión IA", projectId: PROJECT, testKey, startedBy: "human", costCapUsd: 2 }, { now: clock, dailyAgentCap: 10 });
    await store.update(r.runId, (x) => {
      x.state = "finished";
      x.finishedAt = new Date(clock).toISOString();
    });
    expect(kinds(await run())).not.toContain("ai_review");
    await store.update(r.runId, (x) => {
      x.finishedAt = new Date(clock - 2 * 24 * 3600_000).toISOString();
    });
    expect(kinds(await run())).toContain("ai_review");
  });

  it("open questions → open the triage; the asked groups no longer count as pending AI review", async () => {
    const before = step(await run(), "ai_review")!.counts.pending!;
    const { cls } = await coord.requireClassified(testKey);
    const info = await coord.cycleInfo((await coord.loadTest(testKey)).test, cls);
    const g = cls.groups.find(info.needsHuman)!;
    tick();
    await coord.askCoordinator({ testKey, groupIds: [g.id], question: "¿Esta ubicación es un conflicto real o un falso positivo?", kind: "validity", options: [{ label: "Conflicto", validity: "real" }, { label: "No es problema", validity: "false_positive" }] });
    const s = await run();
    expect(step(s, "open_questions")).toMatchObject({ priority: 25, counts: { questions: 1 }, action: { type: "open", route: "triage", params: { testKey } } });
    expect(step(s, "ai_review")!.counts.pending).toBe(before - 1);
  });

  it("meeting notes written after the last processing → flow acta; a later question on that family processes it", async () => {
    const { views } = await coord.familyViewsFor(testKey);
    const f = views.find((v) => v.groupIds.length > 0)!;
    tick();
    await coord.putMeetingNote(testKey, "family", f.id, "EST revisa la pasada en la viga; se define en la próxima reunión.", HUMAN);
    let s = await run();
    expect(step(s, "meeting_notes")).toMatchObject({ counts: { notes: 1 }, action: { type: "flow", flow: "acta", args: { testKey } } });
    tick();
    await coord.askCoordinator({ testKey, familyId: f.id, question: "¿Quién resuelve la pasada: EST o CLI?", kind: "other", options: [{ label: "EST" }, { label: "CLI" }] });
    s = await run();
    expect(kinds(s)).not.toContain("meeting_notes");
  });

  it("accepted decisions → «Enviar a aprobación»; a ready batch → approve; approved → apply; weekly report once batched", async () => {
    const { cls } = await coord.requireClassified(testKey);
    const g = cls.groups.find((x) => x.validity === "real" && !x.humanReview) ?? cls.groups.find((x) => x.validity === "real")!;
    tick();
    await acceptGroups(ui, testKey, [g.id]);
    let s = await run();
    expect(step(s, "decisions_to_send")).toMatchObject({ priority: 22, action: { type: "open", route: "triage", params: { accion: "enviar" } } });
    expect(step(s, "decisions_to_send")!.counts.groups).toBeGreaterThanOrEqual(1);
    const batch = await ui.sendToApproval({ projectId: PROJECT, modelSetId: MODEL_SET_ID, testId: testKey }, HUMAN);
    s = await run();
    expect(kinds(s)).not.toContain("decisions_to_send");
    expect(step(s, "batch_ready")).toMatchObject({ id: `batch_ready:${batch.id}`, priority: 20, action: { type: "open", route: "batch", params: { batchId: batch.id } } });
    expect(step(s, "weekly_report")).toMatchObject({ action: { type: "flow", flow: "informe-semanal", args: { testKey } } });
    await approveBatch(coord.approvalDeps(), batch.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    s = await run();
    expect(kinds(s)).not.toContain("batch_ready");
    expect(s[0]).toMatchObject({ kind: "batch_approved", priority: 10, action: { type: "open", route: "batch", params: { batchId: batch.id } } });
  });

  it("rule work: uncurated corrections → flow curar-reglas; pending suggestions → open Reglas", async () => {
    const { cls } = await coord.requireClassified(testKey);
    for (const g of cls.groups.slice(0, 5)) await coord.recordFeedback({ target: { groupId: g.id, testKey }, verdict: "incorrect", coordinatorStatement: "El motor debió marcarla como tolerada.", generalizable: "yes", scope: "company" });
    let s = await run();
    expect(step(s, "rule_insights")).toMatchObject({ action: { type: "flow", flow: "curar-reglas" } });
    expect(step(s, "rule_insights")!.counts.uncuratedFeedback).toBeGreaterThanOrEqual(5);
    await coord.store.createProposal({
      kind: "rule_change",
      testKey,
      createdBy: { type: "agent", id: "agent-chat", name: "Agente chat" },
      target: { groupIds: [], clashIds: [] },
      payload: { kind: "rule_change", title: "Calibrar TOL-001", patchFile: "x.patch", patchHash: "0", feedbackIds: [], evaluation: {}, scope: "company" } as never,
      rationale: "Correcciones repetidas.",
      evidence: [],
      confidence: "media",
      risk: "medium",
      affectedClashes: 0,
    });
    s = await run();
    expect(step(s, "rule_suggestions")).toMatchObject({ priority: 55, counts: { pending: 1 }, action: { type: "open", route: "rules" } });
  });

  it("the in-app agent ships with the app: flows available, no 'update the agent' step", async () => {
    const p = await run();
    expect((await nextSteps(coord, { projectId: PROJECT })).flowsAvailable).toBe(true);
    expect(kinds(p).filter((k) => /harness|agent_update/.test(k))).toEqual([]);
    // An app folder without agent-runtime/ reports flows unavailable (never a fallback agent).
    expect((await nextSteps(coord, { projectId: PROJECT }, { agentRoot: join(ROOT, "docs") })).flowsAvailable).toBe(false);
  });

  it("no project: no domain steps; an unknown test is a clear error", async () => {
    const t = tempHome();
    try {
      const empty = makeCoord(t.home);
      expect((await nextSteps(empty, {})).steps).toEqual([]);
      await expect(nextSteps(empty, { testKey: "T-deadbeef" })).rejects.toThrow(/no está en caché/);
    } finally {
      t.cleanup();
    }
  });
});
