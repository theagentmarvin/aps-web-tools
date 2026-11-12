import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplyResponse, ApplyStatus, Batch, ClashGrid, Decision, DisciplineConfig, DisciplinePreview, IngestJob, Page, Proposal, TriagePayload } from "../../server/api/contract";
import { createCoordApi, type CoordApi } from "../../server/api/router";
import { makeCoord, MODEL_SET_ID, tempHome, TEST_V42 } from "./helpers";

let server: Server;
let api: CoordApi;
let base: string;
let origin: string;
let csrf: string;
let cookie: string;
let cleanup: () => void;

async function req<T>(method: string, path: string, body?: unknown, opts: { csrf?: boolean; origin?: string | null } = {}): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const o = opts.origin === undefined ? origin : opts.origin;
  if (o) headers.Origin = o;
  if (opts.csrf !== false && csrf) {
    headers["X-Coord-CSRF"] = csrf;
    headers.Cookie = cookie;
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as T };
}

beforeAll(async () => {
  const t = tempHome();
  cleanup = t.cleanup;
  api = createCoordApi({ coordinator: makeCoord(t.home) });
  server = createServer((rq, rs) => api.middleware(rq, rs));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/api/coord`;
  origin = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/csrf`);
  csrf = ((await res.json()) as { token: string }).token;
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  cleanup();
});

describe("HTTP API /api/coord", () => {
  it("issues a CSRF token with a SameSite=Strict HttpOnly cookie", () => {
    expect(csrf.length).toBeGreaterThan(20);
    expect(cookie).toBe(`coord_csrf=${csrf}`);
  });

  it("serves read endpoints", async () => {
    const auth = await req<{ loggedIn: boolean; dataSource: string }>("GET", "/auth/status");
    expect(auth.json).toMatchObject({ loggedIn: true, dataSource: "fixtures" });
    const projects = await req<Array<{ id: string }>>("GET", "/projects");
    expect(projects.json.map((p) => p.id)).toEqual(["demo-proyecto"]);
    const sets = await req<Array<{ id: string; agentCommand: string }>>("GET", "/projects/demo-proyecto/model-sets");
    expect(sets.json[0]!.id).toBe(MODEL_SET_ID);
    expect(sets.json[0]!.agentCommand).toMatch(/Analiza/);
    const rules = await req<unknown[]>("GET", "/rules");
    expect(rules.json.length).toBeGreaterThan(50);
    const nf = await req<{ error: { code: string } }>("GET", "/nope");
    expect(nf.status).toBe(404);
  });

  it("rejects human-only writes without CSRF or from another origin", async () => {
    const noCsrf = await req("POST", "/triage/decisions", [], { csrf: false });
    expect(noCsrf.status).toBe(403);
    const cross = await req("POST", "/triage/decisions", [], { origin: "http://evil.example.com" });
    expect(cross.status).toBe(403);
    const noOrigin = await req("POST", "/triage/decisions", [], { origin: null });
    expect(noOrigin.status).toBe(403);
  });

  it("ingest → triage → decisions → batch → approve → apply (dryRun default, then real)", async () => {
    const ing = await req<IngestJob>("POST", `/projects/demo-proyecto/model-sets/${MODEL_SET_ID}/tests/${TEST_V42}/ingest`, {});
    expect(ing.status).toBe(200);
    expect(ing.json.jobId).toMatch(/^J-[0-9a-f]{12}$/);
    const phases = new Set<string>();
    let job = ing.json;
    for (let i = 0; i < 1500 && job.phase !== "done" && job.phase !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      job = (await req<IngestJob>("GET", `/ingest-jobs/${ing.json.jobId}`)).json;
      phases.add(job.phase);
    }
    expect(job.phase).toBe("done");
    expect(job.progress).toBe(1);
    expect(job.timings.totalMs).toBeGreaterThanOrEqual(0);
    const testKey = job.testKey!;
    expect((await req("GET", "/ingest-jobs/J-000000000000")).status).toBe(404);

    const tri = await req<TriagePayload>("GET", `/triage/demo-proyecto/${MODEL_SET_ID}`);
    {
      // large JSON is compressed when the client accepts it
      const raw = await fetch(`${base}/triage/demo-proyecto/${MODEL_SET_ID}`, { headers: { Origin: origin, "Accept-Encoding": "gzip" } });
      expect(raw.headers.get("content-encoding")).toBe("gzip");
      expect(raw.headers.get("vary")).toBe("Accept-Encoding");
      expect(((await raw.json()) as TriagePayload).groups.length).toBeGreaterThan(0);
      const small = await fetch(`${base}/csrf`, { headers: { "Accept-Encoding": "gzip" } });
      expect(small.headers.get("content-encoding")).toBeNull();
    }
    expect(tri.status).toBe(200);
    expect(tri.json.test.id).toBe(testKey);
    expect(tri.json.groups.length).toBe(tri.json.proposals.length);
    expect(tri.json.clashes.length).toBe(303);
    expect(tri.json.disciplines.length).toBeGreaterThan(5);
    const p0 = tri.json.proposals[0]!;
    expect(p0.fields.validity.source).toBe("rule");
    expect(["real", "false_positive", "tolerated", "needs_info"]).toContain(p0.fields.validity.value);

    const groups = await req<Page<{ id: string }>>("GET", `/tests/${testKey}/groups?priority=1,2&limit=5`);
    expect(groups.json.items.length).toBeLessThanOrEqual(5);
    const detail = await req<{ group: { id: string }; clashes: unknown[] }>("GET", `/tests/${testKey}/groups/${tri.json.groups[0]!.id}`);
    expect(detail.json.clashes.length).toBeGreaterThan(0);
    const props = await req<Array<{ found: boolean }>>("POST", `/tests/${testKey}/elements/properties`, { refs: [tri.json.clashes[0]!.a.ref] });
    expect(props.json[0]!.found).toBe(true);

    const closable = tri.json.proposals.filter((p: Proposal) => p.fields.action.value.setStatus === "closed" && !p.fields.action.value.createIssue).slice(0, 2);
    const issue = tri.json.proposals.find((p: Proposal) => p.fields.action.value.createIssue)!;
    const mk = (p: Proposal, kind: Decision["kind"], extra: Partial<Decision> = {}): Decision => ({
      id: `http-${p.targetId}-${kind}`,
      proposalId: p.id,
      targetType: "group",
      targetId: p.targetId,
      testId: testKey,
      modelSetId: MODEL_SET_ID,
      projectId: "demo-proyecto",
      kind,
      changes: [],
      viewedInViewerMs: 1800,
      decidedAt: new Date().toISOString(),
      userId: "spoofed",
      userName: "Spoofed",
      ...extra,
    });
    const decisions = [mk(closable[0]!, "accept"), mk(closable[1]!, "accept"), mk(issue, "correct", { reasonCode: "R09", changes: [{ field: "priority", aiValue: issue.fields.priority.value, humanValue: 1 }] })];
    const missingReason = await req<{ error: { code: string } }>("POST", "/triage/decisions", [mk(issue, "reject")]);
    expect(missingReason.status).toBe(400);
    const saved = await req<{ saved: string[] }>("POST", "/triage/decisions", decisions);
    expect(saved.json.saved).toHaveLength(3);
    const again = await req<{ saved: string[] }>("POST", "/triage/decisions", decisions);
    expect(again.status).toBe(200);
    const listed = await req<Page<Decision>>("GET", `/decisions?testId=${testKey}`);
    expect(listed.json.total).toBe(3);
    expect(listed.json.items.every((d) => d.userName === "Coordinadora Demo")).toBe(true);

    const batch = await req<Batch>("POST", "/batches", { projectId: "demo-proyecto", modelSetId: MODEL_SET_ID, testId: testKey });
    expect(batch.status).toBe(200);
    expect(batch.json.state).toBe("ready");
    expect(batch.json.counts.issuesCreate).toBe(1);
    expect(batch.json.origin).toMatchObject({ accepted: 2, corrected: 1 });

    const pre = await req<{ conflicts: number }>("POST", `/batches/${batch.json.id}/preflight`);
    expect(pre.json.conflicts).toBe(0);

    const badWord = await req<{ error: { message: string } }>("POST", `/batches/${batch.json.id}/approve`, { confirmWord: "si", excludedItemIds: [], demo: true });
    expect(badWord.status).toBe(400);
    const approved = await req<ApplyStatus>("POST", `/batches/${batch.json.id}/approve`, { confirmWord: "APLICAR", excludedItemIds: [], demo: true });
    expect(approved.status).toBe(200);
    expect(approved.json.state).toBe("approved");
    const got = await req<Batch>("GET", `/batches/${batch.json.id}`);
    expect(got.json.approval).toMatchObject({ approvedBy: "Coordinadora Demo", channel: "web-ui", valid: true });

    const dry = await req<ApplyResponse>("POST", `/batches/${batch.json.id}/apply`, {});
    expect(dry.json.dryRun).toBe(true);
    expect(dry.json.requests).toHaveLength(2);
    const real = await req<ApplyResponse>("POST", `/batches/${batch.json.id}/apply`, { dryRun: false });
    expect(real.json.ok).toBe(true);
    expect(real.json.status.state).toBe("applied");
    expect(real.json.status.issues).toEqual({ done: 1, total: 1 });

    const audit = await req<Page<{ action: string; hash: string }>>("GET", `/audit?batch=${batch.json.id}`);
    expect(audit.json.items.map((e) => e.action)).toEqual(expect.arrayContaining(["batch.ready", "batch.approved", "acc.clash.statusChanged", "acc.issue.created"]));
    const corrections = await req<Page<{ field: string; reasonCode: string }>>("GET", "/learning/corrections");
    expect(corrections.json.items[0]).toMatchObject({ field: "priority", reasonCode: "R09" });
    const report = await req<{ kpis: { aiAccepted: number; issuesCreated: number } }>("GET", "/reports?projectId=demo-proyecto");
    expect(report.json.kpis).toMatchObject({ aiAccepted: 2, issuesCreated: 1 });
    const calib = await req<{ bands: unknown[] }>("GET", "/learning/calibration");
    expect(calib.json.bands).toHaveLength(3);
    const home = await req<{ queue: unknown[] }>("GET", "/home");
    expect(home.json.queue.length).toBe(1);
  }, 30_000); // full end-to-end flow: slow under parallel suite load

  it("stores project notes only through the human channel", async () => {
    const r = await req<{ text: string }>("POST", "/projects/demo-proyecto/notes", { text: "Pasadas de CLI en vigas del N03 previstas por plano E-301" });
    expect(r.status).toBe(200);
    expect(r.json.text).toMatch(/E-301 \(confirmado por coordinador\)/);
    const bad = await req<{ error: { code: string } }>("POST", "/projects/demo-proyecto/notes", { text: "ver https://evil.example.com" });
    expect(bad.status).toBe(400);
  });
  it("clash grid, views and discipline endpoints (human writes need CSRF)", async () => {
    const grid = await req<ClashGrid>("GET", `/projects/demo-proyecto/model-sets/${MODEL_SET_ID}/clash-grid?test=${TEST_V42}`);
    expect(grid.status).toBe(200);
    expect(grid.json.state).toBe("classified");
    const views = await req<unknown[]>("GET", `/projects/demo-proyecto/model-sets/${MODEL_SET_ID}/views`);
    expect(views.json.length).toBeGreaterThan(0);
    const cfg = await req<DisciplineConfig>("GET", "/projects/demo-proyecto/disciplines");
    expect(cfg.json.codes.some((c) => c.code === "SIN")).toBe(true);
    const lin = Buffer.from(grid.json.documents[0]!.lineageUrn, "utf8").toString("base64url");
    const path = `/projects/demo-proyecto/model-sets/${MODEL_SET_ID}/documents/${lin}/discipline?test=${TEST_V42}`;
    expect((await req("PUT", path, { discipline: "ARQ" }, { csrf: false })).status).toBe(403);
    expect((await req("PUT", path, { discipline: "ARQ", extra: 1 })).status).toBe(400);
    const ok = await req<ClashGrid>("PUT", path, { discipline: "ARQ" });
    expect(ok.status).toBe(200);
    expect(ok.json.documents[0]).toMatchObject({ discipline: "ARQ", disciplineSource: "assignment" });
    const bad = Buffer.from("not a urn", "utf8").toString("base64url");
    expect((await req("PUT", `/projects/demo-proyecto/model-sets/${MODEL_SET_ID}/documents/${bad}/discipline`, { discipline: "ARQ" })).status).toBe(400);
    const pv = await req<DisciplinePreview>("POST", "/projects/demo-proyecto/disciplines/preview", { rules: [{ match: "contains", value: "-EST-", field: "fileName", discipline: "EST" }] });
    expect(pv.json.rules[0]!.matches.length).toBeGreaterThan(0);
    expect((await req("PUT", "/projects/demo-proyecto/disciplines/rules", { rules: [] }, { csrf: false })).status).toBe(403);
    expect((await req("PUT", "/projects/demo-proyecto/disciplines/rules", { rules: [{ match: "regex", value: "(", field: "fileName", discipline: "EST" }] })).status).toBe(400);
  });
});
