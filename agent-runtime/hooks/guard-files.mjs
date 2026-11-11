// PreToolUse guard for file-writing tools (Edit, Write, MultiEdit, NotebookEdit) inside the APP.
// The in-app agent never writes files: it uses the app (proposals, questions, reports through mcp__coord__*)
// and never changes the app (code, agent instructions, rules, configuration, hooks). Any write is denied.
import { readInput, decide, block, TAG } from "./_lib.mjs";

try {
  readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; edición bloqueada (${e.message}).`);
}
decide("deny", `${TAG} El agente de la app no edita archivos. Las mejoras de la app o del agente se piden en VS Code (modo desarrollo, /mejorar).`);
