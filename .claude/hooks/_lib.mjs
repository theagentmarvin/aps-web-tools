// Shared helpers for the coordinator harness hooks.
// Plain Node ESM, no dependencies. Every hook imports only from node:* and this file.
//
// Contract (https://code.claude.com/docs/en/hooks):
// - stdin: one JSON object {session_id, cwd, hook_event_name, tool_name, tool_input, agent_id?, agent_type?, ...}
// - PreToolUse decision: exit 0 + stdout {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask","permissionDecisionReason":"..."}}
// - exit 2 = blocking error (stderr goes to Claude). Used for fail-closed paths.
// - exit 0 with no output = "no decision" (normal permission flow applies).
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Read and parse the hook input. Throws on empty or invalid JSON. */
export function readInput() {
  // Strip a UTF-8 BOM: PowerShell pipelines (e.g. manual testing) prepend one.
  const raw = readFileSync(0, "utf8").replace(/^﻿/, "");
  if (!raw || !raw.trim()) throw new Error("empty hook input");
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== "object") throw new Error("hook input is not an object");
  return obj;
}

/** Project root: CLAUDE_PROJECT_DIR (set by Claude Code), else the input cwd, else process cwd. */
export function projectRoot(input) {
  return resolve(process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd());
}

/** Emit a PreToolUse decision and exit 0. */
export function decide(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
    }),
  );
  process.exit(0);
}

/** No decision: let the normal permission flow apply. */
export function pass() {
  process.exit(0);
}

/** Blocking error (fail closed). */
export function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/** True when the call comes from a subagent (or a session started with --agent). */
export function isSubagent(input) {
  return Boolean(input && (input.agent_id || input.agent_type));
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")); // throws on invalid JSON: callers decide fail-open/closed
}

/**
 * Coordinator config: coordinator.config.json, overlaid by coordinator.config.local.json.
 * The autonomy level is the MINIMUM of both files (a local file can lower it, never raise it).
 * Throws if either file exists but is not valid JSON.
 */
export function loadConfig(root) {
  const base = readJsonIfExists(join(root, "coordinator.config.json")) ?? {};
  const local = readJsonIfExists(join(root, "coordinator.config.local.json")) ?? {};
  const baseLevel = numberOr(base?.autonomy?.level, 1);
  const localLevel = numberOr(local?.autonomy?.level, 3);
  return {
    ...base,
    ...local,
    autonomy: { ...(base.autonomy ?? {}), ...(local.autonomy ?? {}), level: Math.min(baseLevel, localLevel) },
    foreignMcp: { ...(base.foreignMcp ?? {}), ...(local.foreignMcp ?? {}) },
  };
}

function numberOr(v, d) {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/**
 * Harness-development mode: lets a human edit harness config files (.claude/**, .mcp.json,
 * coordinator.config*.json) through Claude Code. Enabled by the env var COORD_HARNESS_DEV=1
 * (set in the shell BEFORE launching claude; the agent cannot change Claude Code's env) or by the
 * marker file .coordinator/harness-dev (git-ignored; the agent is blocked from creating it).
 * Never relaxes token/secret/approval protections.
 */
export function isHarnessDev(root) {
  return process.env.COORD_HARNESS_DEV === "1" || existsSync(join(root, ".coordinator", "harness-dev"));
}

/** Project-relative POSIX path for a tool file path; null if outside the project. */
export function relPath(root, p, cwd) {
  if (typeof p !== "string" || !p) return null;
  const abs = isAbsolute(p) ? p : resolve(cwd || root, p);
  const rel = relative(root, abs).split("\\").join("/");
  if (rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return null;
  return process.platform === "win32" ? rel.toLowerCase() : rel;
}

/** Spanish prefix for every refusal so the coordinator sees where it came from. */
export const TAG = "[guardia coordinador]";
