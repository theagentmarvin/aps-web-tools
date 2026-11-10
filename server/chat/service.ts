/**
 * Chat panel service (docs/ai/chat-agent-design.md): one session per (user, project, model set,
 * test), at most one running message per session. POST creates a message and returns its id; the
 * events are buffered so `GET /chat/:messageId/events` can replay them (late subscriber, reconnect).
 * The agent runs as a local headless Claude Code (`claude -p`) with the coordinator's own login.
 */
import { randomUUID } from "node:crypto";
import type * as C from "../api/contract";
import { proposalSummary, type Coordinator } from "../coordinator";
import { sanitizeModelText } from "../sanitize";
import { bareProjectId, CoordError, log, nowIso } from "../util";
import { loadChatAgent, type ChatAgentDef } from "./agent";
import { authStatus, ChatRunError, childEnv, claudeArgs, mcpConfigJson, resolveClaudeBin, runClaude, type AuthStatus, type ResolvedBin } from "./bridge";
import { chatPrompt, contextBlock } from "./context";
import { ChatStore, type StoredChatSession } from "./store";

export const CHAT_MESSAGE_MAX = 4000;
/** Pre-flight cache: a positive `claude auth status` for 5 min, a negative one briefly (the user may log in). */
const AUTH_TTL_MS = 5 * 60_000;
const AUTH_NEG_TTL_MS = 15_000;
/** Finished messages stay replayable this long. */
const KEEP_FINISHED_MS = 10 * 60_000;

type Listener = (e: C.ChatEvent, last: boolean) => void;
type ErrorCode = Extract<C.ChatEvent, { type: "error" }>["code"];

interface MessageRun {
  messageId: string;
  sessionKey: string;
  userId: string;
  events: C.ChatEvent[];
  listeners: Set<Listener>;
  finished: boolean;
  cancelled?: boolean;
  stop?: () => void;
}

export interface ChatServiceOptions {
  resolveBin?: () => ResolvedBin | undefined;
  timeoutMs?: number;
  /** Repo root holding .claude/agents or harness-staging/.claude/agents (default: coordinator root). */
  agentRoot?: string;
  model?: string;
}

export class ChatService {
  readonly chats: ChatStore;
  private readonly messages = new Map<string, MessageRun>();
  private readonly running = new Map<string, string>();
  private auth?: { at: number; status: AuthStatus };

  constructor(
    private readonly coord: Coordinator,
    private readonly opts: ChatServiceOptions = {},
  ) {
    this.chats = new ChatStore(coord.store);
  }

  private bin(): ResolvedBin | undefined {
    return (this.opts.resolveBin ?? (() => resolveClaudeBin()))();
  }

  private agent(): ChatAgentDef | undefined {
    return loadChatAgent(this.opts.agentRoot ?? this.coord.root);
  }

  private async preflight(force = false): Promise<AuthStatus> {
    const now = Date.now();
    const a = this.auth;
    if (!force && a && now - a.at < (a.status.loggedIn ? AUTH_TTL_MS : AUTH_NEG_TTL_MS)) return a.status;
    const status = await authStatus(this.bin(), childEnv());
    this.auth = { at: now, status };
    return status;
  }

  /** GET /chat/status. Never the account email or organisation. */
  async status(user: { id: string }): Promise<C.ChatStatus> {
    const s = await this.preflight();
    return {
      installed: s.installed,
      ...(s.version ? { version: s.version } : {}),
      loggedIn: s.loggedIn,
      ...(s.authMethod ? { authMethod: s.authMethod } : {}),
      ...(s.subscriptionType ? { subscriptionType: s.subscriptionType } : {}),
      agentSource: this.agent()?.source ?? "none",
      running: [...this.messages.values()].some((m) => m.userId === user.id && !m.finished),
    };
  }

  private async session(testKey: string, user: { id: string }) {
    const { test } = await this.coord.loadTest(testKey);
    const key = `${user.id}|${bareProjectId(test.projectId)}|${test.modelSetId}|${test.testKey}`;
    return { test, key, stored: await this.chats.get(test.projectId, test.modelSetId, test.testKey, user.id) };
  }

  /** GET /chat/history?testKey=… */
  async history(testKey: string, user: { id: string }): Promise<C.ChatHistory> {
    const { test, key, stored } = await this.session(testKey, user);
    const running = this.running.get(key);
    return { sessionId: stored?.sessionId ?? "", testKey: test.testKey, messages: stored?.messages ?? [], ...(running ? { running } : {}) };
  }

  /** POST /chat/:messageId/cancel: SIGINT, then SIGTERM after 5 s (bridge). */
  cancel(messageId: string, user: { id: string }): { cancelled: boolean } {
    const m = this.messages.get(messageId);
    if (!m || m.userId !== user.id) throw new CoordError("not_found", `Mensaje ${messageId} no existe`);
    if (m.finished) return { cancelled: false };
    m.cancelled = true;
    if (m.stop) m.stop();
    return { cancelled: true };
  }

  /** GET /chat/:messageId/events: replays what was emitted, then streams. Returns an unsubscribe. */
  subscribe(messageId: string, user: { id: string }, listener: Listener): () => void {
    const m = this.messages.get(messageId);
    if (!m || m.userId !== user.id) throw new CoordError("not_found", `Mensaje ${messageId} no existe`);
    m.events.forEach((e, i) => listener(e, m.finished && i === m.events.length - 1));
    if (m.finished) return () => undefined;
    m.listeners.add(listener);
    return () => m.listeners.delete(listener);
  }

  /** POST /chat/messages: validates, reserves the session and starts the run in the background. */
  async send(req: C.ChatMessageRequest, user: { id: string; name: string }): Promise<C.ChatMessageAccepted> {
    const message = String(req.message ?? "").trim();
    if (!message || message.length > CHAT_MESSAGE_MAX) throw new CoordError("validation_error", `El mensaje debe tener entre 1 y ${CHAT_MESSAGE_MAX} caracteres.`);
    const { test, key, stored } = await this.session(req.testKey, user);
    if (this.running.has(key)) throw new CoordError("conflict", "Ya hay un mensaje en curso en esta conversación: espera a que termine o cancélalo.", "Cancela el mensaje en curso o espera a que termine.");
    const now = nowIso(this.coord.now());
    const fresh = !stored || !!req.newSession;
    const session: StoredChatSession = fresh
      ? { sessionId: randomUUID(), userId: user.id, projectId: bareProjectId(test.projectId), modelSetId: test.modelSetId, testKey: test.testKey, createdAt: now, updatedAt: now, messages: [] }
      : stored!;
    const messageId = `M-${randomUUID().slice(0, 12)}`;
    const run: MessageRun = { messageId, sessionKey: key, userId: user.id, events: [], listeners: new Set(), finished: false };
    this.messages.set(messageId, run);
    this.running.set(key, messageId);
    session.messages.push({ messageId, role: "user", text: sanitizeModelText(message, CHAT_MESSAGE_MAX), at: now, ...(req.context ? { context: req.context } : {}) });
    session.updatedAt = now;
    await this.chats.put(session);
    void this.execute(run, session, message, req.context ?? {}, user).catch((err) => log.warn("chat.unhandled", { message: (err as Error).message }));
    return { messageId, sessionId: session.sessionId };
  }

  private emit(run: MessageRun, e: C.ChatEvent): void {
    if (run.finished) return;
    const last = e.type === "done" || e.type === "error";
    run.events.push(e);
    if (last) run.finished = true;
    for (const l of run.listeners) {
      try {
        l(e, last);
      } catch {
        // a broken SSE connection must not stop the run
      }
    }
    if (last) {
      run.listeners.clear();
      this.running.delete(run.sessionKey);
      setTimeout(() => this.messages.delete(run.messageId), KEEP_FINISHED_MS).unref?.();
    }
  }

  private async execute(run: MessageRun, session: StoredChatSession, message: string, context: C.ChatContext, user: { id: string; name: string }): Promise<void> {
    const started = Date.now();
    const created: Array<{ id: string; kind: "proposal" | "question" }> = [];
    const pending: Array<Promise<void>> = [];
    let text = "";
    let costUsd: number | undefined;
    let stoppedBy: Extract<C.ChatEvent, { type: "done" }>["stoppedBy"];
    let error: { code: ErrorCode; message: string } | undefined;
    try {
      this.emit(run, { type: "status", phase: "starting" });
      const bin = this.bin();
      if (!bin) throw new ChatRunError("claude_not_found", "Claude Code no está instalado (https://code.claude.com).");
      const auth = await this.preflight();
      if (!auth.installed) throw new ChatRunError("claude_not_found", "Claude Code no está instalado (https://code.claude.com).");
      if (!auth.loggedIn) {
        this.auth = undefined;
        throw new ChatRunError("not_logged_in", "Claude Code no tiene sesión iniciada. Abre una terminal y ejecuta `claude`, luego `/login`.");
      }
      const agent = this.agent();
      if (!agent) throw new ChatRunError("failed", "Falta la definición del agente coordinador-chat (.claude/agents o harness-staging).");
      if (run.cancelled) throw new ChatRunError("cancelled", "Cancelado.");
      const prompt = chatPrompt(await contextBlock(this.coord, session.testKey, context), message);
      const mcpConfig = mcpConfigJson({ root: this.coord.root, dataSource: this.coord.source.kind === "fixtures" ? "fixtures" : "live", ...(this.coord.homeOverride ? { homeOverride: this.coord.homeOverride } : {}) });
      const onCreated = (c: { id: string; tool: string }) => {
        pending.push(
          (async () => {
            // Verify against the store before announcing (ids come from tool results, not model text).
            if (c.tool === "ask_coordinator") {
              const q = await this.coord.questions.get(c.id);
              if (!q) return;
              created.push({ id: c.id, kind: "question" });
              this.emit(run, { type: "question", id: c.id, question: sanitizeModelText(q.question, 300) });
            } else {
              const p = await this.coord.store.getProposal(c.id).catch(() => undefined);
              if (!p) return;
              created.push({ id: c.id, kind: "proposal" });
              this.emit(run, { type: "proposal", id: c.id, kind: p.kind, summary: sanitizeModelText(proposalSummary(p), 200) });
            }
          })().catch(() => undefined),
        );
      };
      const once = (resume: boolean) =>
        runClaude({
          bin,
          args: claudeArgs({ agent, mcpConfig, sessionId: session.sessionId, resume, ...(this.opts.model ? { model: this.opts.model } : {}) }),
          cwd: this.coord.root,
          prompt,
          env: childEnv(),
          ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
          onChild: (_c, stop) => {
            run.stop = stop;
            if (run.cancelled) stop();
          },
          onCreated,
          onEvent: (e) => this.emit(run, e.type === "delta" ? { type: "delta", text: e.text } : e),
        });
      let result;
      try {
        result = await once(!!session.started);
      } catch (err) {
        // The Claude session is gone (e.g. its transcript was deleted): start a new one once.
        if (session.started && err instanceof ChatRunError && err.code === "failed" && /no conversation found|session/i.test(err.message) && !run.cancelled) {
          session.sessionId = randomUUID();
          session.started = false;
          result = await once(false);
        } else throw err;
      }
      session.started = true;
      text = result.text;
      costUsd = result.costUsd;
      stoppedBy = result.stoppedBy;
    } catch (err) {
      if (err instanceof ChatRunError) error = { code: run.cancelled ? "cancelled" : err.code, message: run.cancelled ? "Cancelado." : err.message };
      else {
        log.warn("chat.failed", { message: (err as Error).message });
        error = { code: "failed", message: err instanceof CoordError ? err.message : "El chat falló." };
      }
    }
    await Promise.all(pending);
    const durationMs = Date.now() - started;
    const proposalIds = created.filter((c) => c.kind === "proposal").map((c) => c.id);
    const questionIds = created.filter((c) => c.kind === "question").map((c) => c.id);
    try {
      session.messages.push({
        messageId: run.messageId,
        role: "assistant",
        text: sanitizeModelText(text, 20_000),
        at: nowIso(this.coord.now()),
        ...(proposalIds.length ? { proposalIds } : {}),
        ...(questionIds.length ? { questionIds } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        durationMs,
        ...(error ? { error } : {}),
      });
      session.updatedAt = nowIso(this.coord.now());
      await this.chats.put(session);
      await this.coord.store.audit({
        actor: { type: "user", id: user.id, name: user.name },
        action: "chat.message",
        projectId: session.projectId,
        modelSetId: session.modelSetId,
        testId: session.testKey,
        targetIds: [run.messageId, ...proposalIds.slice(0, 10), ...questionIds.slice(0, 5)],
        details: { proposals: proposalIds.length, questions: questionIds.length, costUsd: costUsd ?? null, durationMs, error: error?.code ?? null, stoppedBy: stoppedBy ?? null },
      });
    } catch (err) {
      log.warn("chat.persist_failed", { message: (err as Error).message });
    }
    if (error) this.emit(run, { type: "error", ...error });
    else this.emit(run, { type: "done", messageId: run.messageId, ...(costUsd !== undefined ? { costUsd } : {}), durationMs, ...(stoppedBy ? { stoppedBy } : {}) });
  }
}
