// PostToolUse audit mirror for mcp__coord__* calls (agent-side record; the MCP server keeps the
// authoritative HMAC-chained audit in .coordinator/audit/audit.jsonl). Appends one JSON line to
// .coordinator/audit/agent-YYYY-MM.jsonl. Unchanged in v2.
// Never blocks and never fails the tool call: every error is swallowed (exit 0).
// Does NOT log tool responses (they can be large and carry untrusted model text), only their size.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readInput, projectRoot } from "./_lib.mjs";

const SECRET_KEY = /token|secret|password|authorization|apikey|api_key|cookie|hmac|signature/i;
const MAX_STR = 200;

function redact(v, depth = 0) {
  if (depth > 6) return "[depth]";
  if (typeof v === "string") return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…[${v.length}]` : v;
  if (Array.isArray(v)) {
    const head = v.slice(0, 25).map((x) => redact(x, depth + 1));
    return v.length > 25 ? [...head, `…[+${v.length - 25}]`] : head;
  }
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(x, depth + 1);
    return out;
  }
  return v;
}

try {
  const input = readInput();
  const name = String(input.tool_name ?? "");
  if (name.startsWith("mcp__coord__")) {
    const resp = input.tool_response;
    let respText = "";
    try {
      respText = typeof resp === "string" ? resp : JSON.stringify(resp ?? "");
    } catch {
      respText = "";
    }
    const isError =
      Boolean(resp && typeof resp === "object" && (resp.isError === true || resp.is_error === true)) ||
      /"ok"\s*:\s*false/.test(respText.slice(0, 2000));
    const now = new Date();
    const line = {
      ts: now.toISOString(),
      session_id: input.session_id,
      agent_id: input.agent_id ?? null,
      agent_type: input.agent_type ?? null,
      tool_name: name,
      tool_use_id: input.tool_use_id,
      input: redact(input.tool_input ?? {}),
      response_chars: respText.length,
      ok: !isError,
      fixture_mode: process.env.COORD_DATA_SOURCE === "fixtures" || undefined,
    };
    const dir = join(projectRoot(input), ".coordinator", "audit");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `agent-${now.toISOString().slice(0, 7)}.jsonl`);
    appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  }
} catch {
  // never interfere with the session
}
process.exit(0);
