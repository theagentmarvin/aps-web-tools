import { readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyApproved, approveBatch, batchPayloadHash, verifyBatchApproval } from "../../server/approval";
import type { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { FixtureSource } from "../../server/source/fixtures";
import { acceptGroups, HUMAN, ingest, makeCoord, MODEL_SET_ID, tempHome, testConfig, TEST_V42 } from "./helpers";

let home: string;
let cleanup: () => void;
let coord: Coordinator;
let ui: CoordinatorUi;
let testKey: string;

beforeEach(async () => {
  ({ home, cleanup } = tempHome());
  coord = makeCoord(home);
  ui = new CoordinatorUi(coord);
  testKey = await ingest(coord, 42);
});
afterEach(() => cleanup());

const deps = (c: Coordinator) => c.approvalDeps();
const actor = { type: "user" as const, id: HUMAN.id, name: HUMAN.name };

/** Accept 3 closable + 3 real groups and send them to approval. */
async function readyBatch(u = ui, key = testKey, closable = 3, real = 3) {
  const views = (await u.proposals(key, undefined, 1000)).items;
  const close = views.filter((v) => v.fields.action.value.setStatus === "closed" && !v.fields.action.value.createIssue).slice(0, closable);
  const issue = views.filter((v) => v.fields.action.value.createIssue).slice(0, real);
  expect(close.length).toBe(closable);
  expect(issue.length).toBe(real);
  await acceptGroups(u, key, [...close, ...issue].map((v) => v.targetId));
  return u.sendToApproval({ projectId: "demo-proyecto", modelSetId: MODEL_SET_ID, testId: key }, HUMAN);
}

describe("HMAC human approval", () => {
  it("builds a ready batch with exact ACC bodies from human decisions", async () => {
    const b = await readyBatch();
    expect(b.state).toBe("ready");
    expect(b.items.filter((i) => i.mcOperation === "clash.close")).toHaveLength(3);
    expect(b.items.filter((i) => i.mcOperation === "clash.assign")).toHaveLength(3);
    for (const i of b.items) {
      const body = i.accNew as { clashes: number[]; title: string };
      expect(body.clashes.length).toBeGreaterThan(0);
      expect(body.clashes.every(Number.isSafeInteger)).toBe(true);
    }
  });

  it("refuses to apply without approval, verifies a valid one", async () => {
    const b = await readyBatch();
    const refused = await applyApproved(deps(coord), b.id, { actor });
    expect(refused.refused?.reason).toBe("not_approved");
    const { approval } = await approveBatch(deps(coord), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    expect(approval.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(approval.testVersion).toBe(42);
    expect(approval.approvedBy.name).toBe("Camila Rojas");
    const v = await verifyBatchApproval(deps(coord), b.id);
    expect(v.ok).toBe(true);
    // proposals moved to approved
    for (const pid of approval.proposalIds) expect((await coord.store.getProposal(pid))?.state ?? "approved").toBe("approved");
  });

  it("detects a tampered approval record", async () => {
    const b = await readyBatch();
    await approveBatch(deps(coord), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    const file = coord.store.path("approvals", `${b.id}.json`);
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.expiresAt = "2099-01-01T00:00:00.000Z";
    await writeFile(file, JSON.stringify(rec));
    expect(await verifyBatchApproval(deps(coord), b.id)).toMatchObject({ ok: false, reason: "approval_signature_invalid" });
  });

  it("detects a batch payload changed after approval", async () => {
    const b = await readyBatch();
    await approveBatch(deps(coord), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    const rec = (await coord.store.getBatch(b.id))!;
    const before = batchPayloadHash(rec);
    (rec.items.find((i) => i.mcOperation === "clash.close")!.accNew as { title: string }).title = "Cambiado después";
    await coord.store.putBatch(rec);
    expect(batchPayloadHash(rec)).not.toBe(before);
    const r = await applyApproved(deps(coord), b.id, { actor, dryRun: false });
    expect(r.refused?.reason).toBe("payload_changed_since_approval");
    expect(await (coord.source as FixtureSource).writes()).toHaveLength(0);
  });

  it("expires approvals", async () => {
    const b = await readyBatch();
    await approveBatch(deps(coord), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    const later = makeCoord(home, { now: () => Date.now() + 8 * 86_400_000 });
    expect(await verifyBatchApproval(deps(later), b.id)).toMatchObject({ ok: false, reason: "approval_expired" });
  });

  it("refuses when the model set moved to a newer version (version drift)", async () => {
    const b = await readyBatch();
    await approveBatch(deps(coord), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    (coord.source as FixtureSource).latestVersion = async () => 43;
    expect(await verifyBatchApproval(deps(coord), b.id)).toMatchObject({ ok: false, reason: "stale_test_version" });
    const r = await applyApproved(deps(coord), b.id, { actor, dryRun: true });
    expect(r.refused?.reason).toBe("stale_test_version");
  });

  it("does not approve a batch built on an old version", async () => {
    const k41 = await ingest(coord, 41);
    const b = await readyBatch(ui, k41, 1, 1);
    await expect(approveBatch(deps(coord), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true })).rejects.toThrow(/v41/);
  });

  it("L0 cannot approve or apply", async () => {
    const b = await readyBatch();
    const l0 = makeCoord(home, { config: testConfig({}, 0) });
    await expect(approveBatch(deps(l0), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true })).rejects.toThrow(/L0/);
    expect((await applyApproved(deps(l0), b.id, { actor })).refused?.reason).toBe("autonomy_level_forbids");
  });
});

describe("apply", () => {
  it("dryRun returns one POST per operation and test carrying many groups, without writing", async () => {
    const b = await readyBatch();
    await approveBatch(deps(coord), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    const r = await applyApproved(deps(coord), b.id, { actor });
    expect(r.dryRun).toBe(true);
    expect(r.requests).toHaveLength(2);
    const close = r.requests.find((q) => q.operation === "clash.close")!;
    const assign = r.requests.find((q) => q.operation === "clash.assign")!;
    expect(close.path).toBe(`/bim360/clash/v3/containers/demo-proyecto/tests/${TEST_V42}/clashes:close`);
    expect(assign.path).toMatch(/clashes:assign$/);
    expect((close.body as unknown[]).length).toBe(3);
    expect((assign.body as Array<{ issueTypeId: string; pushpin: { objectId: number }; documentVersionUrn: string }>).every((g) => g.issueTypeId && Number.isFinite(g.pushpin.objectId) && g.documentVersionUrn)).toBe(true);
    expect(await (coord.source as FixtureSource).writes()).toHaveLength(0);
    expect((await coord.store.getBatch(b.id))!.state).toBe("approved");
  });

  it("applies once; idempotency keys prevent a second send", async () => {
    const b = await readyBatch();
    await approveBatch(deps(coord), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    await applyApproved(deps(coord), b.id, { actor });
    const r = await applyApproved(deps(coord), b.id, { actor, dryRun: false });
    expect(r.ok).toBe(true);
    expect(r.batchState).toBe("applied");
    const src = coord.source as FixtureSource;
    expect(await src.writes()).toHaveLength(2);
    expect(r.items.filter((i) => i.accRefs?.length)).toHaveLength(3);

    // Simulate a crash that lost the item results (but the idempotency records survived).
    const rec = (await coord.store.getBatch(b.id))!;
    for (const i of rec.items) delete i.result;
    rec.state = "approved";
    await coord.store.putBatch(rec);
    const again = await applyApproved(deps(coord), b.id, { actor, dryRun: false });
    expect(again.requests.every((q) => q.outcome === "already_applied")).toBe(true);
    expect(await src.writes()).toHaveLength(2);

    const audit = (await coord.store.listAudit()).map((e) => e.action);
    expect(audit).toContain("acc.clash.statusChanged");
    expect(audit).toContain("acc.issue.created");
    expect((await coord.store.verifyAudit()).ok).toBe(true);
  });

  it("respects the local jobs/hour budget", async () => {
    const c = makeCoord(home, { config: testConfig({ apply: { jobsPerHourPerOperation: 1, maxGroupsPerRequest: 1 } }) });
    const u = new CoordinatorUi(c);
    const b = await readyBatch(u, testKey, 3, 1);
    await approveBatch(deps(c), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    await applyApproved(deps(c), b.id, { actor });
    const r = await applyApproved(deps(c), b.id, { actor, dryRun: false });
    expect(r.requests.filter((q) => q.outcome === "applied")).toHaveLength(2); // 1 close + 1 assign
    expect(r.requests.filter((q) => q.outcome === "refused")).toHaveLength(2);
    expect(r.items.some((i) => i.reason === "rate_limited")).toBe(true);
    expect(r.batchState).toBe("partial");
  });
});
