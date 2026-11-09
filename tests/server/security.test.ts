/**
 * Regression tests for the security review (PoCs in the orchestrator's
 * scratchpad: poc-forge.mts, poc-http.mts, poc-toctou.mts). Each PoC is
 * ported and must now FAIL to exploit.
 */
import { createHmac } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserAuthHandlers } from "../../server/api/browser-auth";
import { apsProxyAllowed, guardLocalRequest } from "../../server/api/dev-guards";
import { createCoordApi } from "../../server/api/router";
import { applyApproved, approvalOptions, approveBatch, batchPayloadHash, batchProposalIds, includedItems, verifyBatchApproval } from "../../server/approval";
import { loadConfig } from "../../server/config";
import type { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { dpapiProtect, dpapiUnprotect, secureDir } from "../../server/secure/keystore";
import { withFileLock } from "../../server/store/fs";
import { canonicalJson } from "../../server/util";
import { SoftAuthenticator } from "./authenticator";
import { acceptGroups, approveWithPasskey, enrollPasskey, HUMAN, ingest, makeCoord, makeLiveLike, MODEL_SET_ID, tempHome, testConfig, TEST_V42 } from "./helpers";

let home: string;
let cleanup: () => void;
beforeEach(() => ({ home, cleanup } = tempHome()));
afterEach(() => cleanup());

const actor = { type: "agent" as const, id: "a", name: "agente" };

/** Spy on ACC writes. */
function spyWriter(coord: Coordinator): string[] {
  const calls: string[] = [];
  const w = coord.source.writer;
  const close = w.close.bind(w);
  const assign = w.assign.bind(w);
  w.close = async (...a: Parameters<typeof close>) => (calls.push("close"), close(...a));
  w.assign = async (...a: Parameters<typeof assign>) => (calls.push(`assign:${(a[3] as Array<{ title: string }>).map((g) => g.title).join("|")}`), assign(...a));
  return calls;
}

async function readyBatch(coord: Coordinator, kinds: { close?: number; issue?: number } = { close: 2, issue: 1 }) {
  const ui = new CoordinatorUi(coord);
  const key = await ingest(coord, 42);
  const views = (await ui.proposals(key, undefined, 1000)).items;
  const close = views.filter((v) => v.fields.action.value.setStatus === "closed" && !v.fields.action.value.createIssue).slice(0, kinds.close ?? 0);
  const issue = views.filter((v) => v.fields.action.value.createIssue).slice(0, kinds.issue ?? 0);
  await acceptGroups(ui, key, [...close, ...issue].map((v) => v.targetId));
  const b = await ui.sendToApproval({ projectId: "demo-proyecto", modelSetId: MODEL_SET_ID, testId: key }, HUMAN);
  return { ui, testKey: key, batch: b };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("F1 approval = proof of human presence (poc-forge)", () => {
  it("PoC forge: an HMAC-valid approval forged with the stolen key is refused and nothing is written", async () => {
    const coord = makeLiveLike(home);
    const calls = spyWriter(coord);
    const { batch: b } = await readyBatch(coord);
    // A genuine approval elsewhere created the key; the attacker reads it with plain fs.
    const auth = new SoftAuthenticator();
    await enrollPasskey(coord, auth);
    const keyFile = JSON.parse(await readFile(join(coord.secureDir, "approval-key.json"), "utf8")) as { data: string };
    const key = Buffer.from(keyFile.data, "base64");
    const batchFile = coord.store.path("batches", `${b.id}.json`);
    const batch = JSON.parse(await readFile(batchFile, "utf8"));
    batch.state = "approved";
    await writeFile(batchFile, JSON.stringify(batch));
    const now = Date.now();
    const unsigned = {
      batchId: b.id, projectId: batch.projectId, modelSetId: batch.modelSetId, testId: batch.testId, testKey: batch.testKey, testVersion: batch.modelSetVersion,
      proposalIds: batchProposalIds(batch), itemIds: includedItems(batch).map((i) => i.id).sort(), payloadHash: batchPayloadHash(batch),
      approvedBy: { id: HUMAN.id, name: HUMAN.name, channel: "web-ui" }, approvedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(),
      nonce: "00", dataSource: "fixtures", demo: true,
    };
    const hmac = createHmac("sha256", key).update(canonicalJson({ ...unsigned, v: 2 })).digest("hex");
    await mkdir(coord.store.path("approvals"), { recursive: true });
    await writeFile(coord.store.path("approvals", `${b.id}.json`), JSON.stringify({ ...unsigned, hmac }));
    // The attacker even appends a matching audit event through the store API.
    await coord.store.audit({ actor, action: "batch.approved", batchId: b.id, details: { payloadHash: unsigned.payloadHash } });

    const v = await verifyBatchApproval(coord.approvalDeps(), b.id);
    expect(v).toMatchObject({ ok: false, reason: "demo_approval_not_allowed" });
    await applyApproved(coord.approvalDeps(), b.id, { actor });
    const r = await applyApproved(coord.approvalDeps(), b.id, { dryRun: false, actor });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("PoC forge+: a key holder who edits the batch and re-signs the record is stopped by WebAuthn re-verification", async () => {
    const coord = makeLiveLike(home);
    const calls = spyWriter(coord);
    const { batch: b } = await readyBatch(coord);
    const auth = new SoftAuthenticator();
    await enrollPasskey(coord, auth);
    await approveWithPasskey(coord, b.id, auth);
    expect((await verifyBatchApproval(coord.approvalDeps(), b.id)).ok).toBe(true);

    // Attacker: edit an ACC body, recompute payloadHash, re-sign with the stolen key.
    const key = Buffer.from((JSON.parse(await readFile(join(coord.secureDir, "approval-key.json"), "utf8")) as { data: string }).data, "base64");
    const rec = (await coord.store.getBatch(b.id))!;
    // (in live mode issue items stay excluded without configured issue types, so edit an included close item)
    const item = rec.items.find((i) => i.mcOperation === "clash.close" && !i.excluded)!;
    (item.accNew as { title: string }).title = "EDITADO POR ATACANTE";
    await coord.store.putBatch(rec);
    const appr = (await coord.store.getApproval(b.id))!;
    const { hmac: _old, ...rest } = appr;
    void _old;
    const forged = { ...rest, payloadHash: batchPayloadHash(rec) };
    await writeFile(coord.store.path("approvals", `${b.id}.json`), JSON.stringify({ ...forged, hmac: createHmac("sha256", key).update(canonicalJson({ ...forged, v: 2 })).digest("hex") }));

    expect(await verifyBatchApproval(coord.approvalDeps(), b.id)).toMatchObject({ ok: false, reason: "webauthn_invalid" });
    const r = await applyApproved(coord.approvalDeps(), b.id, { dryRun: false, actor });
    expect(r.refused?.reason).toBe("webauthn_invalid");
    expect(calls).toEqual([]);
  });

  it("an assertion from an unregistered authenticator is refused", async () => {
    const coord = makeLiveLike(home);
    const { batch: b } = await readyBatch(coord);
    await enrollPasskey(coord, new SoftAuthenticator());
    await expect(approveWithPasskey(coord, b.id, new SoftAuthenticator())).rejects.toThrow(/no registrada/);
  });

  it("user verification is required, the challenge is single use and origin-bound", async () => {
    const coord = makeLiveLike(home);
    const { batch: b } = await readyBatch(coord);
    const auth = new SoftAuthenticator();
    await enrollPasskey(coord, auth);
    await expect(approveWithPasskey(coord, b.id, auth, { userVerified: false })).rejects.toThrow(/inválida|verific/);
    const o = await approvalOptions(coord.approvalDeps(), b.id);
    const resp = auth.assert(o.options);
    await expect(approveBatch(coord.approvalDeps(), b.id, { ...HUMAN, channel: "web-ui" }, { webauthn: { nonce: o.nonce, origin: "http://evil.example", response: resp as never } })).rejects.toThrow(/Origen/);
    // Wrong-origin attempt did not consume; a valid one does, and a replay fails.
    await approveBatch(coord.approvalDeps(), b.id, { ...HUMAN, channel: "web-ui" }, { webauthn: { nonce: o.nonce, origin: auth.origin, response: resp as never } });
    const b2 = (await coord.store.getBatch(b.id))!;
    expect(b2.state).toBe("approved");
    const a = (await coord.store.getApproval(b.id))!;
    expect(a.webauthn?.credentialId).toBe(auth.id);
    await expect(coord.webauthn.verifyApproval({ batchId: b.id, payloadHash: a.payloadHash, testVersion: a.testVersion, nonce: o.nonce, origin: auth.origin, response: resp as never })).rejects.toThrow(/usado o vencido/);
  });

  it("the live source refuses demo approvals; the challenge is bound to the exact payload", async () => {
    const coord = makeLiveLike(home);
    const { batch: b } = await readyBatch(coord);
    await expect(approveBatch(coord.approvalDeps(), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true })).rejects.toThrow(/passkey/);
    const auth = new SoftAuthenticator();
    await enrollPasskey(coord, auth);
    const o = await approvalOptions(coord.approvalDeps(), b.id);
    const resp = auth.assert(o.options);
    // The coordinator excludes an item after the challenge was issued → payload differs → refused.
    const ex = b.items.find((i) => !i.excluded)!.id;
    await expect(approveBatch(coord.approvalDeps(), b.id, { ...HUMAN, channel: "web-ui" }, { excludedItemIds: [ex], webauthn: { nonce: o.nonce, origin: auth.origin, response: resp as never } })).rejects.toThrow(/cambió/);
  });

  it("enrolment: one-time code for the first passkey, step-up for more, tampered credential list rejected", async () => {
    const coord = makeLiveLike(home);
    const a1 = new SoftAuthenticator();
    const { code } = await coord.webauthn.createEnrollCode();
    const o1 = await coord.webauthn.registrationOptions(HUMAN.name);
    expect(o1.requires).toBe("enroll_code");
    await expect(coord.webauthn.register({ origin: a1.origin, response: a1.register(o1.registration) as never, enrollCode: "WRONGCODE1" })).rejects.toThrow(/inválido/);
    // the code was consumed by the failed attempt (single use)
    const o1b = await coord.webauthn.registrationOptions(HUMAN.name);
    await expect(coord.webauthn.register({ origin: a1.origin, response: a1.register(o1b.registration) as never, enrollCode: code })).rejects.toThrow(/inválido/);
    await enrollPasskey(coord, a1);
    await expect(coord.webauthn.createEnrollCode()).rejects.toThrow(/Ya hay passkeys/);

    const a2 = new SoftAuthenticator();
    const o2 = await coord.webauthn.registrationOptions(HUMAN.name);
    expect(o2.requires).toBe("step_up");
    await expect(coord.webauthn.register({ origin: a2.origin, response: a2.register(o2.registration) as never })).rejects.toThrow(/passkey existente/);
    const o3 = await coord.webauthn.registrationOptions(HUMAN.name);
    const c2 = await coord.webauthn.register({ origin: a2.origin, response: a2.register(o3.registration) as never, stepUp: a1.assert(o3.stepUp!) as never });
    expect(c2.enrolledVia).toBe("step-up");
    expect(await coord.webauthn.listCredentials()).toHaveLength(2);

    const file = join(coord.secureDir, "webauthn-credentials.json");
    const f = JSON.parse(await readFile(file, "utf8"));
    f.credentials.push({ ...f.credentials[0], id: "intruso" });
    await writeFile(file, JSON.stringify(f));
    await expect(coord.webauthn.listCredentials()).rejects.toThrow(/alterado/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F2 DNS rebinding and local clients (poc-http)", () => {
  let server: Server;
  let port: number;
  let coord: Coordinator;
  let calls: string[];

  beforeEach(async () => {
    coord = makeLiveLike(home);
    calls = spyWriter(coord);
    const api = createCoordApi({ coordinator: coord });
    server = createServer((rq, rs) => api.middleware(rq, rs));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  const doReq = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number; json: { token?: string; id?: string; error?: { code: string; message: string } } & Record<string, unknown> }>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const rq = httpRequest({ host: "127.0.0.1", port, method, path: "/api/coord" + path, headers: { ...(data ? { "Content-Type": "application/json" } : {}), ...headers } }, (rs) => {
        let s = "";
        rs.on("data", (c) => (s += c));
        rs.on("end", () => resolve({ status: rs.statusCode!, json: JSON.parse(s || "null") }));
      });
      rq.on("error", reject);
      if (data) rq.write(data);
      rq.end();
    });

  it("PoC rebinding: a foreign Host is refused before anything else (X-Forwarded-Host ignored)", async () => {
    const evil = { Host: `attacker.example:${port}` };
    expect((await doReq("GET", "/csrf", undefined, evil)).status).toBe(403);
    expect((await doReq("GET", "/projects", undefined, { ...evil, "X-Forwarded-Host": `127.0.0.1:${port}` })).status).toBe(403);
    expect((await doReq("POST", "/batches", {}, { ...evil, Origin: `http://attacker.example:${port}` })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("PoC local client: CSRF can be fetched, but approve(apply:true) is rejected and approval needs a passkey", async () => {
    const host = `127.0.0.1:${port}`;
    const c = await doReq("GET", "/csrf", undefined, { Host: host });
    const tok = c.json.token!;
    const hdr = { Host: host, Origin: `http://${host}`, "X-Coord-CSRF": tok, Cookie: `coord_csrf=${tok}` };
    const ing = await doReq("POST", `/projects/demo-proyecto/model-sets/${MODEL_SET_ID}/tests/${TEST_V42}/ingest`, { wait: true }, hdr);
    expect(ing.status).toBe(200);
    const key = (ing.json as { testKey: string }).testKey;
    const ui = new CoordinatorUi(coord);
    const views = (await ui.proposals(key, undefined, 1000)).items.filter((v) => v.fields.action.value.setStatus === "closed").slice(0, 2);
    await acceptGroups(ui, key, views.map((v) => v.targetId));
    const b = await doReq("POST", "/batches", { projectId: "demo-proyecto", modelSetId: MODEL_SET_ID, testId: key }, hdr);
    expect(b.status).toBe(200);
    const withApply = await doReq("POST", `/batches/${b.json.id}/approve`, { confirmWord: "APLICAR", apply: true, excludedItemIds: [] }, hdr);
    expect(withApply.status).toBe(400);
    const demo = await doReq("POST", `/batches/${b.json.id}/approve`, { confirmWord: "APLICAR", demo: true, excludedItemIds: [] }, hdr);
    expect(demo.status).toBe(403);
    const plain = await doReq("POST", `/batches/${b.json.id}/approve`, { confirmWord: "APLICAR", excludedItemIds: [] }, hdr);
    expect(plain.status).toBe(403);
    expect(plain.json.error?.code).toBe("approval_missing");
    const apply = await doReq("POST", `/batches/${b.json.id}/apply`, { dryRun: false }, hdr);
    expect((apply.json as { ok: boolean }).ok).toBe(false);
    expect(calls).toEqual([]);
    expect((await coord.store.listAudit()).some((e) => e.action === "batch.approved")).toBe(false);
  });

  it("mutations need an exact Origin (Referer is not enough); cross-site fetch metadata is refused", async () => {
    const host = `127.0.0.1:${port}`;
    const c = await doReq("GET", "/csrf", undefined, { Host: host });
    const tok = c.json.token!;
    const base = { Host: host, "X-Coord-CSRF": tok, Cookie: `coord_csrf=${tok}` };
    expect((await doReq("POST", "/triage/decisions", [], { ...base, Referer: `http://${host}/x` })).status).toBe(403);
    expect((await doReq("POST", "/triage/decisions", [], { ...base, Origin: `http://localhost:${port}` })).status).toBe(403);
    expect((await doReq("GET", "/csrf", undefined, { Host: host, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await doReq("POST", "/triage/decisions", [], { ...base, Origin: `http://${host}` })).status).toBe(200);
  });

  it("validates humanValue per field and strict GET enums", async () => {
    const host = `127.0.0.1:${port}`;
    const tok = (await doReq("GET", "/csrf", undefined, { Host: host })).json.token!;
    const hdr = { Host: host, Origin: `http://${host}`, "X-Coord-CSRF": tok, Cookie: `coord_csrf=${tok}` };
    const d = (field: string, humanValue: unknown) => [{ id: `dec-${field}-xxxx`, proposalId: "P-1", targetType: "group", targetId: "G-1", testId: "T-00000000", modelSetId: "m", projectId: "p", kind: "correct", reasonCode: "R99", note: "n", changes: [{ field, aiValue: null, humanValue }], viewedInViewerMs: 0, decidedAt: "x" }];
    expect((await doReq("POST", "/triage/decisions", d("issueDraft", { title: "x".repeat(101) }), hdr)).status).toBe(400);
    expect((await doReq("POST", "/triage/decisions", d("issueDraft", { dueDate: "mañana" }), hdr)).status).toBe(400);
    expect((await doReq("POST", "/triage/decisions", d("action", { createIssue: true, setStatus: "deleted" }), hdr)).status).toBe(400);
    expect((await doReq("POST", "/triage/decisions", d("validity", "duplicate"), hdr)).status).toBe(400);
    expect((await doReq("GET", "/tests/T-00000000/groups?validity=bogus", undefined, { Host: host })).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F3 TOCTOU (poc-toctou)", () => {
  it("PoC: an apply waiting for the lock never sends a batch edited after approval", async () => {
    const coord = makeCoord(home);
    const { ui, batch: b } = await readyBatch(coord, { issue: 2 });
    await approveBatch(coord.approvalDeps(), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    await applyApproved(coord.approvalDeps(), b.id, { actor }); // dry run (required)
    const calls = spyWriter(coord);
    const lock = coord.store.path("state", "apply.lock");
    await mkdir(join(lock, ".."), { recursive: true });
    await writeFile(lock, JSON.stringify({ pid: 99999, nonce: "other", at: Date.now() })); // another process holds the batch lock
    const applyP = applyApproved(coord.approvalDeps(), b.id, { dryRun: false, actor: { type: "user", id: "x", name: "x" } });
    const editP = (async () => {
      await ui.returnToReview(b.id, HUMAN);
      const item = (await coord.store.getBatch(b.id))!.items.find((i) => i.mcOperation === "clash.assign" && !i.excluded)!;
      await ui.updateIssue(b.id, item.id, { title: "EDITED AFTER APPROVAL - NOT APPROVED" });
    })().catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 300));
    await rm(lock);
    const [r] = await Promise.all([applyP, editP]);
    expect(calls.join(" ")).not.toContain("EDITED AFTER APPROVAL");
    if (r.ok) expect((await coord.store.getBatch(b.id))!.state).toBe("applied");
    else expect((await coord.store.getBatch(b.id))!.items.some((i) => (i.accNew as { title?: string }).title?.startsWith("EDITED"))).toBe(true);
  });

  it("an approved batch cannot be edited in place; returning it deletes the approval", async () => {
    const coord = makeCoord(home);
    const { ui, batch: b } = await readyBatch(coord);
    await approveBatch(coord.approvalDeps(), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    await expect(ui.setItemsExcluded(b.id, [b.items[0]!.id], true)).rejects.toThrow(/devuélvelo/);
    await ui.returnToReview(b.id, HUMAN);
    expect(await coord.store.getApproval(b.id)).toBeUndefined();
    expect((await applyApproved(coord.approvalDeps(), b.id, { actor })).refused?.reason).toBe("not_approved");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F4 key location, audit binding", () => {
  it("secrets live outside the repository unless an explicit home is chosen", () => {
    expect(secureDir({ env: { APPDATA: "C:\\Users\\x\\AppData\\Roaming" } as NodeJS.ProcessEnv })).toMatch(process.platform === "win32" ? /Roaming[\\/]bim-coordinator$/ : /bim-coordinator$/);
    expect(secureDir({ env: { XDG_CONFIG_HOME: "/home/x/.config" } as NodeJS.ProcessEnv })).toMatch(/bim-coordinator$/);
    expect(secureDir({ env: { COORD_SECURE_DIR: "/tmp/sec" } as NodeJS.ProcessEnv })).toMatch(/sec$/);
    expect(secureDir({ homeOverride: "/tmp/h", env: {} as NodeJS.ProcessEnv })).toMatch(/h[\\/]secret$/);
  });

  it.runIf(process.platform === "win32")("DPAPI round trip (Windows)", () => {
    const secret = Buffer.from("clave-de-prueba");
    const blob = dpapiProtect(secret);
    expect(blob.equals(secret)).toBe(false);
    expect(dpapiUnprotect(blob).equals(secret)).toBe(true);
  }, 30_000);

  it("apply requires the matching batch.approved event in an intact HMAC-chained audit log", async () => {
    const coord = makeCoord(home);
    const { batch: b } = await readyBatch(coord);
    await approveBatch(coord.approvalDeps(), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    expect((await verifyBatchApproval(coord.approvalDeps(), b.id)).ok).toBe(true);
    const file = coord.store.path("audit", "audit.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n").filter((l) => !l.includes('"batch.approved"'));
    // Attacker drops the event and re-chains with plain SHA-256 (does not have the audit key).
    const { createHash } = await import("node:crypto");
    let prev = "0".repeat(64);
    const rechained = lines.map((l) => {
      const { hash: _h, ...body } = JSON.parse(l);
      void _h;
      body.prevHash = prev;
      const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v);
      const { prevHash, ...rest } = body;
      prev = createHash("sha256").update(prevHash + JSON.stringify(sortKeys(rest))).digest("hex");
      return JSON.stringify({ ...body, hash: prev });
    });
    await writeFile(file, rechained.join("\n") + "\n");
    expect((await coord.store.verifyAudit()).ok).toBe(false);
    expect(await verifyBatchApproval(coord.approvalDeps(), b.id)).toMatchObject({ ok: false, reason: "audit_missing" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F6 double apply and lock hygiene", () => {
  it("a timeout after the POST is reconciled against ACC instead of being resent", async () => {
    const coord = makeCoord(home);
    const { batch: b } = await readyBatch(coord, { close: 2 });
    await approveBatch(coord.approvalDeps(), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    await applyApproved(coord.approvalDeps(), b.id, { actor });
    const w = coord.source.writer;
    const orig = w.close.bind(w);
    let sends = 0;
    w.close = async (...a: Parameters<typeof orig>) => {
      sends++;
      await orig(...a); // reaches ACC…
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); // …but the response is lost
    };
    const r1 = await applyApproved(coord.approvalDeps(), b.id, { dryRun: false, actor });
    expect(r1.requests[0]!.outcome).toBe("unknown");
    w.close = orig;
    const r2 = await applyApproved(coord.approvalDeps(), b.id, { dryRun: false, actor });
    expect(r2.requests[0]!.outcome).toBe("reconciled");
    expect(sends).toBe(1);
    expect(r2.batchState).toBe("applied");
  });

  it("a POST that never reached ACC is resent exactly once after reconciliation", async () => {
    const coord = makeCoord(home);
    const { batch: b } = await readyBatch(coord, { close: 1 });
    await approveBatch(coord.approvalDeps(), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    await applyApproved(coord.approvalDeps(), b.id, { actor });
    const w = coord.source.writer;
    const orig = w.close.bind(w);
    w.close = async () => {
      throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    };
    expect((await applyApproved(coord.approvalDeps(), b.id, { dryRun: false, actor })).requests[0]!.outcome).toBe("unknown");
    w.close = orig;
    const r = await applyApproved(coord.approvalDeps(), b.id, { dryRun: false, actor });
    expect(r.requests[0]!.outcome).toBe("applied");
    expect(await (coord.source as unknown as { writes(): Promise<unknown[]> }).writes()).toHaveLength(1);
  });

  it("the lock is released only by its owner (pid + nonce) and heartbeats while held", async () => {
    const lock = join(home, "t.lock");
    let mtimeDuring = 0;
    await withFileLock(
      lock,
      async () => {
        const m0 = (await stat(lock)).mtimeMs;
        await new Promise((r) => setTimeout(r, 700));
        mtimeDuring = (await stat(lock)).mtimeMs - m0;
        await writeFile(lock, JSON.stringify({ pid: 1, nonce: "someone-else" })); // taken over by another holder
      },
      { staleMs: 600 },
    );
    expect(mtimeDuring).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(lock, "utf8")).nonce).toBe("someone-else");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F8 low-severity hardening", () => {
  it("requireDryRunBeforeApply: a real apply without a prior dry run of the same payload is refused", async () => {
    const coord = makeCoord(home);
    const { batch: b } = await readyBatch(coord);
    await approveBatch(coord.approvalDeps(), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true });
    expect((await applyApproved(coord.approvalDeps(), b.id, { dryRun: false, actor })).refused?.reason).toBe("dry_run_required");
  });

  it("approve does not touch exclusions when the version is stale", async () => {
    const coord = makeCoord(home);
    const { batch: b } = await readyBatch(coord);
    (coord.source as unknown as { latestVersion: () => Promise<number> }).latestVersion = async () => 43;
    const ex = b.items.find((i) => !i.excluded)!.id;
    await expect(approveBatch(coord.approvalDeps(), b.id, { ...HUMAN, channel: "web-ui" }, { demo: true, excludedItemIds: [ex] })).rejects.toThrow(/v43/);
    expect((await coord.store.getBatch(b.id))!.items.find((i) => i.id === ex)!.excluded).toBe(false);
  });

  it("autonomy level = min(base, local)", async () => {
    await writeFile(join(home, "coordinator.config.json"), JSON.stringify({ autonomy: { level: 0 } }));
    await writeFile(join(home, "coordinator.config.local.json"), JSON.stringify({ autonomy: { level: 3 } }));
    expect(loadConfig(home, {}).configuredLevel).toBe(0);
    void testConfig;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F5 dev server guards and browser token handling", () => {
  const req = (url: string, headers: Record<string, string>, method = "GET") => ({ url, method, headers, socket: { localPort: 3000 } }) as never;

  it("guards /api/coord, /api/auth and /api/aps by exact Host", () => {
    expect(guardLocalRequest(req("/api/aps/project/v1/hubs", { host: "evil.example:3000" }))).toMatch(/Host/);
    expect(guardLocalRequest(req("/api/auth/refresh", { host: "localhost:3000" }, "POST"))).toMatch(/Origen/);
    expect(guardLocalRequest(req("/api/auth/refresh", { host: "localhost:3000", origin: "http://localhost:3000" }, "POST"))).toBeUndefined();
    expect(guardLocalRequest(req("/src/main.tsx", { host: "evil.example:3000" }))).toBeUndefined();
  });

  it("the APS proxy is GET-only and allowlisted", () => {
    expect(apsProxyAllowed("GET", "/api/aps/project/v1/hubs")).toBe(true);
    expect(apsProxyAllowed("GET", "/api/aps/modelderivative/v2/designdata/abc/manifest")).toBe(true);
    expect(apsProxyAllowed("POST", "/api/aps/project/v1/hubs")).toBe(false);
    expect(apsProxyAllowed("GET", "/api/aps/bim360/clash/v3/containers/p/tests/t/clashes:assign")).toBe(false);
    expect(apsProxyAllowed("GET", "/api/aps/project/v1/../../construction/issues/v1")).toBe(false);
    expect(apsProxyAllowed("GET", "/api/aps/authentication/v2/token")).toBe(false);
  });

  it("/api/auth keeps refresh tokens server-side, ignores client refresh tokens and downscopes", async () => {
    const sent: URLSearchParams[] = [];
    let n = 0;
    const fakeFetch = (async (_u: string, init: RequestInit) => {
      const p = new URLSearchParams(String(init.body));
      sent.push(p);
      n++;
      return new Response(JSON.stringify({ access_token: `at${n}`, refresh_token: `rt${n}`, token_type: "Bearer", expires_in: 3599, scope: p.get("scope") ?? "data:read data:write" }), { status: 200 });
    }) as unknown as typeof fetch;
    const tokenFile = join(home, "secret", "browser-session.json");
    const h = createBrowserAuthHandlers({ clientId: "cid", clientSecret: "sec", callbackUrl: "http://localhost:3000/auth/callback", tokenFile, fetch: fakeFetch });
    const call = async (fn: typeof h.callback, body: string) => {
      const { Readable } = await import("node:stream");
      const rq = Object.assign(Readable.from([Buffer.from(body)]), { method: "POST", headers: {} });
      let status = 0;
      let out = "";
      const rs = { writeHead: (s: number) => (status = s), end: (b: string) => (out = b) };
      await fn(rq as never, rs as never);
      return { status, json: JSON.parse(out) };
    };
    const cb = await call(h.callback, "code=abc");
    expect(cb.status).toBe(200);
    expect(cb.json.refresh_token).toBeUndefined();
    expect(cb.json.access_token).toBe("at2"); // the downscoped one
    expect(sent[1]!.get("grant_type")).toBe("refresh_token");
    expect(sent[1]!.get("scope")).toBe("data:read viewables:read");
    const rf = await call(h.refresh, "refresh_token=CLIENT-SUPPLIED");
    expect(rf.status).toBe(200);
    expect(rf.json.refresh_token).toBeUndefined();
    expect(sent[2]!.get("refresh_token")).toBe("rt2"); // server-held, not the client's
    expect(JSON.stringify(sent.map((s) => s.toString()))).not.toContain("CLIENT-SUPPLIED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F7 model and ACC text reaches MCP outputs only as Untrusted", () => {
  it("names, categories and levels are wrapped", async () => {
    const coord = makeCoord(home);
    await coord.setActiveContext({ projectId: "demo-proyecto", modelSetId: MODEL_SET_ID });
    const tests = await coord.listClashTests({});
    expect(tests.rows[0]![1]).toHaveProperty("untrusted");
    const projects = await coord.listProjects({ limit: 5 });
    expect(projects.rows[0]![1]).toHaveProperty("untrusted");
    await ingest(coord, 42);
    const clashes = await coord.listClashes({ limit: 3 });
    expect(clashes.rows[0]![6]).toHaveProperty("untrusted");
    expect(clashes.rows[0]![9]).toHaveProperty("untrusted");
    const s = await coord.summarize({ groupBy: ["level"], unit: "clashes", topN: 3 });
    expect(s.rows[0]![0]).toHaveProperty("untrusted");
    const st = await coord.sessionStatus();
    expect(st.active?.projectName).toHaveProperty("untrusted");
  });
});
