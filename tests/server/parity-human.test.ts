/**
 * Human-side parity routes (docs/ai/agent-human-parity.md #10, #31, #32, #62, #68, #70, #71):
 * what the agent sees through MCP is readable by the web UI, with no personal data.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FamiliesPayload, FeedbackRow, Page, ProjectNotes, ReportFile, ReportFileContent, TestHygiene } from "../../server/api/contract";
import { createCoordApi, type CoordApi } from "../../server/api/router";
import type { Coordinator } from "../../server/coordinator";
import { HUMAN, ingest, makeCoord, tempHome } from "./helpers";

let server: Server;
let api: CoordApi;
let coord: Coordinator;
let base: string;
let origin: string;
let csrf: string;
let cookie: string;
let cleanup: () => void;
let testKey: string;

async function req<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = { Origin: origin, "X-Coord-CSRF": csrf, Cookie: cookie };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as T };
}

beforeAll(async () => {
  const t = tempHome();
  cleanup = t.cleanup;
  coord = makeCoord(t.home);
  api = createCoordApi({ coordinator: coord });
  server = createServer((rq, rs) => api.middleware(rq, rs));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/api/coord`;
  origin = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/csrf`);
  csrf = ((await res.json()) as { token: string }).token;
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  testKey = await ingest(coord, 42);
}, 60_000);
afterAll(async () => {
  await new Promise((r) => server.close(r));
  cleanup();
});

describe("human-side parity routes", () => {
  it("GET /tests/:id/hygiene returns the same numbers as get_model_hygiene_stats, as plain text", async () => {
    const r = await req<TestHygiene>("GET", `/tests/${testKey}/hygiene`);
    expect(r.status).toBe(200);
    const mcp = await coord.hygieneStats({ testKey, examplesPerCheck: 3 });
    expect(r.json.byDocument).toHaveLength(mcp.byDocument.rows.length);
    expect(r.json.findings.map((f) => [f.check, f.count, f.clashesAffected])).toEqual(mcp.findings.map((f) => [f.check, f.count, f.clashesAffected]));
    for (const d of r.json.byDocument) expect(typeof d.doc).toBe("string");
  });

  it("lists and reads generate_report files; rejects traversal and unknown names", async () => {
    const empty = await req<ReportFile[]>("GET", "/reports/files?projectId=demo-proyecto");
    expect(empty.json).toEqual([]);
    await coord.generateReport({ kind: "weekly", testKey, format: "md", language: "es" });
    const files = await req<ReportFile[]>("GET", "/reports/files?projectId=demo-proyecto");
    expect(files.json).toHaveLength(1);
    expect(files.json[0]).toMatchObject({ format: "md", kind: "weekly", testKey });
    const one = await req<ReportFileContent>("GET", `/reports/files/${encodeURIComponent(files.json[0]!.name)}?projectId=demo-proyecto`);
    expect(one.json.content).toMatch(/^# Informe semanal de coordinación/);
    expect((await req("GET", `/reports/files/${encodeURIComponent("..%2Fnotes.md")}?projectId=demo-proyecto`)).status).toBe(400);
    expect((await req("GET", "/reports/files/x.md?projectId=..")).status).toBe(400);
    expect((await req("GET", "/reports/files/nope.md?projectId=demo-proyecto")).status).toBe(404);
  });

  it("GET /learning/feedback shows UI and agent feedback with their origin and no user names", async () => {
    const g = (await coord.listGroups({ testKey, limit: 1 } as never)) as { rows: unknown[][]; columns: string[] };
    const groupId = String(g.rows[0]![g.columns.indexOf("groupId")]);
    await coord.recordFeedback({ target: { groupId, testKey }, verdict: "incorrect", corrected: { validity: "tolerated" }, coordinatorStatement: "Pasada prevista por plano E-301.", generalizable: "yes", scope: "project" });
    await api.ui.submitFeedback({ target: { groupId, testId: testKey }, verdict: "correct", coordinatorStatement: "Bien clasificado.", generalizable: "no", scope: "this_group" } as never, HUMAN);
    const all = await req<Page<FeedbackRow>>("GET", "/learning/feedback");
    expect(all.json.items.map((r) => r.source)).toEqual(["ui", "agent"]);
    expect(JSON.stringify(all.json)).not.toContain(HUMAN.name);
    const agent = await req<Page<FeedbackRow>>("GET", "/learning/feedback?source=agent&projectId=demo-proyecto");
    expect(agent.json.items).toHaveLength(1);
    expect(agent.json.items[0]).toMatchObject({ source: "agent", groupId, correctedValidity: "tolerated", generalizable: "yes" });
    expect((await req("GET", "/learning/feedback?source=bogus")).status).toBe(400);
  });

  it("project notes: appended lines are dated and signed by role, never by name", async () => {
    const r = await req<ProjectNotes>("POST", "/projects/demo-proyecto/notes", { text: "Shafts de ELE se coordinan en planta, no en corte", kind: "convención" });
    expect(r.status).toBe(200);
    expect(r.json.text).toMatch(/- \d{4}-\d{2}-\d{2} · \[convención\] Shafts de ELE se coordinan en planta, no en corte \(confirmado por coordinador\)/);
    expect(r.json.text).not.toContain(HUMAN.name);
    const g = await req<ProjectNotes>("GET", "/projects/demo-proyecto/notes");
    expect(g.json.text).toBe(r.json.text);
  });

  it("family detach and merge over HTTP (human-only, CSRF)", async () => {
    const fams = await req<FamiliesPayload>("GET", `/tests/${testKey}/families`);
    const multi = fams.json.families.find((f) => f.groupIds.length >= 2 && f.decision?.status !== "approved");
    expect(multi).toBeTruthy();
    const det = await req<FamiliesPayload>("POST", `/families/${multi!.id}/detach`, { testId: testKey, groupId: multi!.groupIds[0] });
    expect(det.status).toBe(200);
    const solo = det.json.families.find((f) => f.groupIds.length === 1 && f.groupIds[0] === multi!.groupIds[0]);
    expect(solo && solo.id).not.toBe(multi!.id);
    const merged = await req<FamiliesPayload>("POST", "/families/merge", { testId: testKey, from: solo!.id, into: multi!.id });
    expect(merged.status).toBe(200);
    expect(merged.json.families.find((f) => f.id === multi!.id)!.groupIds).toContain(multi!.groupIds[0]);
    const noCsrf = await fetch(`${base}/families/merge`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ testId: testKey, from: solo!.id, into: multi!.id }) });
    expect(noCsrf.status).toBe(403);
  });
});
