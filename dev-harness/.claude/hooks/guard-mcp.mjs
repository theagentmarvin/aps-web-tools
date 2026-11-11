// PreToolUse guard for the coord MCP tools in DEVELOPER mode.
//   - mcp__coord__apply_approved_proposals: always denied (no ACC writes from the dev agent).
//   - Default (fixtures; scripts/dev-mcp.mjs gives the server a throw-away COORDINATOR_HOME): every other tool passes.
//   - COORD_DEV_LIVE=1 (set by the developer when starting `claude`; the agent cannot change it): live ACC data,
//     READ-ONLY — only get_* / list_* / summarize_* / diff_* tools pass; anything that writes (proposals,
//     ingest, classification, context, feedback, reports, flows) is denied.
import { readInput, decide, pass, block, TAG } from "./_lib.mjs";

let input;
try {
  input = readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; herramienta bloqueada (${e.message}).`);
}

const name = String(input.tool_name ?? "");
if (!name.startsWith("mcp__coord__")) pass();
if (name === "mcp__coord__apply_approved_proposals") {
  decide("deny", `${TAG} El agente de desarrollo nunca aplica en ACC. Prueba la aplicación con fixtures desde la UI (npm run demo).`);
}
if (process.env.COORD_DEV_LIVE === "1") {
  const tool = name.slice("mcp__coord__".length);
  if (!/^(get|list|summarize|diff)_/.test(tool)) {
    decide("deny", `${TAG} Modo desarrollo con datos reales (COORD_DEV_LIVE=1): solo herramientas de lectura. ${tool} escribe; pruébala con fixtures.`);
  }
}
pass();
