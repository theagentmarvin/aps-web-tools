// PreToolUse guard for shell tools (Bash, PowerShell, Monitor) inside the APP (chat and flows).
// The in-app agent has no shell: the server never enables it (--tools), its agents disallow it and settings.json
// denies it. This hook is the backstop: any shell call is denied (fails closed on unreadable input).
import { readInput, decide, block, TAG } from "./_lib.mjs";

try {
  readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; comando bloqueado (${e.message}).`);
}
decide("deny", `${TAG} El agente de la app no usa la terminal; trabaja solo con las herramientas mcp__coord__*.`);
