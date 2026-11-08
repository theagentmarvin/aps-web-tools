// Shared helpers for the coordinator harness hooks (v2).
// Plain Node ESM, no dependencies. Every hook imports only from node:* and this file.
//
// Contract (https://code.claude.com/docs/en/hooks):
// - stdin: one JSON object {session_id, cwd, hook_event_name, tool_name, tool_input, agent_id?, agent_type?, ...}
// - PreToolUse decision: exit 0 + stdout {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask","permissionDecisionReason":"..."}}
// - exit 2 = blocking error (stderr goes to Claude). Used for fail-closed paths.
// - exit 0 with no output = "no decision" (normal permission flow applies).
//
// HONESTY NOTE: these hooks are best-effort defence in depth against model error and prompt injection.
// They are NOT a security boundary. The boundary is the WebAuthn-verified human approval checked by the
// server (server/approval) plus Claude Code's own permission prompts.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

const WIN = process.platform === "win32";
const CASE_INSENSITIVE = WIN || process.platform === "darwin";

/** Read and parse the hook input. Throws on empty or invalid JSON. Strips a UTF-8 BOM (PowerShell pipes). */
export function readInput() {
  const raw = readFileSync(0, "utf8").replace(/^\uFEFF/, "");
  if (!raw || !raw.trim()) throw new Error("empty hook input");
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== "object") throw new Error("hook input is not an object");
  return obj;
}

/** Project root: CLAUDE_PROJECT_DIR (set by Claude Code), else the input cwd, else process cwd. */
export function projectRoot(input) {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd());
}

export function decide(decision, reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }),
  );
  process.exit(0);
}

export function pass() {
  process.exit(0);
}

export function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/** True when the call comes from a subagent (or a session started with --agent). */
export function isSubagent(input) {
  return Boolean(input && (input.agent_id || input.agent_type));
}

function readJsonIfExists(p) {
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * coordinator.config.json overlaid by coordinator.config.local.json. The autonomy level is the MINIMUM of both
 * (a local file can lower it, never raise it). Throws if either file exists but is not valid JSON.
 */
export function loadConfig(root) {
  const base = readJsonIfExists(path.join(root, "coordinator.config.json")) ?? {};
  const local = readJsonIfExists(path.join(root, "coordinator.config.local.json")) ?? {};
  const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    ...base,
    ...local,
    autonomy: { ...(base.autonomy ?? {}), ...(local.autonomy ?? {}), level: Math.min(num(base?.autonomy?.level, 1), num(local?.autonomy?.level, 3)) },
    foreignMcp: { ...(base.foreignMcp ?? {}), ...(local.foreignMcp ?? {}) },
  };
}

/**
 * Harness-development mode. ONLY the environment Claude Code was started with counts
 * (`COORD_HARNESS_DEV=1 claude`): hooks inherit Claude Code's environment, and the agent's shell cannot change
 * it. v1's marker file was removed because any process can create a file.
 */
export function isHarnessDev() {
  return process.env.COORD_HARNESS_DEV === "1";
}

const cmpCase = (s) => (CASE_INSENSITIVE ? s.toLowerCase() : s);

/** Realpath of the deepest existing ancestor + the remaining tail (resolves symlinks/junctions and 8.3 names). */
function realpathDeep(abs) {
  let cur = abs;
  const tail = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return { real: abs, tail: [] };
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  let real;
  try {
    real = realpathSync.native(cur);
  } catch {
    real = cur;
  }
  return { real: tail.length ? path.join(real, ...tail) : real, tail };
}

/** Windows path normalisation: \\?\ and \\.\ prefixes, loopback admin-share UNC, ADS, trailing dots/spaces. */
function normaliseWindows(p) {
  let s = p.replace(/\//g, "\\");
  if (/^\\\\[?.]\\UNC\\/i.test(s)) s = `\\\\${s.slice(8)}`;
  else if (/^\\\\[?.]\\/.test(s)) {
    s = s.slice(4);
    if (!/^[a-z]:\\/i.test(s)) return null; // device namespace (pipes, volumes, CON...) -> unresolvable
  }
  if (s.startsWith("\\\\")) {
    const m = s.match(/^\\\\([^\\]+)\\([^\\]+)(\\.*)?$/);
    if (!m) return null;
    const host = m[1].toLowerCase();
    const local = ["localhost", "127.0.0.1", "::1", "[::1]", ".", "?", hostname().toLowerCase()];
    const share = m[2].match(/^([a-z])\$$/i);
    if (!local.includes(host) || !share) return null; // other UNC targets cannot be mapped -> unresolvable
    s = `${share[1]}:${m[3] ?? "\\"}`;
  }
  const drive = s.match(/^[a-z]:/i)?.[0] ?? "";
  const rest = s.slice(drive.length);
  if (rest.includes(":")) return null; // alternate data stream or malformed
  const segs = rest.split("\\").map((seg) => (seg === "." || seg === ".." ? seg : seg.replace(/[. ]+$/, "")));
  return drive + segs.join("\\");
}

/**
 * Resolve a tool file path to a project-relative POSIX path.
 * Returns { rel } (inside the project), { outside, abs } (outside) or { unresolvable: reason }.
 * `rel` is lower-cased on case-insensitive file systems (Windows, macOS).
 */
export function resolveToolPath(root, p, cwd) {
  if (typeof p !== "string" || !p.trim()) return { unresolvable: "ruta vacía" };
  if (p.includes("\0")) return { unresolvable: "ruta con NUL" };
  let input = p;
  if (WIN) {
    input = normaliseWindows(p);
    if (input === null) return { unresolvable: `ruta no resoluble (${p.slice(0, 80)})` };
  }
  const abs = path.isAbsolute(input) ? path.normalize(input) : path.resolve(cwd || root, input);
  const { real, tail } = realpathDeep(abs);
  if (tail.some((seg) => /~\d/.test(seg))) return { unresolvable: "nombre corto 8.3 no resoluble" };
  const rootReal = realpathDeep(path.resolve(root)).real;
  const rel = path.relative(cmpCase(rootReal), cmpCase(real)).split(path.sep).join("/");
  if (rel === "" ) return { rel: "" };
  if (rel.startsWith("../") || rel === ".." || path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) return { outside: true, abs: cmpCase(real).split(path.sep).join("/") };
  return { rel };
}

/** Back-compat helper: project-relative POSIX path, or null if outside/unresolvable. */
export function relPath(root, p, cwd) {
  const r = resolveToolPath(root, p, cwd);
  return typeof r.rel === "string" ? r.rel : null;
}

/** Spanish prefix for every refusal so the coordinator sees where it came from. */
export const TAG = "[guardia coordinador]";
