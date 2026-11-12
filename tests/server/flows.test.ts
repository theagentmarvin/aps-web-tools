/**
 * WS-N domain flows (docs/domain/next-steps-and-flows.md): catalog and flow agent tool lists, the
 * start_flow availability matrix (chat yes; main / subagents / flow agent no), the runner with a FAKE
 * `claude` binary (tests/server/fake-claude.mjs), one-per-project, the agent daily cap, cancel,
 * audit, the chat "Flujo" card and the HTTP routes (CSRF).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatEvent, FlowEvent } from "../../server/api/contract";
import { materializeRuntime } from "../../server/agent-runtime";
import { createCoordApi } from "../../server/api/router";
import { parseAgentFile } from "../../server/chat/agent";
import { chatAllowedTools, headlessArgs, mcpConfigJson } from "../../server/chat/bridge";
import { ChatService } from "../../server/chat/service";
import { Coordinator } from "../../server/coordinator";
import { FLOW_AGENT, FLOW_AGENT_MISSING, flowAllowedTools, flowBuiltins, flowDisallowed, flowPrompt, loadFlowAgent, skillBody } from "../../server/flows/agent";
import { FLOW_FORBIDDEN, FLOWS } from "../../server/flows/catalog";
import { requestFlowRun } from "../../server/flows/request";
import { FlowService } from "../../server/flows/service";
import { FlowRunStore } from "../../server/flows/store";
import { toolInMode, TOOLS } from "../../server/mcp/contracts";
import { createCoordServer } from "../../server/mcp/server";
import { FixtureSource } from "../../server/source/fixtures";
import { HUMAN, ingest, makeCoord, ROOT, tempHome, testConfig } from "./helpers";

const FAKE = join(ROOT, "tests", "server", "fake-claude.mjs");
const fakeBin = () => ({ command: process.execPath, prefixArgs: [FAKE] });
const FLOW_AGENT_SRC = join(ROOT, "agent-runtime", "agents", "coordinador-flujos.md");
const PROJECT = "demo-proyecto";
/** Never reachable by any flow (ACC writes, approvals, rules publication, agent install, recursion). */
const DANGEROUS = /apply|approve|sign|publish|revert|install|harness|setup|start_flow|get_flow_status/i;

let coord: Coordinator;
let home: string;
let cleanup: () => void;
let testKey: string;
let agentRoot: string;
let runtimeBase: string;
/** The app's own agent-runtime/, materialised once (skills + agents as the flows see them). */
let rootRuntime: string;

/** An app-like root whose agent-runtime/ ships the flow agent and one SKILL.md per flow. */
function makeAgentRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "coord-flows-root-"));
  mkdirSync(join(root, "agent-runtime", "agents"), { recursive: true });
  copyFileSync(FLOW_AGENT_SRC, join(root, "agent-runtime", "agents", "coordinador-flujos.md"));
  for (const f of FLOWS) {
    mkdirSync(join(root, "agent-runtime", "skills", f.skill), { recursive: true });
    writeFileSync(join(root, "agent-runtime", "skills", f.skill, "SKILL.md"), `---\nname: ${f.skill}\n${f.skill === "curar-reglas" ? "agent: rules-curator\n" : ""}---\n\n# ${f.label}\n\nArgumentos: $ARGUMENTS\n`);
  }
  return root;
}

function collect(flows: FlowService, runId: string): Promise<FlowEvent[]> {
  return new Promise((resolve) => {
    const ev: FlowEvent[] = [];
    void flows.subscribe(runId, (e, last) => {
      ev.push(e);
      if (last) resolve(ev);
    });
  });
}

async function engineAgreeingProposal(): Promise<string> {
  const { cls } = await coord.requireClassified(testKey);
  const g = cls.groups.find((x) => x.validity === "real") ?? cls.groups[0]!;
  const p = await coord.proposeClassification({ testKey, target: { groupId: g.id }, validity: g.validity, disagreesWithEngine: false, rationale: "Coincide con el motor.", evidence: [], confidence: "media" });
  return p.proposalId;
}

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  cleanup = t.cleanup;
  coord = makeCoord(home);
  testKey = await ingest(coord, 42);
  agentRoot = makeAgentRoot();
  runtimeBase = mkdtempSync(join(tmpdir(), "coord-flows-rt-"));
  rootRuntime = materializeRuntime({ appRoot: ROOT, base: runtimeBase })!.dir;
}, 120_000);
afterAll(() => {
  cleanup();
  rmSync(agentRoot, { recursive: true, force: true });
  rmSync(runtimeBase, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_PROPOSAL_ID;
  delete process.env.FAKE_FLOW_RUN_ID;
});

describe("flow catalog and the flow agent's tool lists", () => {
  const staged = parseAgentFile(readFileSync(FLOW_AGENT_SRC, "utf8"));

  it("every catalog flow maps to a real skill and lists only tools the flow agent has", () => {
    expect(FLOWS.map((f) => f.id)).toEqual(["preparar-ciclo", "triage", "acta", "redactar-issues", "informe-semanal", "auditar-modelo", "curar-reglas"]);
    for (const f of FLOWS) {
      expect(skillBody(rootRuntime, f.skill), f.skill).toBeDefined();
      expect(f.tools.filter((t) => !staged.tools.includes(t)), f.id).toEqual([]);
      expect(f.tools.filter((t) => DANGEROUS.test(t)), f.id).toEqual([]);
      expect(f.costCapUsd).toBeGreaterThan(0);
      expect(f.costCapUsd).toBeLessThanOrEqual(5);
    }
  });

  it("the flow agent never gets apply, flow recursion, shell, edits, web or Skill", () => {
    for (const t of ["mcp__coord__apply_approved_proposals", "mcp__coord__start_flow", "mcp__coord__get_flow_status", "Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Skill"]) {
      expect(staged.tools).not.toContain(t);
      expect(staged.disallowedTools).toContain(t);
      expect(flowDisallowed(staged)).toContain(t);
    }
    expect(staged.tools.filter((t) => DANGEROUS.test(t))).toEqual([]);
    for (const f of FLOWS) {
      const allowed = flowAllowedTools(staged, f);
      expect(allowed.filter((t) => FLOW_FORBIDDEN.includes(t) || DANGEROUS.test(t)), f.id).toEqual([]);
      expect(flowBuiltins(allowed).every((t) => ["Agent", "Read", "Grep", "Glob"].includes(t))).toBe(true);
      // Agent only when the flow delegates to a subagent.
      expect(allowed.includes("Agent")).toBe(f.subagents.length > 0);
    }
  });

  it("spawn args: flow agent by name, read-only built-ins, flow-mode MCP, apply denied", () => {
    const def = FLOWS.find((f) => f.id === "triage")!;
    const agent = staged;
    const allowed = flowAllowedTools(agent, def);
    const args = headlessArgs({ agentName: FLOW_AGENT, agent, mcpConfig: mcpConfigJson({ root: ROOT, dataSource: "fixtures", homeOverride: home, mode: "flow" }), sessionId: "s", resume: false, builtinTools: flowBuiltins(allowed), allowedTools: allowed, disallowedTools: flowDisallowed(agent), budgetUsd: def.costCapUsd });
    const at = (f: string) => args[args.indexOf(f) + 1]!;
    expect(at("--agent")).toBe("coordinador-flujos");
    expect(args).not.toContain("--agents"); // by name from the runtime folder, never inline
    expect(at("--tools").split(",").sort()).toEqual(["Agent", "Glob", "Grep", "Read"]);
    expect(at("--disallowedTools")).toContain("mcp__coord__apply_approved_proposals");
    expect(at("--allowedTools")).not.toMatch(DANGEROUS);
    expect(at("--max-budget-usd")).toBe(String(def.costCapUsd));
    expect(JSON.parse(at("--mcp-config")).mcpServers.coord.env).toEqual({ COORD_FLOW: "1", COORDINATOR_HOME: home, COORD_DATA_SOURCE: "fixtures" });
  });

  it("the flow prompt carries server context and the skill, never the starter's reason", () => {
    const def = FLOWS.find((f) => f.id === "curar-reglas")!;
    const p = flowPrompt(def, { runId: "FR-20261111-abcdef", projectId: PROJECT, testKey: "T-00000000" }, { body: "Haz $ARGUMENTS", agent: "rules-curator" });
    expect(p).toContain('"flujo":"curar-reglas"');
    expect(p).toContain("Haz demo-proyecto T-00000000");
    expect(p).toContain("rules-curator");
    expect(p).not.toContain("motivo");
  });

  it("the flow agent comes only from the materialised runtime (no fallback to .claude/ or a staging copy)", () => {
    const rt = materializeRuntime({ appRoot: agentRoot, base: runtimeBase })!;
    expect(loadFlowAgent(rt.dir)?.source).toBe("runtime");
    expect(loadFlowAgent(agentRoot)).toBeUndefined(); // the app folder itself is not a runtime
    const legacyOnly = mkdtempSync(join(tmpdir(), "coord-flows-legacy-"));
    mkdirSync(join(legacyOnly, ".claude", "agents"), { recursive: true });
    copyFileSync(FLOW_AGENT_SRC, join(legacyOnly, ".claude", "agents", "coordinador-flujos.md"));
    expect(materializeRuntime({ appRoot: legacyOnly, base: runtimeBase })).toBeUndefined();
    rmSync(legacyOnly, { recursive: true, force: true });
  });
});

describe("start_flow availability matrix", () => {
  async function toolNames(opts: { chat?: boolean; flow?: boolean }) {
    const server = createCoordServer(coord, { ...opts, audit: false });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => t.name);
  }

  it("chat: start_flow + get_flow_status; main (VS Code + subagents) and flow (flow agent + subagents): neither", async () => {
    const main = await toolNames({ chat: false, flow: false });
    const chat = await toolNames({ chat: true });
    const flow = await toolNames({ flow: true });
    expect(chat).toEqual(expect.arrayContaining(["start_flow", "get_flow_status", "get_next_steps"]));
    expect(main).not.toContain("start_flow");
    expect(main).not.toContain("get_flow_status");
    expect(flow).not.toContain("start_flow");
    expect(flow).not.toContain("get_flow_status");
    expect(flow).not.toContain("apply_approved_proposals");
    expect(chat).not.toContain("apply_approved_proposals");
    expect(main).toContain("get_next_steps");
    expect(flow).toContain("get_next_steps");
    // Flow wins over chat when both are set (stricter).
    expect(await toolNames({ chat: true, flow: true })).not.toContain("start_flow");
    expect(TOOLS.filter((t) => toolInMode(t, "chat")).map((t) => t.name)).toContain("start_flow");
  });

  it("no subagent definition and not the flow agent list a flow tool; the chat may", () => {
    const dir = join(ROOT, "agent-runtime", "agents");
    const files = readdirSync(dir).filter((x) => x.endsWith(".md") && x !== "coordinador-chat.md");
    expect(files.sort()).toEqual(["clash-triager.md", "coordinador-flujos.md", "issue-writer.md", "model-hygiene-auditor.md", "rules-curator.md"]);
    for (const f of files) {
      const def = parseAgentFile(readFileSync(join(dir, f), "utf8"));
      expect(def.tools.filter((t) => /start_flow|get_flow_status|apply_approved_proposals/.test(t)), f).toEqual([]);
      expect(def.disallowedTools, f).toContain("mcp__coord__apply_approved_proposals");
    }
    const chat = parseAgentFile(readFileSync(join(dir, "coordinador-chat.md"), "utf8"));
    const allowed = chatAllowedTools(chat);
    for (const t of ["start_flow", "get_flow_status", "get_next_steps", "propose_discipline_mapping", "generate_report", "propose_rule_change", "get_rule_insights", "list_feedback"]) expect(allowed).toContain(`mcp__coord__${t}`);
    expect(allowed.filter((t) => /apply|approve|publish|revert|install|harness|ingest|run_classification/.test(t))).toEqual([]);
    // get_rule_insights listed once (front matter reproduced exactly).
    expect(chat.tools.filter((t) => t === "mcp__coord__get_rule_insights")).toHaveLength(1);
    expect(chat.disallowedTools).not.toContain("mcp__coord__propose_rule_change");
  });

  it("chat-mode start_flow refuses unknown flows", async () => {
    const server = createCoordServer(coord, { chat: true, audit: false });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const call = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: "start_flow", arguments: args })).content as Array<{ text: string }>)[0]!.text);
    expect(typeof call).toBe("function");
    // Outside the catalog: rejected by the input schema (enum) before any handler runs.
    const bad = (await client.callTool({ name: "start_flow", arguments: { flowId: "aplicar-lote", projectId: PROJECT, reason: "x" } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/flowId|invalid/i);
    await client.close();
  });
});

describe("flow runs: one per project, agent daily cap, chat start", () => {
  it("start_flow (chat mode, flow agent installed) queues a run tagged agent:chat; a second is refused; the daily cap holds", async () => {
    const { home: h, cleanup: c } = tempHome();
    try {
      const base = makeCoord(h, { config: testConfig({ flows: { dailyAgentCap: 2 } }) });
      const tk = await ingest(base, 42);
      // Same data home, an app root whose agent-runtime/ ships the flow agent.
      const chatCoord = new Coordinator({ root: agentRoot, home: h, dataSource: "fixtures", source: new FixtureSource({ home: h }), config: testConfig({ flows: { dailyAgentCap: 2 } }) });
      const server = createCoordServer(chatCoord, { chat: true, audit: false });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: "t", version: "0" });
      await client.connect(b);
      const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text);
      const r1 = await call("start_flow", { flowId: "triage", projectId: PROJECT, reason: "Hay ubicaciones sin revisar." });
      expect(r1.ok).toBe(true);
      expect(r1.data).toMatchObject({ state: "queued", flowId: "triage", startedBy: "agent:chat", testKey: tk });
      const st = await call("get_flow_status", { runId: r1.data.runId });
      expect(st.data.state).toBe("queued");
      const r2 = await call("start_flow", { flowId: "acta", projectId: PROJECT, reason: "Notas." });
      expect(r2.ok).toBe(false);
      expect(r2.error.message).toMatch(/Ya hay un flujo en curso/);
      // Cancel the first (queued: at once), then the cap (2/day) allows one more and refuses the third.
      const flows = new FlowService(chatCoord, { resolveBin: fakeBin, agentRoot });
      expect(await flows.cancel(r1.data.runId, { type: "user", id: "u", name: "Coordinador" })).toEqual({ cancelled: true });
      const r3 = await call("start_flow", { flowId: "acta", projectId: PROJECT, reason: "Notas." });
      expect(r3.ok).toBe(true);
      await flows.cancel(r3.data.runId, { type: "user", id: "u", name: "Coordinador" });
      const r4 = await call("start_flow", { flowId: "acta", projectId: PROJECT, reason: "Notas." });
      expect(r4.ok).toBe(false);
      expect(r4.error.message).toMatch(/máximo 2/);
      // Humans are not capped.
      const human = await requestFlowRun(chatCoord, { flowId: "acta", projectId: PROJECT, startedBy: "human" });
      expect(human.startedBy).toBe("human");
      const audit = await chatCoord.store.listAudit();
      expect(audit.filter((e) => e.action === "flow.cancelled").length).toBe(2);
      expect(JSON.stringify(audit.filter((e) => e.action.startsWith("flow.")))).not.toContain(HUMAN.name);
      await client.close();
    } finally {
      c();
    }
  }, 120_000);
});

describe("flow runner with a fake claude", () => {
  it("human start: runs, streams log (no English preamble), counts verified proposals and reports, audits", async () => {
    const pid = await engineAgreeingProposal();
    process.env.FAKE_CLAUDE_MODE = "flow";
    process.env.FAKE_PROPOSAL_ID = pid;
    const flog = join(home, "fake-flow.jsonl");
    process.env.FAKE_CLAUDE_LOG = flog;
    const flows = new FlowService(coord, { resolveBin: fakeBin, agentRoot });
    const run = await flows.start("triage", { projectId: PROJECT, testKey, reason: "Qué sigue: revisión IA." }, HUMAN);
    expect(run).toMatchObject({ state: "queued", startedBy: "human", testKey, flowId: "triage" });
    const ev = await collect(flows, run.runId);
    const done = ev.at(-1)!;
    expect(done.type).toBe("done");
    const view = (done as Extract<FlowEvent, { type: "done" }>).run;
    expect(view.state).toBe("finished");
    expect(view.proposalIds).toEqual([pid]);
    expect(view.outcome).toMatchObject({ proposals: 1, reports: ["2026-11-11-weekly-T-0000aaaa.html"] });
    expect(view.costUsd).toBe(0.42);
    const text = view.log.map((l) => l.text).join("\n");
    expect(text).not.toMatch(/I'll check/);
    expect(text).toContain("Revisé las ubicaciones pendientes");
    expect(view.summary).toContain("informe semanal");
    // Spawned in the materialised runtime of the app root (flow agent + skills there), outside repo and data home.
    const spawned = JSON.parse(readFileSync(flog, "utf8").trim().split("\n").at(-1)!) as { cwd: string; args: string[]; env: Record<string, string | null> };
    delete process.env.FAKE_CLAUDE_LOG;
    expect(existsSync(join(spawned.cwd, ".claude", "agents", "coordinador-flujos.md"))).toBe(true);
    expect(existsSync(join(spawned.cwd, ".claude", "skills", "triage", "SKILL.md"))).toBe(true);
    expect(spawned.cwd.toLowerCase().startsWith(agentRoot.toLowerCase())).toBe(false);
    expect(spawned.cwd.toLowerCase().startsWith(home.toLowerCase())).toBe(false);
    expect(spawned.env.COORD_APP_ROOT).toBe(coord.root);
    expect(spawned.args[spawned.args.indexOf("--agent") + 1]).toBe("coordinador-flujos");
    // Persisted run + event log; GET after the end replays the stored events.
    const stored = await flows.runs.get(run.runId);
    expect(stored).toMatchObject({ state: "finished", startedBy: "human" });
    expect((await flows.runs.events(run.runId)).some((e) => e.type === "created")).toBe(true);
    const audit = (await coord.store.listAudit()).filter((e) => e.targetIds.includes(run.runId));
    expect(audit.map((e) => e.action)).toEqual(["flow.started", "flow.finished"]);
    expect(audit[0]!.details.startedBy).toBe("human");
    expect(JSON.stringify(audit)).not.toContain(HUMAN.name);
  }, 60_000);

  it("cancel: SIGINT then SIGTERM; state cancelled and audited", async () => {
    process.env.FAKE_CLAUDE_MODE = "slow";
    const flows = new FlowService(coord, { resolveBin: fakeBin, agentRoot });
    const run = await flows.start("acta", { projectId: PROJECT, testKey }, HUMAN);
    const ev = collect(flows, run.runId);
    await new Promise((r) => setTimeout(r, 800));
    expect(await flows.cancel(run.runId, { type: "user", id: HUMAN.id, name: "Coordinador" })).toEqual({ cancelled: true });
    const out = await ev;
    expect(out.at(-1)).toMatchObject({ type: "error", code: "cancelled" });
    expect((await flows.runs.get(run.runId))!.state).toBe("cancelled");
    expect((await coord.store.listAudit()).some((e) => e.action === "flow.cancelled" && e.targetIds.includes(run.runId))).toBe(true);
  }, 60_000);

  it("refuses without the installed flow agent and for flows outside the catalog", async () => {
    const flows = new FlowService(coord, { resolveBin: fakeBin, agentRoot: mkdtempSync(join(tmpdir(), "coord-no-agent-")) });
    await expect(flows.start("triage", { projectId: PROJECT, testKey }, HUMAN)).rejects.toThrow(FLOW_AGENT_MISSING);
    expect((await flows.overview()).available).toBe(false);
    await expect(requestFlowRun(coord, { flowId: "apply", projectId: PROJECT, startedBy: "human" }, { agentRoot })).rejects.toThrow(/no está en el catálogo/);
  });

  it("picks up a run queued by the chat's MCP process and shows it as a Flujo card in the chat", async () => {
    process.env.FAKE_CLAUDE_MODE = "flow";
    const flows = new FlowService(coord, { resolveBin: fakeBin, agentRoot });
    const queued = await requestFlowRun(coord, { flowId: "informe-semanal", projectId: PROJECT, testKey, reason: "Fin de ciclo.", startedBy: "agent:chat" }, { agentRoot });
    expect(queued.state).toBe("queued");
    // The chat turn calls get_next_steps and start_flow (fake): the server recomputes the steps and picks the run.
    process.env.FAKE_CLAUDE_MODE = "chat_flow";
    process.env.FAKE_FLOW_RUN_ID = queued.runId;
    const chat = new ChatService(coord, { resolveBin: fakeBin, flows, nextSteps: async () => ({ computedAt: "", flowsAvailable: true, steps: [{ id: "a", kind: "ai_review", priority: 35, title: "Revisión IA", reason: "r", counts: {}, action: { type: "flow", flow: "triage", args: { projectId: PROJECT, testKey } } }] }) });
    const { messageId } = await chat.send({ testKey, message: "¿Qué sigue?" }, HUMAN);
    const ev = await new Promise<ChatEvent[]>((resolve) => {
      const out: ChatEvent[] = [];
      chat.subscribe(messageId, HUMAN, (e, last) => {
        out.push(e);
        if (last) resolve(out);
      });
    });
    const steps = ev.find((e) => e.type === "next_steps") as Extract<ChatEvent, { type: "next_steps" }>;
    expect(steps.steps.map((s) => s.title)).toEqual(["Revisión IA"]); // server data, not the tool text
    const card = ev.find((e) => e.type === "flow") as Extract<ChatEvent, { type: "flow" }>;
    expect(card.run.runId).toBe(queued.runId);
    expect(card.run.startedBy).toBe("agent:chat");
    const h = await chat.history(testKey, HUMAN);
    const last = h.messages.at(-1)!;
    expect(last.flowRunIds).toEqual([queued.runId]);
    expect(last.flows?.[0]?.runId).toBe(queued.runId);
    expect(last.nextSteps?.[0]?.kind).toBe("ai_review");
    // The run itself finishes (fake flow mode is not active now: the chat_flow fake just exits ok).
    const end = await collect(flows, queued.runId);
    expect(["done", "error"]).toContain(end.at(-1)!.type);
  }, 60_000);

  it("a queued run left behind expires instead of running later", async () => {
    const store = new FlowRunStore(coord.store);
    const flows = new FlowService(coord, { resolveBin: fakeBin, agentRoot });
    const r = await store.create({ flowId: "acta", label: "Pasar el acta", projectId: "otro-proyecto", startedBy: "agent:chat", costCapUsd: 1 }, { now: Date.now() - 11 * 60_000, dailyAgentCap: 100 });
    expect(await flows.pickup(r.runId)).toEqual([]);
    expect((await store.get(r.runId))!.state).toBe("failed");
  });
});

describe("HTTP /api/coord/flows and /next-steps", () => {
  let server: Server;
  let base: string;
  let origin: string;
  let csrf: string;
  let cookie: string;
  let h2: { home: string; cleanup: () => void };
  beforeAll(async () => {
    h2 = tempHome();
    const c2 = makeCoord(h2.home);
    await ingest(c2, 42);
    const api = createCoordApi({ coordinator: c2, flowPolling: false });
    server = createServer((rq, rs) => api.middleware(rq, rs));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}/api/coord`;
    origin = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/csrf`);
    csrf = ((await res.json()) as { token: string }).token;
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 120_000);
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    h2.cleanup();
  });

  it("POST /flows/:flowId/run needs CSRF; unknown flows are 400; GET routes read", async () => {
    const body = JSON.stringify({ projectId: PROJECT });
    const denied = await fetch(`${base}/flows/triage/run`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body });
    expect(denied.status).toBe(403);
    const headers = { "Content-Type": "application/json", Origin: origin, "X-Coord-CSRF": csrf, Cookie: cookie };
    const unknown = await fetch(`${base}/flows/aplicar/run`, { method: "POST", headers, body });
    expect(unknown.status).toBe(400);
    const cancel = await fetch(`${base}/flows/runs/FR-20261111-abcdef/cancel`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "{}" });
    expect(cancel.status).toBe(403);
    const ok = await fetch(`${base}/flows/triage/run`, { method: "POST", headers, body });
    // The repo root may or may not have the flow agent installed: either a queued run or the Spanish refusal.
    if (ok.status === 200) expect(((await ok.json()) as { state: string }).state).toBe("queued");
    else expect(((await ok.json()) as { error: { message: string } }).error.message).toContain("Actualiza el agente");
    const runs = (await (await fetch(`${base}/flows/runs?projectId=${PROJECT}`)).json()) as { catalog: unknown[]; dailyAgentCap: number };
    expect(runs.catalog).toHaveLength(7);
    expect(runs.dailyAgentCap).toBe(10);
    const steps = (await (await fetch(`${base}/next-steps?projectId=${PROJECT}`)).json()) as { steps: Array<{ kind: string; action: { type: string } }>; testKey: string };
    expect(steps.testKey).toMatch(/^T-/);
    expect(steps.steps.length).toBeGreaterThan(0);
    expect((await fetch(`${base}/flows/runs/FR-20261111-abcdef`)).status).toBe(404);
  }, 60_000);
});
