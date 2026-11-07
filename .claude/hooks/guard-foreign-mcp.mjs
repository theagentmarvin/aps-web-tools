// PreToolUse guard for MCP tools that are NOT from the `coord` server.
// Coordinators' machines often have other MCP servers (Revit, Power BI, document connectors).
// In this repo the coordination agent must not mutate BIM models or other systems through them.
//
// Configurable in coordinator.config.json / coordinator.config.local.json:
//   "foreignMcp": {
//     "mode": "block_writes",          // "block_writes" (default) | "block_all" | "allow_all"
//     "allow": ["mcp__mcp-server-for-revit__get_*"],   // globs, always allowed (win over deny)
//     "deny":  ["mcp__powerbi-modeling__*"]             // globs, always denied
//   }
// Write detection is a name heuristic on the tool segment (after the last "__").
// Fails CLOSED (deny) on unreadable input or invalid config.
import { readInput, projectRoot, decide, pass, block, loadConfig, TAG } from "./_lib.mjs";

let input;
try {
  input = readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; herramienta MCP externa bloqueada (${e.message}).`);
}

const name = String(input.tool_name ?? "");
if (!name.startsWith("mcp__") || name.startsWith("mcp__coord__")) pass();

let policy;
try {
  policy = loadConfig(projectRoot(input)).foreignMcp ?? {};
} catch (e) {
  decide("deny", `${TAG} Configuración inválida; herramienta MCP externa bloqueada (${e.message}).`);
}

const mode = policy.mode ?? "block_writes";
const globToRe = (g) => new RegExp(`^${String(g).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
const matches = (list) => Array.isArray(list) && list.some((g) => globToRe(g).test(name));

if (matches(policy.allow)) pass();
if (matches(policy.deny)) decide("deny", `${TAG} ${name} está denegada por la política foreignMcp de este repositorio.`);
if (mode === "allow_all") pass();
if (mode === "block_all") decide("deny", `${TAG} En este repositorio solo se usan las herramientas mcp__coord__* (política foreignMcp=block_all).`);

const tool = name.slice(name.lastIndexOf("__") + 2);
const WRITE_LIKE =
  /(^|[_-])(set|create|delete|remove|update|upsert|write|edit|modify|operate|send|build|load|duplicate|change|move|rename|insert|upload|post|put|patch|execute|exec|run|apply|import|save|publish|commit|push|merge|drop|batch|transaction|deploy|add|assign|close|reopen|archive|restore|trigger|invoke|code)([_-]|$)|_operations$|^(create|update|delete|batch|write|send|run|apply)$/i;

if (WRITE_LIKE.test(tool)) {
  decide(
    "deny",
    `${TAG} ${name} parece una herramienta de escritura de otro servidor MCP. El agente de coordinación no modifica ` +
      `modelos ni otros sistemas desde este repositorio (configurable en coordinator.config.json → foreignMcp).`,
  );
}
pass();
