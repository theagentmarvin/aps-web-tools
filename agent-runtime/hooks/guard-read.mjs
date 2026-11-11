// PreToolUse guard for read tools (Read, Grep, Glob) inside the APP (flows and their subagents; the chat has no
// read tools). Reading documentation, rules and the project notes is fine; secrets are not:
//   .env / .env.local / .env.*.local (not .env.example)
//   the keystore: %APPDATA%\bim-coordinator, ~/.config/bim-coordinator, COORD_SECURE_DIR
//   secret/ and auth/ folders of any data home (.coordinator, %LOCALAPPDATA%\bim-coordinator\data, COORDINATOR_HOME)
//   .git/ and Claude Code's own credentials (~/.claude/, ~/.claude.json)
// Matching is done on every path-like field (file_path, path, pattern, glob), lower-cased with forward slashes,
// so it also catches globs and paths inside nested worktrees. Fails CLOSED on unreadable input.
import path from "node:path";
import { readInput, decide, pass, block, TAG } from "./_lib.mjs";

let input;
try {
  input = readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; lectura bloqueada (${e.message}).`);
}

const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
const norm = (s) => String(s).replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
const fields = [ti.file_path, ti.path, ti.pattern, ti.glob, ti.notebook_path].filter((v) => typeof v === "string" && v.trim());
if (!fields.length) pass();

const secureDir = process.env.COORD_SECURE_DIR ? norm(path.resolve(process.env.COORD_SECURE_DIR)) : undefined;
const home = process.env.COORDINATOR_HOME ? norm(path.resolve(process.env.COORDINATOR_HOME)) : undefined;

const RULES = [
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, "archivos .env (secretos)"],
  [/(^|\/)\.env\*|(^|\/)\.env\.\*/, "archivos .env (secretos)"],
  [/appdata\/roaming\/bim-coordinator(\/|$)|\.config\/bim-coordinator(\/|$)/, "el almacén de claves del coordinador"],
  [/(^|\/)(\.coordinator[^/]*|bim-coordinator\/data|data)\/(secret|auth)(\/|$)/, "llaves y sesiones del coordinador"],
  [/(^|\/)\.git(\/|$)/, ".git/"],
  [/(^|\/)\.claude\.json$|(^|\/)\.claude\/\.credentials/, "credenciales de Claude Code"],
  [/approval-key|audit-key|aps-token|webauthn-cred|browser-session/, "llaves o tokens del coordinador"],
];

for (const f of fields) {
  const n = norm(f);
  for (const [re, why] of RULES) if (re.test(n)) decide("deny", `${TAG} Lectura bloqueada: ${why}.`);
  const abs = path.isAbsolute(f) ? norm(path.resolve(f)) : undefined;
  if (abs && secureDir && (abs === secureDir || abs.startsWith(`${secureDir}/`))) decide("deny", `${TAG} Lectura bloqueada: el almacén de claves del coordinador.`);
  if (abs && home && /^(secret|auth)(\/|$)/.test(abs.startsWith(`${home}/`) ? abs.slice(home.length + 1) : "")) decide("deny", `${TAG} Lectura bloqueada: llaves y sesiones del coordinador.`);
}
pass();
