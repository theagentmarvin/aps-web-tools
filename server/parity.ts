/**
 * Human-side parity reads (docs/ai/agent-human-parity.md #10, #62, #68):
 * what the agent can see through MCP tools, exposed read-only to the web UI.
 *   - hygiene stats of a test (same numbers as get_model_hygiene_stats);
 *   - report files written by generate_report (.coordinator/reports/<projectId>/);
 *   - feedback records (record_feedback from the agent, UI feedback, decisions) with their origin.
 * No personal data: feedback records carry no actor; only the origin (`ui` / `agent` / `decision`).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type * as C from "./api/contract";
import type { Coordinator } from "./coordinator";
import { bareProjectId, CoordError, paginate } from "./util";

const REPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.(md|html)$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Model-derived text arrives wrapped as `{untrusted}` (MCP convention); the UI renders it as plain text. */
function plain(v: unknown): string {
  if (v && typeof v === "object" && "untrusted" in v) return String((v as { untrusted: unknown }).untrusted ?? "");
  return String(v ?? "");
}

export async function testHygiene(core: Coordinator, testId: string): Promise<C.TestHygiene> {
  const h = await core.hygieneStats({ testKey: testId, examplesPerCheck: 3 });
  return {
    testId,
    byDocument: h.byDocument.rows.map((r) => ({
      doc: plain(r[0]),
      discipline: String(r[1]),
      elementsInClashes: Number(r[2]),
      selfClashes: Number(r[3]),
      duplicates: Number(r[4]),
      missingLevel: Number(r[5]),
      missingSystem: Number(r[6]),
      genericTypes: Number(r[7]),
    })),
    findings: h.findings.map((f) => ({ check: f.check as C.HygieneCheck, doc: plain(f.doc), count: f.count, examples: f.examples, clashesAffected: f.clashesAffected })),
  };
}

function reportsDir(core: Coordinator, projectId: string): string {
  const pid = bareProjectId(projectId);
  if (!PROJECT_ID.test(pid) || pid.includes("..")) throw new CoordError("validation_error", "projectId inválido.");
  return core.store.path("reports", pid);
}

/** Files written by generate_report for a project, newest first. */
export async function listReportFiles(core: Coordinator, projectId: string): Promise<C.ReportFile[]> {
  const dir = reportsDir(core, projectId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: C.ReportFile[] = [];
  for (const name of names.filter((n) => REPORT_NAME.test(n))) {
    const s = await stat(join(dir, name)).catch(() => undefined);
    if (!s?.isFile()) continue;
    // generate_report names: <yyyy-mm-dd>-<kind>-<testKey>.<md|html>
    const m = /^(\d{4}-\d{2}-\d{2})-([a-z_]+)-(T-[0-9a-f]+)\.(md|html)$/.exec(name);
    out.push({
      name,
      format: name.endsWith(".html") ? "html" : "md",
      ...(m ? { kind: m[2], testKey: m[3], date: m[1] } : {}),
      size: s.size,
      modifiedAt: s.mtime.toISOString(),
    });
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name)).slice(0, 200);
}

export async function readReportFile(core: Coordinator, projectId: string, name: string): Promise<C.ReportFileContent> {
  if (!REPORT_NAME.test(name) || name.includes("..")) throw new CoordError("validation_error", "Nombre de informe inválido.");
  const dir = reportsDir(core, projectId);
  let content: string;
  try {
    content = await readFile(join(dir, name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new CoordError("not_found", `Informe ${name} no existe.`);
    throw err;
  }
  return { name, format: name.endsWith(".html") ? "html" : "md", content: content.slice(0, 2_000_000) };
}

/** Feedback records (agent record_feedback, UI feedback, decisions with suggestRule), newest first. */
export async function listFeedbackRows(core: Coordinator, q: { projectId?: string; source?: C.FeedbackSource[]; limit?: number; cursor?: string }): Promise<C.Page<C.FeedbackRow>> {
  let fb = await core.store.listFeedback();
  if (q.projectId) fb = fb.filter((f) => f.projectId && bareProjectId(f.projectId) === bareProjectId(q.projectId!));
  if (q.source?.length) fb = fb.filter((f) => q.source!.includes(f.source));
  const rows: C.FeedbackRow[] = [...fb].reverse().map((f) => ({
    feedbackId: f.id,
    at: f.at,
    source: f.source,
    verdict: f.verdict,
    ...(f.testKey ? { testKey: f.testKey } : {}),
    ...(f.target.groupId ? { groupId: f.target.groupId } : {}),
    ...(f.target.proposalId ? { proposalId: f.target.proposalId } : {}),
    ...(f.snapshot?.engine?.validity ? { engineValidity: f.snapshot.engine.validity } : {}),
    ...(f.corrected?.validity !== undefined ? { correctedValidity: String(f.corrected.validity) } : {}),
    ...(f.snapshot?.disciplinePair ? { disciplinePair: f.snapshot.disciplinePair } : {}),
    ruleIds: f.snapshot?.ruleIds ?? [],
    statement: f.coordinatorStatement,
    generalizable: f.generalizable,
    scope: f.scope,
    ...(f.reasonCode ? { reasonCode: f.reasonCode } : {}),
    curated: f.curated,
  }));
  const page = paginate(rows, Math.min(q.limit ?? 200, 1000), q.cursor);
  return { items: page.items, total: page.total, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}
