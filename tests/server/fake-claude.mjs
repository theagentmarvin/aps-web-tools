// Fake `claude` binary for the chat tests (selected with COORD_CLAUDE_BIN / resolveBin).
// FAKE_CLAUDE_MODE: ok | notlogged | slow | mcpdown | manytools | resume_missing | preamble
// FAKE_CLAUDE_AUTH=out → `auth status` reports logged out. FAKE_CLAUDE_LOG: JSONL of {args, prompt}.
// FAKE_PROPOSAL_ID: id returned by the fake propose_group_action tool result.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";

if (args[0] === "--version") {
  process.stdout.write("2.1.267 (Claude Code)\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  if (process.env.FAKE_CLAUDE_AUTH === "out") {
    process.stdout.write(JSON.stringify({ loggedIn: false }) + "\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "persona@example.com", orgName: "Org" }) + "\n");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt }) + "\n");
  const at = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
  const session = at("--session-id") ?? at("--resume");
  const init = (status = "connected") => out({ type: "system", subtype: "init", session_id: session, mcp_servers: [{ name: "coord", status }], tools: [] });
  const delta = (text) => out({ type: "stream_event", session_id: session, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  const result = (text, extra = {}) => out({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0123, session_id: session, result: text, ...extra });

  if (mode === "resume_missing" && at("--resume")) {
    process.stderr.write(`No conversation found with session ID: ${at("--resume")}\n`);
    process.exit(1);
  }
  if (mode === "notlogged") {
    out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: session });
    process.exit(1);
  }
  if (mode === "mcpdown") {
    init("failed");
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === "slow") {
    init();
    delta("Pensando…");
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === "manytools") {
    init();
    for (let i = 0; i < 30; i++) out({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: `t${i}`, name: "mcp__coord__get_group", input: { groupId: "G-0000000000" } }] } });
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === "preamble") {
    // G12: an English preamble before a tool call, then the Spanish answer (real stream_event shape).
    const ev = (event) => out({ type: "stream_event", session_id: session, event });
    init();
    ev({ type: "message_start" });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll check the family's " } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "details first." } });
    ev({ type: "content_block_stop", index: 0 });
    ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu9", name: "mcp__coord__get_family", input: {} } });
    ev({ type: "message_delta", delta: { stop_reason: "tool_use" } });
    out({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "tu9", name: "mcp__coord__get_family", input: { familyId: "F-aaaaaaaaaa" } }] } });
    out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "tu9", content: [{ type: "text", text: "{\"ok\":true,\"data\":{}}" }] }] } });
    ev({ type: "message_start" });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reviso el grupo…" } });
    ev({ type: "content_block_stop", index: 0 });
    ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu10", name: "mcp__coord__get_group", input: {} } });
    ev({ type: "message_delta", delta: { stop_reason: "tool_use" } });
    out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "tu10", content: [{ type: "text", text: "{\"ok\":true,\"data\":{}}" }] }] } });
    ev({ type: "message_start" });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "El grupo es un **Conflicto**: el ducto CLI cruza la viga EST." } });
    ev({ type: "content_block_stop", index: 0 });
    ev({ type: "message_delta", delta: { stop_reason: "end_turn" } });
    result("El grupo es un **Conflicto**: el ducto CLI cruza la viga EST.");
    process.exit(0);
  }
  if (mode === "flow") {
    // WS-N flow run: English preamble (dropped), a read, a created proposal, a report, a Spanish summary.
    const ev = (event) => out({ type: "stream_event", session_id: session, event });
    init();
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll check the groups first." } });
    ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "f1", name: "mcp__coord__get_group", input: {} } });
    out({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "f1", name: "mcp__coord__get_group", input: { groupId: "G-0000000000" } }] } });
    out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "f1", content: [{ type: "text", text: "{\"ok\":true,\"data\":{}}" }] }] } });
    const pid = process.env.FAKE_PROPOSAL_ID;
    if (pid) {
      out({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "f2", name: "mcp__coord__propose_classification", input: {} }] } });
      out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "f2", content: [{ type: "text", text: JSON.stringify({ ok: true, data: { proposalId: pid } }) }] }] } });
    }
    out({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "f3", name: "mcp__coord__generate_report", input: { kind: "weekly" } }] } });
    out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "f3", content: [{ type: "text", text: JSON.stringify({ ok: true, data: { path: "C:\\x\\reports\\demo\\2026-11-11-weekly-T-0000aaaa.html" } }) }] }] } });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Revisé las ubicaciones pendientes y dejé una propuesta para tu revisión.\n\nQueda el informe semanal listo en Informes." } });
    ev({ type: "message_delta", delta: { stop_reason: "end_turn" } });
    out({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.42, session_id: session, result: "ok" });
    process.exit(0);
  }
  if (mode === "chat_flow") {
    // WS-N chat turn: get_next_steps then start_flow (FAKE_FLOW_RUN_ID).
    init();
    out({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "c1", name: "mcp__coord__get_next_steps", input: {} }] } });
    out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: JSON.stringify({ ok: true, data: { projectId: "demo-proyecto", steps: [{ id: "x", title: "texto del modelo" }] } }) }] }] } });
    const run = process.env.FAKE_FLOW_RUN_ID;
    if (run) {
      out({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "c2", name: "mcp__coord__start_flow", input: { flowId: "triage" } }] } });
      out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "c2", content: [{ type: "text", text: JSON.stringify({ ok: true, data: { runId: run, state: "queued" } }) }] }] } });
    }
    delta("Inicié la revisión IA de lo pendiente.");
    result("Inicié la revisión IA de lo pendiente.");
    process.exit(0);
  }
  init();
  delta("Hola, ");
  delta("revisé la selección. Ver P-20991231-0001 (texto del modelo, no es una propuesta).");
  const pid = process.env.FAKE_PROPOSAL_ID;
  if (pid) {
    out({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__coord__propose_group_action", input: { action: { type: "merge_families", familyIds: ["F-aaaaaaaaaa", "F-bbbbbbbbbb"] } } }] } });
    out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: JSON.stringify({ ok: true, data: { proposalId: pid, kind: "group_action" } }) }] }] } });
    // A read tool whose result mentions an id must not create a card.
    out({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "tu2", name: "mcp__coord__list_proposals", input: {} }] } });
    out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: [{ type: "text", text: JSON.stringify({ ok: true, data: { proposalId: "P-20991231-0002" } }) }] }] } });
  }
  result("Hola, revisé la selección.");
  process.exit(0);
});
