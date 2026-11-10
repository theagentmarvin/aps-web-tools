import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveBatch } from "../../server/approval";
import type { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { createCoordServer } from "../../server/mcp/server";
import { TOOLS } from "../../server/mcp/contracts";
import { acceptGroups, HUMAN, makeCoord, MODEL_SET_ID, tempHome, testConfig } from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = { ok: boolean; data?: any; error?: { code: string; message: string }; truncated?: boolean; hint?: string };

let coord: Coordinator;
let client: Client;
let cleanup: () => void;

async function call(name: string, args: Record<string, unknown> = {}): Promise<Env> {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const env = JSON.parse(res.content[0]!.text) as Env;
  expect(!!res.isError).toBe(!env.ok);
  return env;
}

beforeAll(async () => {
  const t = tempHome();
  cleanup = t.cleanup;
  coord = makeCoord(t.home);
  const server = createCoordServer(coord);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});
afterAll(async () => {
  await client.close();
  cleanup();
});

describe("coord MCP server (fixtures)", () => {
  it("lists every contract tool and no approve tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(tools).toHaveLength(46);
    // No MCP tool may approve, sign, edit, exclude, return, discard, publish rules or answer questions.
    expect(tools.map((t) => t.name).filter((n) => /approve|sign|exclude|discard|return_|publish|answer|decide/.test(n) && n !== "apply_approved_proposals")).toEqual([]);
    const apply = tools.find((t) => t.name === "apply_approved_proposals")!;
    expect(apply.annotations?.destructiveHint).toBe(true);
    expect(JSON.stringify(apply.inputSchema)).toContain("dryRun");
  });

  it("full round trip: ingest → classify → list_groups → propose → list_proposals → apply refused → human approval → apply dryRun", async () => {
    const st = await call("get_session_status");
    expect(st.data.autonomy.effectiveLevel).toBe(1);
    expect(JSON.stringify(st.data)).not.toMatch(/accessToken|refresh/i);

    const ctx = await call("set_active_context", { projectId: "demo-proyecto", modelSetId: MODEL_SET_ID });
    expect(ctx.data.projectId).toBe("b.demo-proyecto");
    const tests = await call("list_clash_tests", {});
    expect(tests.data.columns).toContain("cachedTestKey");
    const v42 = tests.data.rows.find((r: unknown[]) => r[2] === 42);
    const ing = await call("ingest_clash_test", { testId: v42[0] });
    expect(ing.ok).toBe(true);
    expect(ing.data.counts.clashes).toBe(303);
    expect(ing.data.documents[0].name).toHaveProperty("untrusted");
    const testKey = ing.data.testKey as string;

    const cls = await call("run_classification", { proposeAutoAccepted: true });
    expect(cls.data.groups.total).toBeGreaterThan(10);
    expect(Object.keys(cls.data.byValidity).sort()).toEqual(["false_positive", "needs_info", "real", "tolerated"]);
    expect(cls.data.batchProposals.length).toBeGreaterThan(0);

    const sum = await call("summarize_clashes", { groupBy: ["disciplinePair", "validity"] });
    expect(sum.data.columns).toEqual(["disciplinePair", "validity", "count", "pctOfTotal", "maxPenetrationMm"]);

    const groups = await call("list_groups", { filter: { needsReview: true, validity: ["false_positive", "tolerated"] }, limit: 50 });
    expect(groups.data.rows.length).toBeGreaterThan(0);
    const label = groups.data.rows[0][10];
    expect(label).toHaveProperty("untrusted");
    const closable = groups.data.rows.find((r: unknown[]) => r[5] === "false_positive" || r[5] === "tolerated");
    expect(closable).toBeDefined();
    const groupId = closable[0] as string;

    const g = await call("get_group", { groupId });
    expect(g.data.groupId).toBe(groupId);
    expect(g.data.sample.length).toBeGreaterThan(0);

    const prop = await call("propose_status_change", {
      target: { groupId },
      action: closable[5] === "tolerated" ? "mark_reviewed" : "close_not_issue",
      rationale: `Revisado ${groupId}: interferencia sin relevancia constructiva según evidencia de reglas.`,
      evidence: [{ kind: "rule_hit", ref: g.data.classification.ruleId, summary: "regla del motor" }],
      confidence: "alta",
    });
    expect(prop.ok).toBe(true);
    const proposalId = prop.data.proposalId as string;
    expect(proposalId).toMatch(/^P-\d{8}-\d{4}$/);
    expect(prop.data.status).toBe("pending_review");

    const list = await call("list_proposals", { status: ["pending"] });
    expect(list.data.rows.map((r: unknown[]) => r[0])).toContain(proposalId);
    expect(list.data.counts.pending_review).toBeGreaterThan(0);

    const noBatch = await call("apply_approved_proposals", { batchId: "L-2026-01-01-01", dryRun: false });
    expect(noBatch.error?.code).toBe("not_found");

    // The coordinator decides in the web UI and sends to approval (no approval yet).
    const ui = new CoordinatorUi(coord);
    await acceptGroups(ui, testKey, [groupId]);
    const batch = await ui.sendToApproval({ projectId: "demo-proyecto", modelSetId: MODEL_SET_ID, testId: testKey }, HUMAN);
    expect(batch.items.some((i) => i.proposalIds.includes(proposalId))).toBe(true);
    const refused = await call("apply_approved_proposals", { batchId: batch.id, dryRun: false });
    expect(refused.data).toMatchObject({ batchId: batch.id, outcome: "refused", refusedReason: "not_approved" });

    // A HUMAN approves through the service (web UI path), never through MCP.
    await approveBatch(coord.approvalDeps(), batch.id, { ...HUMAN, channel: "web-ui" }, { demo: true });

    const dry = await call("apply_approved_proposals", { batchId: batch.id });
    expect(dry.data.outcome).toBe("would_apply");
    expect(dry.data.operations).toHaveLength(1);
    expect(dry.data.operations[0]).toMatchObject({ op: "clash.close", groups: 1, method: "POST" });
    expect(dry.data.operations[0].body).toHaveLength(1);
    expect(dry.data.operations[0].body[0].reason).toBe(closable[5] === "tolerated" ? "MINIMAL_OVERLAP" : "MODEL_INACCURACY");

    const audit = await coord.store.listAudit();
    expect(audit.filter((e) => e.action === "tool.call").length).toBeGreaterThan(8);
  }, 30_000); // full end-to-end flow: slow under parallel suite load

  it("validates agent-written text and referenced ids", async () => {
    const groups = await call("list_groups", { filter: { validity: ["real"] }, limit: 1 });
    const groupId = groups.data.rows[0][0];
    const base = { groupId, title: "[P1][CLI×EST] Nivel 1 · Ducto × viga", responsibleDiscipline: "CLI", priorityHint: "P1", rationale: "Grupo real con penetración relevante.", confidence: "alta" };
    const desc = "**Problema** ducto atraviesa viga. **Ubicación** Nivel 1. **Acción solicitada** desviar ducto.";
    const url = await call("draft_issue", { ...base, description: `${desc} Ver https://evil.example.com/x` });
    expect(url.error?.code).toBe("validation_error");
    expect(url.error?.message).toMatch(/URL/);
    const mention = await call("draft_issue", { ...base, description: `${desc} Avisar a @jperez urgente.` });
    expect(mention.error?.message).toMatch(/@/);
    const email = await call("draft_issue", { ...base, description: `${desc} Escribir a juan@empresa.cl` });
    expect(email.error?.message).toMatch(/correo/);
    const ghost = await call("draft_issue", { ...base, description: `${desc} Ver también G-ffffffffff.` });
    expect(ghost.error?.message).toMatch(/inexistentes/);
    const ok = await call("draft_issue", { ...base, description: `${desc} Referencia ${groupId}.` });
    expect(ok.ok).toBe(true);
    expect(ok.data.kind).toBe("issue_draft");
  });

  it("never proposes closing real clashes", async () => {
    const groups = await call("list_groups", { filter: { validity: ["real"] }, limit: 1 });
    const r = await call("propose_status_change", {
      target: { groupId: groups.data.rows[0][0] },
      action: "close_not_issue",
      rationale: "Intento de cerrar un grupo real (debe fallar).",
      confidence: "media",
    });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/real/);
  });
  it("caps responses and wraps model text as untrusted", async () => {
    const r = await call("list_clashes", { limit: 100 });
    const text = JSON.stringify(r);
    expect(text.length).toBeLessThanOrEqual(6000 * 4 + 200);
    const groups = await call("list_groups", { limit: 1 });
    const g = await call("get_group", { groupId: groups.data.rows[0][0] });
    for (const el of g.data.elements ?? []) if (el.type) expect(el.type).toHaveProperty("untrusted");
  });

  it("returns errors as envelopes with hints", async () => {
    const r = await call("get_group", { groupId: "G-0000000000" });
    expect(r).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(r.hint).toBeTruthy();
  });

  it("L0 forbids proposal tools", async () => {
    const t = tempHome();
    const c0 = makeCoord(t.home, { config: testConfig({}, 0) });
    const server = createCoordServer(c0);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const cl = new Client({ name: "t0", version: "0" });
    await cl.connect(b);
    const res = (await cl.callTool({ name: "withdraw_proposal", arguments: { proposalId: "P-20260101-0001", reason: "x y z" } })) as { content: Array<{ text: string }> };
    expect(JSON.parse(res.content[0]!.text).error.code).toBe("autonomy_level_forbids");
    await cl.close();
    t.cleanup();
  });
});

describe("parity reads and propose_family_exception (agent-human-parity.md §4)", () => {
  const SECRET = /nonce|signature|credential|token|approvedBy|createdBy|userName|userId|Camila|u-camila|@/i;

  it("list_batches / get_batch: state, items per op, preflight, approval validity; no secrets or names", async () => {
    const list = await call("list_batches", {});
    expect(list.ok).toBe(true);
    expect(list.data.columns).toEqual(["batchId", "testKey", "state", "modelSetVersion", "latestVersion", "stale", "items", "excluded", "byOp", "clashes", "conflicts", "lastPreflightAt", "approvedAt", "appliedAt", "createdAt"]);
    const row = list.data.rows[0];
    expect(row[2]).toBe("approved");
    expect(row[5]).toBe(false);
    expect(row[8]).toMatchObject({ close: 1 });
    expect(JSON.stringify(list.data.rows)).not.toMatch(SECRET);

    const b = await call("get_batch", { batchId: row[0] });
    expect(b.ok).toBe(true);
    expect(b.data).toMatchObject({ batchId: row[0], state: "approved", stale: false, approval: { valid: true }, applyStatus: { closes: { done: 0, total: 1 } } });
    expect(b.data.items.rows[0][5]).toHaveProperty("untrusted");
    const { nextStep: _s, ...data } = b.data;
    void _s;
    expect(JSON.stringify(data)).not.toMatch(SECRET);
    expect((await call("get_batch", { batchId: "L-nope" })).error?.code).toBe("not_found");

    // Stale: a batch built on an older model-set version (switch point for WS-A batchRebaseInfo).
    const rec = (await coord.store.getBatch(row[0]))!;
    await coord.store.putBatch({ ...rec, id: "L-test-stale", state: "ready", modelSetVersion: rec.modelSetVersion - 1 });
    const stale = await call("get_batch", { batchId: "L-test-stale" });
    expect(stale.data).toMatchObject({ stale: true, latestVersion: rec.modelSetVersion });
    expect(stale.data.warning).toMatch(/versión/);
    const ready = await call("list_batches", { state: ["ready"] });
    expect(ready.data.rows.map((r: unknown[]) => [r[0], r[5]])).toEqual([["L-test-stale", true]]);
  });

  it("list_decisions: human history without person names", async () => {
    const d = await call("list_decisions", {});
    expect(d.ok).toBe(true);
    expect(d.data.rows.length).toBeGreaterThan(0);
    expect(d.data.rows[0][2]).toBe("accept");
    expect(JSON.stringify(d.data.rows)).not.toMatch(/Camila|u-camila/);
    const none = await call("list_decisions", { kind: ["reject"] });
    expect(none.data.rows).toEqual([]);
  });

  it("get_agenda / list_reminders: server numbers, untrusted titles", async () => {
    const a = await call("get_agenda", {});
    expect(a.ok).toBe(true);
    const direct = await coord.agendaFor(undefined);
    expect(a.data.rows.length).toBe(direct.disciplines.reduce((n, x) => n + x.items.length, 0));
    for (const r of a.data.rows) expect(r[7]).toHaveProperty("untrusted");
    const rem = await call("list_reminders", {});
    expect(rem.ok).toBe(true);
    expect(rem.data.columns).toEqual(["discipline", "counts", "issueIds", "lines"]);
  });

  it("propose_family_exception: refused for closing real, human applies it with proposalId", async () => {
    const testKey = (await coord.store.getContext())!.testKey!;
    const { views } = await coord.familyViewsFor(testKey);
    let realTarget: { familyId: string; groupId: string } | undefined;
    let other: { familyId: string; groupId: string } | undefined;
    for (const f of views) {
      for (const i of f.instances) {
        if (!realTarget && i.validity === "real") realTarget = { familyId: f.id, groupId: i.groupId };
        if (!other && i.validity !== "real" && i.validity !== "needs_info") other = { familyId: f.id, groupId: i.groupId };
      }
    }
    expect(realTarget && other).toBeTruthy();

    const closeReal = await call("propose_family_exception", { ...realTarget!, fields: { action: "close" }, reason: "Tramo distinto al resto", rationale: "Prueba: cerrar una real debe fallar." });
    expect(closeReal.error?.code).toBe("validation_error");
    expect(closeReal.error?.message).toMatch(/real/);
    const closeClaim = await call("propose_family_exception", { ...realTarget!, fields: { validity: "false_positive", action: "close" }, reason: "Dice falso positivo", rationale: "Prueba: reclasificar y cerrar una real debe fallar." });
    expect(closeClaim.ok).toBe(false);
    const empty = await call("propose_family_exception", { ...other!, fields: {}, reason: "x", rationale: "sin campos" });
    expect(empty.error?.code).toBe("validation_error");
    const wrongGroup = await call("propose_family_exception", { familyId: other!.familyId, groupId: "G-0000000000", fields: { action: "escalate" }, reason: "x", rationale: "grupo ajeno" });
    expect(wrongGroup.error?.code).toBe("not_found");

    const p = await call("propose_family_exception", { ...other!, fields: { action: "escalate" }, reason: "Ubicación en shaft, la resuelve el calculista", rationale: "Instancia distinta: requiere decisión del calculista." });
    expect(p.ok).toBe(true);
    expect(p.data.kind).toBe("family_exception");
    const dup = await call("propose_family_exception", { ...other!, fields: { action: "escalate" }, reason: "otra vez", rationale: "duplicada" });
    expect(dup.error?.code).toBe("conflict");
    const listed = await call("list_proposals", { kind: ["family_exception"] });
    expect(listed.data.rows.map((r: unknown[]) => r[0])).toContain(p.data.proposalId);

    // The human sees it on the family and accepts it through the existing exceptions route.
    const ui = new CoordinatorUi(coord);
    const fam = await ui.family(testKey, other!.familyId);
    expect(fam.pendingExceptions?.map((x) => x.id)).toEqual([p.data.proposalId]);
    const prop = (await coord.store.getProposal(p.data.proposalId))!;
    const pl = prop.payload as unknown as { fields: Record<string, never>; reason: string };
    // A proposal for another instance is refused.
    const strayGroup = views.find((f) => f.id === other!.familyId)!.groupIds.find((g) => g !== other!.groupId);
    if (strayGroup) await expect(ui.addFamilyException(other!.familyId, { testId: testKey, groupId: strayGroup, fields: pl.fields, reason: pl.reason, proposalId: p.data.proposalId }, HUMAN)).rejects.toThrow(/no es una excepción/);
    const after = await ui.addFamilyException(other!.familyId, { testId: testKey, groupId: other!.groupId, fields: pl.fields, reason: pl.reason, proposalId: p.data.proposalId }, HUMAN);
    expect(after.exceptions.some((e) => e.groupId === other!.groupId)).toBe(true);
    expect(after.pendingExceptions).toBeUndefined();
    expect((await coord.store.getProposal(p.data.proposalId))!.state).toBe("applied");
    await expect(ui.addFamilyException(other!.familyId, { testId: testKey, groupId: other!.groupId, fields: pl.fields, reason: pl.reason, proposalId: p.data.proposalId }, HUMAN)).rejects.toThrow(/applied/);
    // The triage payload still loads with the new proposal kind around.
    await expect(ui.families(testKey)).resolves.toBeTruthy();
  });
});
