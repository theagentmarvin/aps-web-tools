// Shared helpers for the DEVELOPER harness hooks (VS Code / `claude` in this repository).
// Plain Node ESM, no dependencies. Minimal guardrails by design (product decision 2026-11-11): the dev agent may
// change all app code, the in-app agent (agent-runtime/) and this harness; the hooks only protect
//   1. coordinators' real data and backups (%LOCALAPPDATA%\bim-coordinator\data|backups, ~/.local/share/…,
//      a repo-local .coordinator/ of a legacy install),
//   2. secrets (%APPDATA%\bim-coordinator, ~/.config/bim-coordinator, COORD_SECURE_DIR, .env* except .env.example),
//   3. ACC writes (apply) and the env-var tricks that would disable the above,
// and ASK before the active guard itself (.claude/hooks/**, .claude/settings*.json) is edited.
// Path checks are segment-based on the normalised ABSOLUTE path, so they also match inside nested worktrees
// (.wt/X/.env, .wt/X/.claude/hooks/…) — never "repo-root-relative only".
// App safety invariants (permission matrix, CSRF/passkey on human routes, no apply from chat/flows) are
// enforced by the TEST SUITE, not by these hooks.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const TAG = "[guardia desarrollo]";

/** Read and parse the hook input. Throws on empty or invalid JSON. Strips a UTF-8 BOM. */
export function readInput() {
  const raw = readFileSync(0, "utf8").replace(/^\uFEFF/, "");
  if (!raw || !raw.trim()) throw new Error("empty hook input");
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== "object") throw new Error("hook input is not an object");
  return obj;
}

export function projectRoot(input) {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd());
}

export function decide(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }));
  process.exit(0);
}

export function pass() {
  process.exit(0);
}

export function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/** Lower-cased absolute POSIX form of a tool path (relative paths resolve against cwd / project). */
export function normPath(p, base) {
  let s = String(p).trim().replace(/^["']|["']$/g, "");
  // \\?\C:\x and \\.\C:\x prefixes, file:// URLs.
  s = s.replace(/^\\\\[?.]\\/, "").replace(/^file:\/\/\/?/i, "");
  if (s.startsWith("~")) s = path.join(homedir(), s.slice(1));
  const abs = path.isAbsolute(s) || /^[a-z]:[\\/]/i.test(s) ? s : path.resolve(base || process.cwd(), s);
  return abs
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .split("/")
    .map((seg) => (seg === "." || seg === ".." ? seg : seg.replace(/[. ]+$/, ""))) // Windows ignores trailing dots/spaces
    .join("/")
    .toLowerCase();
}

const posixLower = (p) => (p ? path.resolve(p).replace(/\\/g, "/").toLowerCase() : undefined);
const under = (p, dir) => !!dir && (p === dir || p.startsWith(`${dir}/`));

/** Folders that hold coordinators' real data, backups or secrets (from the environment, when set). */
function protectedDirs() {
  const env = process.env;
  const out = [];
  const add = (dir, why) => {
    const d = posixLower(dir);
    if (d) out.push([d, why]);
  };
  if (env.LOCALAPPDATA) {
    add(path.join(env.LOCALAPPDATA, "bim-coordinator", "data"), "datos reales de los coordinadores");
    add(path.join(env.LOCALAPPDATA, "bim-coordinator", "backups"), "respaldos de los coordinadores");
  }
  if (env.APPDATA) add(path.join(env.APPDATA, "bim-coordinator"), "secretos del coordinador (llaves, passkeys, tokens)");
  if (env.XDG_DATA_HOME) {
    add(path.join(env.XDG_DATA_HOME, "bim-coordinator", "data"), "datos reales de los coordinadores");
    add(path.join(env.XDG_DATA_HOME, "bim-coordinator", "backups"), "respaldos de los coordinadores");
  }
  if (env.COORD_SECURE_DIR) add(env.COORD_SECURE_DIR, "secretos del coordinador");
  return out;
}

/** Generic (environment-independent) patterns on the normalised absolute path. */
const PATTERNS = [
  [/(^|\/)bim-coordinator\/(data|backups)(\/|$)/, "datos reales o respaldos de los coordinadores"],
  [/(^|\/)appdata\/roaming\/bim-coordinator(\/|$)|(^|\/)\.config\/bim-coordinator(\/|$)/, "secretos del coordinador (llaves, passkeys, tokens)"],
  [/(^|\/)\.coordinator(-backups)?(\/|$)/, "carpeta de datos local de una instalación antigua (.coordinator/), puede tener datos reales"],
  [/(^|\/)\.env(\.local|\.[^/]+\.local)?$/, "archivo .env con secretos (solo .env.example es editable)"],
  [/(^|\/)(approval-key|audit-key|aps-token|webauthn-credentials|browser-session)\.json$/, "llaves o tokens del coordinador"],
];

/** Why a path is off-limits for the dev agent (read and write), or undefined. */
export function protectedReason(absLower) {
  for (const [dir, why] of protectedDirs()) if (under(absLower, dir)) return why;
  for (const [re, why] of PATTERNS) if (re.test(absLower)) return why;
  return undefined;
}

/** The active developer guard (any .claude/hooks/** or .claude/settings*.json, incl. nested worktrees and ~/.claude). */
export function isActiveGuard(absLower) {
  // dev-harness/.claude/** is the SOURCE of the next version (activated by a human), not the active guard.
  if (/(^|\/)dev-harness\/\.claude\//.test(absLower)) return false;
  return /(^|\/)\.claude\/hooks(\/|$)|(^|\/)\.claude\/settings(\.local)?\.json$/.test(absLower);
}
