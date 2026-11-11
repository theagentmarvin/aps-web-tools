// Shared helpers for the IN-APP agent hooks (chat + flows). Plain Node ESM, no dependencies.
//
// The app server materialises agent-runtime/ into a private folder (server/agent-runtime.ts) and launches
// `claude -p` with that folder as cwd, so CLAUDE_PROJECT_DIR is the runtime folder, NOT the repository.
// The server passes, in the child's environment (hooks inherit it):
//   COORD_APP_ROOT         the application folder (coordinator.config*.json lives there)
//   COORD_AGENT_AUDIT_DIR  where audit-log.mjs appends agent-YYYY-MM.jsonl (the data home's audit/ folder)
//
// Contract (https://code.claude.com/docs/en/hooks):
// - stdin: one JSON object {session_id, cwd, hook_event_name, tool_name, tool_input, agent_id?, agent_type?, ...}
// - PreToolUse decision: exit 0 + stdout {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}
// - exit 2 = blocking error (stderr goes to Claude). Used for fail-closed paths.
// - exit 0 with no output = "no decision" (normal permission flow applies).
//
// HONESTY NOTE: hooks are best-effort defence in depth. The boundary is the WebAuthn-verified human approval
// checked by the server, plus the tool lists the server passes (--tools / --allowedTools / --disallowedTools).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Read and parse the hook input. Throws on empty or invalid JSON. Strips a UTF-8 BOM. */
export function readInput() {
  const raw = readFileSync(0, "utf8").replace(/^﻿/, "");
  if (!raw || !raw.trim()) throw new Error("empty hook input");
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== "object") throw new Error("hook input is not an object");
  return obj;
}

/** The application folder (server-provided), or undefined. */
export function appRoot() {
  const r = process.env.COORD_APP_ROOT;
  return r && path.isAbsolute(r) ? path.resolve(r) : undefined;
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

function readJsonIfExists(p) {
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * coordinator.config.json overlaid by coordinator.config.local.json (in the application folder). The autonomy
 * level is the MINIMUM of both. Throws if either file exists but is not valid JSON. No app root → defaults.
 */
export function loadConfig(root = appRoot()) {
  if (!root) return { autonomy: { level: 1 }, foreignMcp: {} };
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

/** Spanish prefix for every refusal so the coordinator sees where it came from. */
export const TAG = "[guardia coordinador]";
