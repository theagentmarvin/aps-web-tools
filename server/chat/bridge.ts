/**
 * Chat bridge (docs/ai/chat-agent-design.md §1–§3): runs `coordinador-chat` as a local headless
 * Claude Code (`claude -p`) with the coordinator's own login, and turns its stream-json output into
 * ChatEvents. No shell; prompt on stdin; built-in tools off; only the coord MCP server.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type * as C from "../api/contract";
import { CHAT_AGENT, type ChatAgentDef } from "./agent";
import { NarrationFilter } from "./narration";

export const CHAT_TIMEOUT_MS = 120_000;
export const CHAT_TOOL_CAP = 25;
export const CHAT_PROPOSAL_CAP = 10;
export const CHAT_BUDGET_USD = 0.5;
export const SIGTERM_GRACE_MS = 5_000;

/** Tools the chat agent may never use (defence in depth: also absent from the agent's list). */
export const CHAT_DISALLOWED = ["mcp__coord__apply_approved_proposals", "mcp__coord__ingest_clash_test", "mcp__coord__run_classification", "Bash", "PowerShell", "Edit", "Write", "Read", "WebFetch", "WebSearch", "Agent", "Task", "Skill"];
/** Tool results that create something the human decides (cards). */
const CREATING = new Set(["propose_family_decision", "propose_classification", "propose_group_action", "propose_status_change", "draft_issue", "ask_coordinator", "propose_discipline_mapping", "propose_family_exception", "propose_issue_responsible", "propose_rule_change"]);
/**
 * Read-only coord tools the chat agent is pre-approved for (docs/ai/agent-human-parity.md §3.3).
 * Must stay a subset of the agent's front-matter `tools:` (tests/server/chat.test.ts checks it).
 * Batch reads are for the main agent and the chat only, never for subagents; no batch write exists.
 */
export const CHAT_READ_TOOLS = [
  "get_selection_context", "get_group", "get_family", "list_groups", "list_families", "list_clashes", "get_element_properties", "summarize_clashes", "list_proposals", "list_questions", "list_issue_checks",
  "get_session_status", "list_meeting_notes", "diff_test_versions", "list_disciplines", "get_model_hygiene_stats", "list_batches", "get_batch", "list_decisions", "get_agenda", "list_reminders", "get_issue_settings", "get_rule_insights",
  "get_next_steps", "get_flow_status",
].map((t) => `mcp__coord__${t}`);

export interface ResolvedBin {
  command: string;
  prefixArgs: string[];
}

/** COORD_CLAUDE_BIN (config) → `claude` on PATH → ~/.local/bin. Node scripts / npm .cmd shims run with this Node. */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env, configured?: string): ResolvedBin | undefined {
  const viaNode = (file: string): ResolvedBin => ({ command: process.execPath, prefixArgs: [file] });
  const fromFile = (f: string): ResolvedBin | undefined => {
    if (!existsSync(f)) return undefined;
    if (/\.(m?js|cjs)$/i.test(f)) return viaNode(f);
    if (/\.cmd$/i.test(f)) {
      const m = /"%(?:dp0|~dp0)%\\([^"]+\.js)"/i.exec(readFileSync(f, "utf8"));
      const js = m ? join(dirname(f), m[1]!) : undefined;
      return js && existsSync(js) ? viaNode(js) : undefined;
    }
    return { command: f, prefixArgs: [] };
  };
  const explicit = env.COORD_CLAUDE_BIN ?? configured;
  if (explicit) return fromFile(resolve(explicit));
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const n of names) {
      const r = fromFile(join(dir, n));
      if (r) return r;
    }
  }
  for (const n of names) {
    const r = fromFile(join(env.USERPROFILE ?? homedir(), ".local", "bin", n));
    if (r) return r;
  }
  return undefined;
}

/** Child environment (§1): no nested-session markers, no dev mode, no inspector; the login stays (HOME/APPDATA). */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID" || k === "CLAUDE_PROJECT_DIR" || k === "BUN_INSPECT" || k === "NODE_OPTIONS" || k === "COORD_HARNESS_DEV" || k === "ANTHROPIC_API_KEY") delete env[k];
  }
  return env;
}

/**
 * Environment of an in-app agent run: {@link childEnv} plus what the runtime hooks need
 * (agent-runtime/hooks/_lib.mjs): the application folder (coordinator.config*.json) and the data home's
 * audit folder for the agent-side audit mirror. CLAUDE_PROJECT_DIR is left to Claude Code (= the runtime cwd).
 */
export function agentEnv(opts: { appRoot: string; auditDir?: string }, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...childEnv(base), COORD_APP_ROOT: resolve(opts.appRoot), ...(opts.auditDir ? { COORD_AGENT_AUDIT_DIR: resolve(opts.auditDir) } : {}) };
}

/**
 * Inline MCP config: only the coord server, the same data source and home as this server.
 * mode "chat" → COORD_CHAT=1 (no apply; start_flow available); "flow" → COORD_FLOW=1 (no apply, no flow tools).
 */
export function mcpConfigJson(opts: { root: string; dataSource: "live" | "fixtures"; homeOverride?: string; mode?: "chat" | "flow" }): string {
  const env: Record<string, string> = opts.mode === "flow" ? { COORD_FLOW: "1" } : { COORD_CHAT: "1" };
  if (opts.homeOverride) env.COORDINATOR_HOME = opts.homeOverride;
  if (opts.dataSource === "fixtures") env.COORD_DATA_SOURCE = "fixtures";
  return JSON.stringify({ mcpServers: { coord: { command: process.execPath, args: ["--import", "tsx", join(opts.root, "server", "mcp", "index.ts")], env } } });
}

/**
 * Headless spawn args shared by the chat and the flows (§1): stream-json, strict MCP config, an explicit
 * built-in tool set (`--tools`), pre-approved tools, denied tools, dontAsk, no prompts, a USD cap.
 * The agent is used by name from the materialised runtime folder (the run's cwd; server/agent-runtime.ts).
 */
export function headlessArgs(opts: {
  agentName: string;
  agent: ChatAgentDef;
  mcpConfig: string;
  sessionId: string;
  resume: boolean;
  builtinTools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  budgetUsd: number;
  model?: string;
}): string[] {
  return [
    "-p",
    "--agent",
    opts.agentName,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId]),
    "--strict-mcp-config",
    "--mcp-config",
    opts.mcpConfig,
    "--tools",
    opts.builtinTools.join(","),
    "--allowedTools",
    opts.allowedTools.join(","),
    "--disallowedTools",
    [...new Set(opts.disallowedTools)].join(","),
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--max-budget-usd",
    String(opts.budgetUsd),
    ...(opts.model ? ["--model", opts.model] : []),
  ];
}

/** Spawn args of the chat (§1): no built-in tools at all. */
export function claudeArgs(opts: { agent: ChatAgentDef; mcpConfig: string; sessionId: string; resume: boolean; budgetUsd?: number; model?: string }): string[] {
  return headlessArgs({
    agentName: CHAT_AGENT,
    agent: opts.agent,
    mcpConfig: opts.mcpConfig,
    sessionId: opts.sessionId,
    resume: opts.resume,
    builtinTools: [],
    allowedTools: chatAllowedTools(opts.agent),
    disallowedTools: [...CHAT_DISALLOWED, ...opts.agent.disallowedTools],
    budgetUsd: opts.budgetUsd ?? CHAT_BUDGET_USD,
    ...(opts.model ? { model: opts.model } : {}),
  });
}

export interface AuthStatus {
  installed: boolean;
  version?: string;
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
}

/** Pre-flight (§1): `claude --version` + `claude auth status --json`. Never returns the email / org. */
export async function authStatus(bin: ResolvedBin | undefined, env: NodeJS.ProcessEnv = childEnv()): Promise<AuthStatus> {
  if (!bin) return { installed: false, loggedIn: false };
  const run = (args: string[]) =>
    new Promise<{ status: number; stdout: string; missing: boolean }>((done) =>
      execFile(bin.command, [...bin.prefixArgs, ...args], { env, shell: false, windowsHide: true, encoding: "utf8", timeout: 20_000 }, (err, stdout) =>
        done({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), missing: (err as NodeJS.ErrnoException | null)?.code === "ENOENT" }),
      ),
    );
  const v = await run(["--version"]);
  if (v.missing || v.status !== 0) return { installed: false, loggedIn: false };
  const version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1];
  const a = await run(["auth", "status", "--json"]);
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(a.stdout || "{}") as Record<string, unknown>;
  } catch {
    // not JSON: treat as logged out
  }
  return {
    installed: true,
    ...(version ? { version } : {}),
    loggedIn: a.status === 0 && j.loggedIn !== false,
    ...(typeof j.authMethod === "string" ? { authMethod: j.authMethod } : {}),
    ...(typeof j.subscriptionType === "string" ? { subscriptionType: j.subscriptionType } : {}),
  };
}

export class ChatRunError extends Error {
  constructor(readonly code: Extract<C.ChatEvent, { type: "error" }>["code"], message: string) {
    super(message);
  }
}

export interface RunResult {
  sessionId?: string;
  text: string;
  created: Array<{ id: string; tool: string }>;
  costUsd?: number;
  stoppedBy?: "timeout" | "tool_cap" | "proposal_cap" | "budget";
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("");
  return "";
}

/** Pre-approved coord tools: the agent's own list plus {@link CHAT_READ_TOOLS}, never a disallowed one. */
export function chatAllowedTools(agent: Pick<ChatAgentDef, "tools" | "disallowedTools">): string[] {
  const deny = new Set([...CHAT_DISALLOWED, ...agent.disallowedTools]);
  return [...new Set([...agent.tools.filter((t) => t.startsWith("mcp__coord__")), ...CHAT_READ_TOOLS])].filter((t) => !deny.has(t));
}

/** Created proposal / question id from a tool result envelope ({ok, data:{proposalId|questionId}}). */
export function createdId(tool: string, text: string): string | undefined {
  const name = tool.replace(/^mcp__coord__/, "");
  if (!CREATING.has(name)) return undefined;
  try {
    const env = JSON.parse(text) as { ok?: boolean; data?: Record<string, unknown> };
    if (env.ok === false) return undefined;
    const d = env.data ?? (env as Record<string, unknown>);
    const id = d.proposalId ?? d.questionId;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

const redact = (s: string) => s.replace(/(sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "[oculto]");

/** One message: spawn, stream, enforce the caps (SIGINT then SIGTERM), map errors. */
export function runClaude(opts: {
  bin: ResolvedBin;
  args: string[];
  cwd: string;
  prompt: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onEvent: (e: C.ChatEvent) => void;
  onChild?: (c: ChildProcess, stop: () => void) => void;
  /** A proposal / question id extracted from a tool result (deterministic, never from model text). */
  onCreated?: (c: { id: string; tool: string }) => void;
  /** Every successful tool result (tool name without prefix + raw text), e.g. start_flow → runId. */
  onToolResult?: (tool: string, text: string) => void;
  /** Caps (defaults: the chat's). */
  toolCap?: number;
  proposalCap?: number;
}): Promise<RunResult> {
  const toolCap = opts.toolCap ?? CHAT_TOOL_CAP;
  const proposalCap = opts.proposalCap ?? CHAT_PROPOSAL_CAP;
  return new Promise((done, fail) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.bin.command, [...opts.bin.prefixArgs, ...opts.args], { cwd: opts.cwd, env: opts.env ?? childEnv(), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      fail(new ChatRunError("claude_not_found", `Claude Code no está instalado (https://code.claude.com): ${(err as Error).message}`));
      return;
    }
    const res: RunResult = { text: "", created: [] };
    // G12 safety net: English or narrating preambles before a tool call are not shown.
    const narration = new NarrationFilter((t) => {
      res.text += t;
      opts.onEvent({ type: "delta", text: t });
    });
    const tools = new Map<string, string>();
    let toolCalls = 0;
    let stderr = "";
    let buf = "";
    let gotResult = false;
    let resultErr: string | undefined;
    let notLogged = false;
    let mcpDown = false;
    let finished = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (why?: RunResult["stoppedBy"]) => {
      if (why && !res.stoppedBy) res.stoppedBy = why;
      if (!why) cancelled = true;
      child.kill("SIGINT");
      killTimer ??= setTimeout(() => child.kill("SIGTERM"), SIGTERM_GRACE_MS);
    };
    opts.onChild?.(child, () => stop());
    const timer = setTimeout(() => stop("timeout"), opts.timeoutMs ?? CHAT_TIMEOUT_MS);
    const end = (err?: ChatRunError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (err) fail(err);
      else done(res);
    };
    const handle = (line: string) => {
      let ev: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof ev.session_id === "string") res.sessionId = ev.session_id;
      switch (ev.type) {
        case "system":
          if (ev.subtype === "init") {
            const coord = (ev.mcp_servers ?? []).find((s: { name?: string }) => s.name === "coord");
            if (coord && coord.status !== "connected") {
              mcpDown = true;
              stop();
            } else opts.onEvent({ type: "status", phase: "thinking" });
          } else if (ev.subtype === "api_retry") opts.onEvent({ type: "status", phase: "retrying", detail: `intento ${ev.attempt ?? "?"}` });
          break;
        case "rate_limit_event":
          if (ev.rate_limit_info?.status && ev.rate_limit_info.status !== "allowed") opts.onEvent({ type: "status", phase: "rate_limited", ...(ev.rate_limit_info.resetsAt ? { detail: String(ev.rate_limit_info.resetsAt) } : {}) });
          break;
        case "stream_event": {
          if (ev.parent_tool_use_id) break;
          const d = ev.event?.delta;
          const t = ev.event?.type;
          // Segment boundaries (the filter keeps paragraphs apart): a tool call next → the held text was a preamble.
          if (t === "content_block_start") narration.end(ev.event.content_block?.type === "tool_use");
          else if (t === "message_delta" && d?.stop_reason) narration.end(d.stop_reason === "tool_use");
          else if (t === "content_block_delta" && d?.type === "text_delta" && typeof d.text === "string") narration.push(d.text);
          break;
        }
        case "assistant": {
          if (ev.error === "authentication_failed") notLogged = true;
          if (!ev.parent_tool_use_id && (ev.message?.content ?? []).some((b: { type?: string }) => b?.type === "tool_use")) narration.end(true);
          for (const b of ev.message?.content ?? []) {
            if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
            tools.set(String(b.id), b.name);
            toolCalls++;
            const target = JSON.stringify(b.input ?? {}).match(/"((?:F|G)-[0-9A-Za-z]{6,16}|P-\d{8}-\d{4})"/)?.[1];
            opts.onEvent({ type: "tool", name: b.name.replace(/^mcp__coord__/, ""), ...(target ? { target } : {}) });
            if (toolCalls > toolCap) stop("tool_cap");
          }
          break;
        }
        case "user":
          for (const b of ev.message?.content ?? []) {
            if (b?.type !== "tool_result" || b.is_error) continue;
            const tool = tools.get(String(b.tool_use_id));
            const text = resultText(b.content);
            if (tool) {
              try {
                opts.onToolResult?.(tool.replace(/^mcp__coord__/, ""), text);
              } catch {
                // a listener error must not stop the run
              }
            }
            const id = tool ? createdId(tool, text) : undefined;
            if (id && !res.created.some((c) => c.id === id)) {
              const c = { id, tool: tool!.replace(/^mcp__coord__/, "") };
              res.created.push(c);
              opts.onCreated?.(c);
              if (res.created.length >= proposalCap) stop("proposal_cap");
            }
          }
          break;
        case "result":
          gotResult = true;
          narration.end(false);
          if (typeof ev.total_cost_usd === "number") res.costUsd = ev.total_cost_usd;
          if (ev.is_error) {
            resultErr = String(ev.result ?? ev.subtype ?? "error");
            if (/not logged in|\/login/i.test(resultErr)) notLogged = true;
            if (/budget/i.test(String(ev.subtype ?? "") + resultErr)) res.stoppedBy ??= "budget";
          }
          if (!res.text && typeof ev.result === "string" && !ev.is_error) {
            res.text = ev.result;
            opts.onEvent({ type: "delta", text: ev.result });
          }
          break;
      }
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handle(line);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (s: string) => (stderr = (stderr + s).slice(-4000)));
    child.on("error", (err: NodeJS.ErrnoException) =>
      end(new ChatRunError(err.code === "ENOENT" ? "claude_not_found" : "failed", err.code === "ENOENT" ? "Claude Code no está instalado (https://code.claude.com)." : `Claude Code falló: ${err.message}`)),
    );
    child.on("close", (code) => {
      if (buf.trim()) handle(buf.trim());
      narration.end(false);
      if (cancelled && !mcpDown) return end(new ChatRunError("cancelled", "Cancelado."));
      if (mcpDown) return end(new ChatRunError("mcp_unavailable", "No se pudo iniciar el servidor de coordinación."));
      if (notLogged) return end(new ChatRunError("not_logged_in", "Claude Code no tiene sesión iniciada. Abre una terminal y ejecuta `claude`, luego `/login`."));
      // Caps: the turn was stopped on purpose; keep what was produced.
      if (res.stoppedBy) return end();
      if (code === 143) return end(new ChatRunError("cancelled", "Cancelado."));
      if (resultErr) return end(new ChatRunError("failed", `El agente terminó con error: ${redact(resultErr).slice(0, 300)}`));
      if (code !== 0 && !gotResult) return end(new ChatRunError("failed", `Claude Code terminó con código ${code}: ${redact(stderr).slice(-300)}`));
      end();
    });
    child.stdin!.end(opts.prompt);
  });
}
