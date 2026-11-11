// PreToolUse guard for built-in file tools (Edit, Write, MultiEdit, NotebookEdit). v2.
// Best-effort defence in depth (not a security boundary; see _lib.mjs). Fails CLOSED on unreadable input
// and on paths that cannot be resolved (\\?\, UNC to other hosts, alternate data streams, unresolvable 8.3 names).
//
// Inside the project (paths normalised: \\?\ and \\.\ prefixes, loopback admin shares, trailing dots/spaces,
// case, symlinks/junctions via realpath of the deepest existing parent):
//   .coordinator/**                    deny, except .coordinator/projects/<id>/notes.md
//   .git/**                            deny (always)
//   .env*                              deny (except .env.example)
//   harness: .claude/**, CLAUDE.md, .mcp.json, coordinator.config*.json, harness-staging/**
//                                      deny unless dev mode (COORD_HARNESS_DEV=1 in Claude Code's env)
//   guarding code & build: server/**, core/**, scripts/**, tests/**, src/**, public/**, index.html,
//     node_modules/**, vite.config.ts, vitest.config.ts, package.json, package-lock.json, tsconfig*.json
//                                      ask unless dev mode
//   rules/**                           ask (normal path: /curar-reglas)
// Outside the project:
//   any .claude/ dir, .claude.json, the keystore (bim-coordinator)      deny
//   executable/script files (.mjs .js .cjs .ts .ps1 .py .sh .bat .cmd …) ask
//   anything else                                                        normal permission flow
import { homedir } from "node:os";
import { join } from "node:path";
import { readInput, projectRoot, decide, pass, block, isHarnessDev, resolveToolPath, TAG } from "./_lib.mjs";

let input;
try {
  input = readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; edición bloqueada (${e.message}).`);
}

const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
const target = ti.file_path ?? ti.notebook_path ?? ti.path;
const root = projectRoot(input);
const dev = isHarnessDev();
const r = resolveToolPath(root, target, input.cwd);

if (r.unresolvable) decide("deny", `${TAG} Ruta no resoluble para escritura: ${r.unresolvable}.`);

// The coordinator state dir may live outside the repo (COORDINATOR_HOME for demos/evals) and the keystore
// (COORD_SECURE_DIR): same rule as .coordinator/ wherever they are — only projects/<id>/notes.md is writable.
// Since WS-H the default data home is per user, outside the repo (server/store/home.ts):
// %LOCALAPPDATA%\bim-coordinator\data (or $XDG_DATA_HOME / ~/.local/share/bim-coordinator/data), backups next to it.
const dataBase = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "bim-coordinator")
  : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "bim-coordinator");
const STATE_DIRS = [
  ["COORDINATOR_HOME", process.env.COORDINATOR_HOME, true],
  ["el directorio de datos del coordinador", join(dataBase, "data"), true],
  ["el directorio de respaldos del coordinador", join(dataBase, "backups"), false],
  ["COORD_SECURE_DIR", process.env.COORD_SECURE_DIR, false],
];
for (const [envName, dir, allowNotes] of STATE_DIRS) {
  if (!dir) continue;
  // Relative paths resolve against the session cwd or the project, never against the state dir itself.
  const inner = resolveToolPath(dir, target, input.cwd || root);
  if (typeof inner.rel === "string") {
    if (allowNotes && /^projects\/[^/]+\/notes\.md$/.test(inner.rel)) pass();
    decide("deny", `${TAG} ${envName} lo gestiona el servidor; el agente no escribe ahí${allowNotes ? " (salvo projects/<id>/notes.md)" : ""}.`);
  }
}

const SCRIPT_EXT = /\.(m?js|cjs|ts|mts|cts|tsx|jsx|ps1|psm1|psd1|py|sh|bash|zsh|bat|cmd|vbs|wsf|hta|lnk|reg|exe|dll)$/i;

if (r.outside) {
  const a = r.abs;
  if (/(^|\/)\.claude(\/|$)|(^|\/)\.claude\.json$|(^|\/)bim-coordinator(\/|$)/i.test(a)) {
    decide("deny", `${TAG} Escritura bloqueada fuera del proyecto: configuración de Claude Code o almacén de claves (${a}).`);
  }
  if (SCRIPT_EXT.test(a)) decide("ask", `${TAG} Escribir un script fuera del proyecto (${a}). Confirma solo si lo pediste tú.`);
  pass();
}

const rel = r.rel;

if (/^\.coordinator(\/|$)/.test(rel)) {
  if (/^\.coordinator\/projects\/[^/]+\/notes\.md$/.test(rel)) pass();
  decide("deny", `${TAG} .coordinator/ lo gestiona el servidor; el agente solo puede editar .coordinator/projects/<id>/notes.md.`);
}
if (/^\.git(\/|$)/.test(rel)) decide("deny", `${TAG} .git/ no se edita desde el agente (hooks de git ejecutan código).`);
if (/^\.env(\.(?!example$)[\w.-]+)?$/.test(rel)) decide("deny", `${TAG} Los archivos .env contienen secretos y no se editan desde el agente.`);

const harness =
  /^\.claude(\/|$)/.test(rel) || rel === "claude.md" || rel === "CLAUDE.md" || rel === ".mcp.json" ||
  /^coordinator\.config(\.local)?\.json$/.test(rel) || /^harness-staging(\/|$)/.test(rel);
if (harness && !dev) {
  decide("deny", `${TAG} La configuración del agente (${rel}) solo la cambia un humano. Para desarrollar el harness, inicia claude con COORD_HARNESS_DEV=1.`);
}

const guardedCode =
  /^(server|core|scripts|tests|src|public|node_modules)\//.test(rel) ||
  /^(index\.html|vite\.config\.ts|vitest\.config\.ts|package\.json|package-lock\.json|tsconfig[^/]*\.json)$/.test(rel);
if (guardedCode && !dev) {
  decide("ask", `${TAG} ${rel} es código o configuración de la aplicación que protege las aprobaciones. El agente de coordinación no lo edita; confirma solo si estás desarrollando (o usa COORD_HARNESS_DEV=1).`);
}

if (/^rules\//.test(rel)) {
  decide("ask", `${TAG} Edición directa de reglas (${rel}). Lo normal es /curar-reglas con evaluación; confirma solo si eres el responsable de reglas.`);
}

pass();
