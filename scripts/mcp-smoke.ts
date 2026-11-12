/**
 * MCP smoke test: starts `npx tsx server/mcp/index.ts` over stdio, lists the
 * tools and (in fixture mode) runs ingest → classify → list_groups.
 *
 *   npx tsx scripts/mcp-smoke.ts            # fixtures, temp COORDINATOR_HOME
 *   npx tsx scripts/mcp-smoke.ts --live     # whatever the environment says (no writes)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const live = process.argv.includes("--live");
const home = mkdtempSync(join(tmpdir(), "coord-smoke-"));

const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
if (!live) Object.assign(env, { COORD_DATA_SOURCE: "fixtures", COORDINATOR_HOME: home });

const transport = new StdioClientTransport({
  command: process.platform === "win32" ? "npx.cmd" : "npx",
  args: ["tsx", "server/mcp/index.ts"],
  cwd: root,
  env,
  stderr: "pipe",
});
const client = new Client({ name: "coord-smoke", version: "0.0.1" });

function parse(res: unknown): { ok: boolean; data?: any; error?: { code: string; message: string } } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const content = (res as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`tools (${tools.tools.length}): ${tools.tools.map((t) => t.name).join(", ")}`);
  const status = parse(await client.callTool({ name: "get_session_status", arguments: {} }));
  console.log("get_session_status:", JSON.stringify(status.data?.autonomy), status.data?.dataSource);
  if (!live) {
    const tests = parse(await client.callTool({ name: "list_clash_tests", arguments: { projectId: "b.demo-proyecto" } }));
    const testId = tests.data.rows[0][0];
    const ing = parse(await client.callTool({ name: "ingest_clash_test", arguments: { projectId: "b.demo-proyecto", testId } }));
    console.log("ingest:", ing.data.testKey, ing.data.counts.clashes, "clashes");
    const cls = parse(await client.callTool({ name: "run_classification", arguments: {} }));
    console.log("classify:", cls.data.groups.total, "groups,", cls.data.needsReview.groups, "need review");
    const groups = parse(await client.callTool({ name: "list_groups", arguments: { filter: { needsReview: true }, limit: 5 } }));
    console.log("list_groups:", groups.data.total, "rows; first:", groups.data.rows[0]?.[0]);
    const apply = parse(await client.callTool({ name: "apply_approved_proposals", arguments: { batchId: "L-2099-01-01-01" } }));
    console.log("apply unknown batch:", JSON.stringify(apply.error ?? apply.data));
  }
  await client.close();
  console.log("OK");
} catch (err) {
  console.error("SMOKE FAILED:", err);
  process.exitCode = 1;
} finally {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows may hold the dir briefly */
  }
}
