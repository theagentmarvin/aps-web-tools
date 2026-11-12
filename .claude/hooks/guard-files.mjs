// PreToolUse guard for built-in file tools (Edit, Write, MultiEdit, NotebookEdit).
// Complements the permission deny rules with path-robust checks (absolute paths, backslashes,
// unknown .coordinator/ sub-directories). Fails CLOSED on unreadable input.
//
//  - .coordinator/**            deny, except .coordinator/projects/<id>/notes.md (project memory)
//  - harness config             deny unless harness-dev mode (COORD_HARNESS_DEV=1 or .coordinator/harness-dev)
//    (.claude/**, .mcp.json, coordinator.config*.json, CLAUDE.md)
//  - rules/**                   ask (a human confirms every direct rule edit; normal path is /curar-reglas)
//  - .env*                      deny (except .env.example)
import { readInput, projectRoot, decide, pass, block, isHarnessDev, relPath, TAG } from "./_lib.mjs";

let input;
try {
  input = readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; edición bloqueada (${e.message}).`);
}

const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
const target = ti.file_path ?? ti.notebook_path ?? ti.path;
const root = projectRoot(input);
const rel = relPath(root, target, input.cwd);
if (rel === null) pass(); // outside the project: normal permission flow

if (/^\.coordinator(\/|$)/.test(rel)) {
  if (/^\.coordinator\/projects\/[^/]+\/notes\.md$/.test(rel)) pass();
  decide("deny", `${TAG} .coordinator/ lo gestiona el servidor MCP; el agente solo puede editar .coordinator/projects/<id>/notes.md.`);
}

if (/^\.env(\.(?!example$)[\w.-]+)?$/.test(rel)) {
  decide("deny", `${TAG} Los archivos .env contienen secretos y no se editan desde el agente.`);
}

const harnessConfig =
  /^\.claude\//.test(rel) || rel === ".mcp.json" || /^coordinator\.config(\.local)?\.json$/.test(rel) || rel.toLowerCase() === "claude.md";
if (harnessConfig && !isHarnessDev(root)) {
  decide(
    "deny",
    `${TAG} La configuración del agente (${rel}) solo la cambia un humano. Para desarrollar el harness, inicia claude con COORD_HARNESS_DEV=1.`,
  );
}

if (/^rules\//.test(rel)) {
  decide("ask", `${TAG} Edición directa de reglas (${rel}). Lo normal es /curar-reglas con evaluación; confirma solo si eres el responsable de reglas.`);
}

pass();
