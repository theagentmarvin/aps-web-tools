/**
 * `npm run demo`: offline demo of the whole app (no APS credentials).
 * Runs Vite with COORD_DATA_SOURCE=fixtures, COORDINATOR_HOME=.coordinator-demo
 * and VITE_COORD_API=http (the UI talks to the real server API over fixtures),
 * and writes `.mcp.demo.json` (git-ignored) for `claude --mcp-config .mcp.demo.json`.
 * Cross-platform without extra dependencies: spawns Vite's JS entry with node.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const viteBin = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");

const demoHome = join(root, ".coordinator-demo");
const fixtureEnv = { COORD_DATA_SOURCE: "fixtures", COORDINATOR_HOME: demoHome };
// Vite AND the coordinator API mounted inside it share this environment.
const env = { ...process.env, ...fixtureEnv, VITE_COORD_API: "http" };

// MCP config for Claude Code with the SAME fixture environment. It does not touch
// .mcp.json or the harness, so the demo works without `npm run setup`.
writeFileSync(
  join(root, ".mcp.demo.json"),
  JSON.stringify({ mcpServers: { coord: { command: "npx", args: ["tsx", "server/mcp/index.ts"], env: fixtureEnv } } }, null, 2) + "\n",
);
process.stderr.write(
  [
    "[demo] Modo fixtures: proyecto b.demo-proyecto, datos en .coordinator-demo/ (no se envía nada a ACC).",
    "[demo] UI: http://localhost:3000",
    "[demo] Si el puerto 3000 está ocupado por otra app: npm run demo -- --port 3005",
    "[demo] Agente (en otra terminal, en esta carpeta):",
    "         claude --mcp-config .mcp.demo.json",
    "",
  ].join("\n"),
);
const child = spawn(process.execPath, [viteBin, ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
