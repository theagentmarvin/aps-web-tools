// PreToolUse guard for file tools in DEVELOPER mode (Read, Grep, Glob, Edit, Write, MultiEdit, NotebookEdit).
//   deny  read or write of coordinators' real data / backups / secrets / .env* (see _lib.mjs), at any depth
//   ask   edits of the active guard: .claude/hooks/** and .claude/settings*.json (incl. nested worktrees, ~/.claude)
//   allow everything else: app code (incl. approval/webauthn/apply/data code), agent-runtime/**, dev-harness/**,
//         CLAUDE.md, other .claude/ files (skills, agents), docs, tests, scripts
// Fails CLOSED on unreadable input.
import { readInput, projectRoot, decide, pass, block, normPath, protectedReason, isActiveGuard, TAG } from "./_lib.mjs";

let input;
try {
  input = readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; operación bloqueada (${e.message}).`);
}

const tool = String(input.tool_name ?? "");
const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
const base = input.cwd || projectRoot(input);
const writes = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool);

const fields = [ti.file_path, ti.notebook_path, ti.path].filter((v) => typeof v === "string" && v.trim());
for (const f of fields) {
  const abs = normPath(f, base);
  const why = protectedReason(abs);
  if (why) decide("deny", `${TAG} Bloqueado: ${why}. El agente de desarrollo trabaja con datos de prueba (fixtures), nunca con datos reales ni secretos.`);
  if (writes && isActiveGuard(abs)) {
    decide("ask", `${TAG} Vas a modificar la guardia activa del modo desarrollo (${f}). Estas reglas protegen los datos reales y los secretos de los coordinadores; confirma solo si tú lo pediste.`);
  }
}

// Glob / Grep patterns that reach .env or the data/secret folders by wildcard.
for (const g of [ti.pattern, ti.glob].filter((v) => typeof v === "string" && v.trim())) {
  if (tool === "Grep" && g === ti.pattern) continue; // Grep's pattern is a regex over contents, not a path
  const s = String(g).replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)\.env(\*|\.\*|\.local)|bim-coordinator\/(data|backups|\*)|roaming\/bim-coordinator|(^|\/)\.coordinator(\/|\*|$)/.test(s)) {
    decide("deny", `${TAG} Bloqueado: el patrón alcanza datos reales, respaldos o secretos (${g}).`);
  }
}
pass();
