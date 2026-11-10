/**
 * Write-guard import rule (server/aps/write-guard.ts header): only the
 * approval module may mint ApprovedWriteTokens. Fails if any other non-test
 * source file references `issueApprovedWriteToken`. Also checks that the MCP
 * layer never calls the approval-signing function.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "tests", ".coordinator", "docs", "evals", "public", ".wt"]);
const ALLOWED = new Set(["server/aps/write-guard.ts", "server/approval/index.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !/\.test\.[a-z]+$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT).map((p) => ({ rel: relative(ROOT, p).split(sep).join("/"), text: readFileSync(p, "utf8") }));

describe("import guard", () => {
  it("scans a meaningful set of files", () => {
    expect(files.some((f) => f.rel === "server/approval/index.ts")).toBe(true);
    expect(files.length).toBeGreaterThan(20);
  });

  it("only server/approval may reference issueApprovedWriteToken", () => {
    const offenders = files.filter((f) => /\bissueApprovedWriteToken\b/.test(f.text) && !ALLOWED.has(f.rel)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the MCP server never signs approvals", () => {
    const mcp = files.filter((f) => f.rel.startsWith("server/mcp/"));
    expect(mcp.length).toBeGreaterThan(0);
    for (const f of mcp) {
      expect(f.text, f.rel).not.toMatch(/\bapproveBatch\b|\bsignApproval\b|approval\/hmac|loadOrCreateApprovalKey/);
    }
  });

  it("no tool named like an approval exists", async () => {
    const { TOOLS } = await import("../../server/mcp/contracts");
    expect(TOOLS.filter((t) => /approve|sign|reject/i.test(t.name.replace("apply_approved_proposals", "")))).toEqual([]);
  });
});
