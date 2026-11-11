// PreToolUse guard for mcp__coord__apply_approved_proposals inside the APP (chat and flows).
// The in-app agent never applies: applying an approved batch is a human action in the UI (/aprobaciones).
// The tool is also absent from every in-app agent's tool list, disallowed by the server's spawn arguments and
// unavailable in the MCP server's chat/flow modes. This hook is the last backstop: it always denies.
import { readInput, decide, block, TAG } from "./_lib.mjs";

try {
  readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; aplicación bloqueada (${e.message}).`);
}
decide("deny", `${TAG} El agente de la app nunca aplica en ACC. Aprobar y aplicar un lote lo hace el coordinador en la UI (/aprobaciones, con passkey).`);
