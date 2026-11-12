// coord MCP server for the DEVELOPER session (dev-harness/.mcp.json → `node scripts/dev-mcp.mjs`).
//
// Default: fixtures data in a throw-away data home (%TEMP%\bim-coordinator-dev-home, or COORD_DEV_HOME), so the
// dev agent never sees coordinators' real projects. With COORD_DEV_LIVE=1 in the environment `claude` was
// started with, the server reads live ACC data with the coordinator's own data home; the dev hooks
// (.claude/hooks/guard-mcp.mjs) then allow only read tools, and apply is always denied.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
if (env.COORD_DEV_LIVE === "1") {
  delete env.COORDINATOR_HOME;
  delete env.COORD_DATA_SOURCE;
} else {
  env.COORD_DATA_SOURCE = "fixtures";
  env.COORDINATOR_HOME = env.COORD_DEV_HOME || join(tmpdir(), "bim-coordinator-dev-home");
  mkdirSync(env.COORDINATOR_HOME, { recursive: true });
}
const child = spawn(process.execPath, ["--import", "tsx", join(root, "server", "mcp", "index.ts")], { cwd: root, env, stdio: "inherit", windowsHide: true });
child.on("error", (err) => {
  process.stderr.write(`dev-mcp: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
