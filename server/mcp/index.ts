/**
 * `coord` MCP server over stdio (registered in .mcp.json).
 *
 *   npx tsx server/mcp/index.ts                      # live ACC (cached APS token)
 *   COORD_DATA_SOURCE=fixtures npx tsx server/mcp/index.ts   # offline fixtures
 *
 * stdout is the protocol channel: everything else logs to stderr.
 */
import "../net/system-ca"; // first: trust the OS certificate store (corporate HTTPS inspection)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator } from "../coordinator";
import { loadRules } from "../engine";
import { log } from "../util";
import { createCoordServer } from "./server";

// Never let a stray console.log corrupt the protocol stream.
console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
console.info = console.log;

async function main(): Promise<void> {
  const root = process.env.CLAUDE_PROJECT_DIR ?? resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const coord = new Coordinator({ root });
  try {
    loadRules(); // logs CompiledRuleSet.warnings once (stderr)
  } catch (e) {
    log.warn("rules.invalid", { message: (e as Error).message.slice(0, 500) });
  }
  const server = createCoordServer(coord);
  await server.connect(new StdioServerTransport());
  log.info("mcp.started", { dataSource: coord.source.kind, level: coord.effectiveLevel, home: coord.store.home });
}

main().catch((err) => {
  process.stderr.write(`[coord] fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
