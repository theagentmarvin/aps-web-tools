/**
 * Chat with the domain agent (propose-only), as a tab of the right column so
 * the viewer keeps its size. Streaming answer (markdown-lite), a status line,
 * cancel, history per test, context chips (lens, focused row, viewer
 * selection: nothing is sent until the user sends), suggested prompts, and
 * proposal cards that apply ONLY through the existing human paths.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useI18n, useT, type TFunction } from "~/i18n";
import { useApi } from "~/lib/api";
import type { ChatContext, ChatErrorCode, ChatMessage, ChatProposal, ChatSelectedElement, ChatStatus, FlowRunView } from "~/lib/api/types";
import { FlowRunPanel, NextStepRow, useFlowRun } from "~/features/flows/FlowParts";
import { flowsChanged, openFlows } from "~/features/flows/links";
import { VALIDITY_KEY } from "~/lib/labels";
import { useToast } from "~/lib/components/Toast";
import { IconChevronDown, IconSparkle } from "~/lib/components/icons";
import { AGENT_STATUS_REFRESH } from "~/lib/components/shell-widgets";
import { readJson, readString, writeJson, writeString } from "~/lib/storage";
import { useTriageContext } from "./actions";
import { QuestionAnswer } from "./QuestionAnswer";
import { useTriage, type TriageStore } from "./store";
import { decidedCount } from "./questions";
import { onViewerSelection, readViewerSelection } from "./viewer-selection";

// ── markdown-lite (paragraphs, lists, **bold**, `code`; never raw HTML) ──

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k++} className="rounded bg-gray-100 px-1 font-mono text-[11px]">{tok.slice(1, -1)}</code>);
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length} className="list-decimal pl-5">{items}</ol> : <ul key={blocks.length} className="list-disc pl-5">{items}</ul>);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || num) {
      flushPara();
      const ordered = !!num;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? num)![1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <div className="space-y-1.5">{blocks}</div>;
}

// ── context ───────────────────────────────────────────────────────

/** Context sent with a message: lens, focused row and viewer selection (each can be dropped). */
export function buildContext(store: TriageStore, selection: ChatSelectedElement[], truncated: boolean, dropped: Set<string>): ChatContext {
  const s = store.state;
  const ctx: ChatContext = {};
  if (!dropped.has("lens")) {
    ctx.lens = store.effectiveLens();
    ctx.view = s.query.view;
  }
  const key = s.cursorKey;
  if (key && !dropped.has("focus")) {
    const id = key.slice(2);
    if (key.startsWith("f:")) ctx.focus = { kind: "family", id, label: s.families.get(id)?.title };
    else if (key.startsWith("g:")) ctx.focus = { kind: "group", id, label: s.groups.get(id)?.title };
    else if (key.startsWith("c:")) ctx.focus = { kind: "clash", id, label: id };
    else if (key.startsWith("i:")) ctx.focus = { kind: "issue", id, label: s.issueChecks.get(id)?.title };
    else ctx.focus = { kind: "node", id };
  }
  if (selection.length && !dropped.has("selection")) {
    ctx.selection = selection;
    if (truncated) ctx.selectionTruncated = true;
  }
  return ctx;
}

/**
 * Suggested prompts in plain coordinator language (no validity jargon), only
 * the ones that apply to the current context (focused row, viewer selection,
 * a previous version to compare with).
 */
export function suggestedPrompts(t: TFunction, store: TriageStore, selectionCount: number): string[] {
  const s = store.state;
  const key = s.cursorKey;
  const out: string[] = [];
  const row = key && (key.startsWith("f:") || key.startsWith("g:") || key.startsWith("c:"));
  const gid = key?.startsWith("g:") ? key.slice(2) : key?.startsWith("c:") ? s.clashes.get(key.slice(2))?.groupId : undefined;
  const validity = gid ? s.groups.get(gid)?.validity : key?.startsWith("f:") ? s.families.get(key.slice(2))?.proposed.validity : undefined;
  if (row) {
    out.push(t("chat.prompt.explain"));
    out.push(t("chat.prompt.solution"));
    if (validity === "real") out.push(t("chat.prompt.issue"));
  }
  if (key?.startsWith("i:")) out.push(t("chat.prompt.issueExplain"));
  if (selectionCount) out.push(t("chat.prompt.regroup"));
  if (store.hasPrevious()) out.push(t("chat.prompt.changed"));
  if (!row) out.push(t("chat.prompt.first"));
  // WS-N: always offer "what's next" (the server computes it; the agent offers to run the flow).
  out.push(t("chat.prompt.nextSteps"));
  return out;
}

const ERROR_KEY: Record<ChatErrorCode, Parameters<TFunction>[0]> = {
  claude_not_found: "chat.error.claude_not_found",
  not_logged_in: "chat.error.not_logged_in",
  timeout: "chat.error.timeout",
  busy: "chat.error.busy",
  failed: "chat.error.failed",
  cancelled: "chat.error.cancelled",
  mcp_unavailable: "chat.error.mcp_unavailable",
  rate_limited: "chat.error.rate_limited",
};

/** Server status phases / tool names → one Spanish line. */
function statusText(t: TFunction, raw: string): string {
  if (raw.startsWith("tool:")) {
    const [name, target] = raw.slice(5).split("|");
    return t("chat.status.tool", { tool: target || name || "…" });
  }
  if (raw === "phase:starting") return t("chat.status.starting");
  if (raw === "phase:retrying") return t("chat.status.retrying");
  if (raw === "phase:rate_limited") return t("chat.status.rateLimited");
  if (raw.startsWith("phase:")) return t("chat.thinking");
  return raw;
}

const NOTICE_KEY = "coord.chat.notice";

// ── panel ─────────────────────────────────────────────────────────

const chatKey = (testId: string) => `coord.chat.${testId}`;

export function ChatPanel() {
  const t = useT();
  const api = useApi();
  const { store } = useTriageContext();
  const payload = useTriage(store, (s) => s.payload);
  useTriage(store, (s) => s.cursorKey);
  useTriage(store, (s) => s.query);
  const testId = payload?.test.id ?? "";
  const [chatId, setChatId] = useState<string | undefined>(() => readJson<string | null>(chatKey(testId), null) ?? undefined);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<ChatMessage | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<{ code: ChatErrorCode; message: string } | null>(null);
  const [input, setInput] = useState("");
  /** "Nueva conversación": the next message starts a new Claude session. */
  const [newSession, setNewSession] = useState(false);
  function startNew() {
    if (streaming) return;
    setMessages([]);
    setError(null);
    setChatId(undefined);
    writeJson(chatKey(testId), null);
    setNewSession(true);
  }
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<{ elements: ChatSelectedElement[]; truncated: boolean; total: number }>({ elements: [], truncated: false, total: 0 });
  const abort = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const viewerReady = useTriage(store, (s) => s.viewer.status === "ready");
  const { fmt } = useI18n();
  // Preflight (before the first message): Claude Code installed and signed in.
  const [preflight, setPreflight] = useState<ChatStatus | null>(null);
  useEffect(() => {
    api.getChatStatus().then(
      (st) => setPreflight(st),
      () => setPreflight(null),
    );
  }, [api]);
  const blocked = preflight ? (!preflight.installed ? "claude_not_found" : !preflight.loggedIn ? "not_logged_in" : null) : null;
  // Governance notice, once per browser session (Procedimiento Acceso Herramientas IA).
  const [noticeSeen, setNoticeSeen] = useState(() => readString(NOTICE_KEY, "session") === "1");

  // History of this test's conversation.
  useEffect(() => {
    const id = readJson<string | null>(chatKey(testId), null) ?? undefined;
    setChatId(id);
    setMessages([]);
    api.getChat(testId, id).then(
      (h) => setMessages(h.messages),
      () => undefined,
    );
  }, [api, testId]);

  // Live viewer selection (nothing is sent until the user sends).
  useEffect(() => {
    const docs = payload?.test.documents ?? [];
    const update = () => {
      setSelection(readViewerSelection(docs));
      setDropped((d) => {
        if (!d.has("selection")) return d;
        const n = new Set(d);
        n.delete("selection");
        return n;
      });
    };
    update();
    return onViewerSelection(update);
  }, [payload, viewerReady]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streaming]);

  const ctx = useMemo(() => buildContext(store, selection.elements, selection.truncated, dropped), [store, selection, dropped, store.state.cursorKey, store.state.query]); // eslint-disable-line react-hooks/exhaustive-deps
  const prompts = suggestedPrompts(t, store, dropped.has("selection") ? 0 : selection.elements.length);
  const busy = !!streaming;

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy || !payload || blocked) return;
    setError(null);
    setInput("");
    const context = ctx;
    const userMsg: ChatMessage = { role: "user", text: message, at: new Date().toISOString(), context };
    setMessages((m) => [...m, userMsg]);
    const agent: ChatMessage = { role: "agent", text: "", at: new Date().toISOString(), proposals: [] };
    setStreaming(agent);
    setStatus(t("chat.thinking"));
    const ctrl = new AbortController();
    abort.current = ctrl;
    let current = agent;
    try {
      const fresh = newSession;
      setNewSession(false);
      await api.chat({ projectId: payload.project.id, modelSetId: payload.modelSet.id, testId, chatId: fresh ? undefined : chatId, message, context, newSession: fresh || undefined }, (e) => {
        if (e.type === "status") {
          setStatus(statusText(t, e.text));
          if (e.chatId && e.chatId !== chatId) {
            setChatId(e.chatId);
            writeJson(chatKey(testId), e.chatId);
          }
        } else if (e.type === "delta") {
          current = { ...current, text: current.text + e.text };
          setStreaming(current);
        } else if (e.type === "proposal") {
          current = { ...current, proposals: [...(current.proposals ?? []), e.proposal] };
          setStreaming(current);
          store.noteChatProposal();
        } else if (e.type === "flow") {
          // WS-N: a flow the agent started (server card); its state is followed live by the card.
          current = { ...current, flows: [...(current.flows ?? []).filter((r) => r.runId !== e.run.runId), e.run] };
          setStreaming(current);
          flowsChanged();
        } else if (e.type === "next_steps") {
          current = { ...current, nextSteps: e.steps };
          setStreaming(current);
        } else if (e.type === "done") {
          current = { ...current, cost: e.cost, durationMs: e.durationMs };
          if (e.chatId) {
            setChatId(e.chatId);
            writeJson(chatKey(testId), e.chatId);
          }
        } else if (e.type === "error") setError({ code: e.code, message: e.message });
      }, ctrl.signal);
    } catch (err) {
      setError({ code: "failed", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (current.text || current.proposals?.length || current.flows?.length || current.nextSteps?.length) setMessages((m) => [...m, current]);
      setStreaming(null);
      setStatus(null);
      abort.current = null;
      // G12: the turn ended (done, error or cancel): the header chip re-reads the agent status now.
      window.dispatchEvent(new Event(AGENT_STATUS_REFRESH));
    }
  }

  function cancel() {
    abort.current?.abort();
    if (chatId) void api.cancelChat(chatId).catch(() => undefined);
  }

  const drop = (k: string) => setDropped((d) => new Set(d).add(k));
  // Input: auto-grow from 1 to 6 lines.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [input]);
  /** A suggestion fills the input (never auto-sends). */
  function fill(p: string) {
    setInput(p);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }
  const ctxItems: ContextItem[] = [];
  if (ctx.focus && ctx.focus.kind !== "node") {
    const label = ctx.focus.label ?? ctx.focus.id;
    ctxItems.push({ key: "focus", short: label, full: t(`chat.ctx.${ctx.focus.kind}` as Parameters<TFunction>[0], { label }), onDrop: () => drop("focus") });
  }
  if (ctx.lens) {
    const lens = t(`lens.${ctx.lens}` as Parameters<TFunction>[0]);
    ctxItems.push({ key: "lens", short: lens, full: t("chat.ctx.lens", { lens }), onDrop: () => drop("lens") });
  }
  if (ctx.selection) {
    ctxItems.push({
      key: "selection",
      short: selection.truncated ? t("chat.ctx.selShortCapped", { cap: ctx.selection.length, count: selection.total }) : t("chat.ctx.selShort", { count: ctx.selection.length }),
      full: selection.truncated ? t("chat.ctx.selectionCapped", { count: selection.total, cap: ctx.selection.length }) : t("chat.ctx.selection", { count: ctx.selection.length }),
      onDrop: () => drop("selection"),
    });
  }
  // "Preguntar al agente sobre esto": the focus chip comes back even if it was dropped.
  const askNonce = useTriage(store, (s) => s.chatAskNonce);
  useEffect(() => {
    if (!askNonce) return;
    setDropped((d) => {
      const n = new Set(d);
      n.delete("focus");
      return n;
    });
  }, [askNonce]);

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label={t("chat.title")}>
      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm" aria-live="polite">
        {!noticeSeen && (
          <div role="note" className="rounded border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
            <p>{t("chat.notice")}</p>
            <button
              type="button"
              onClick={() => {
                writeString(NOTICE_KEY, "1", "session");
                setNoticeSeen(true);
              }}
              className="mt-1 font-medium text-sky-900 hover:underline"
            >
              {t("chat.noticeOk")}
            </button>
          </div>
        )}
        {blocked && (
          <div role="alert" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <p className="font-medium">{t(ERROR_KEY[blocked])}</p>
          </div>
        )}
        {!messages.length && !streaming && (
          <div className="text-xs text-gray-500">
            <p>{t("chat.empty")}</p>
            {/* Empty conversation: the suggestions are listed here (they fill the input, never auto-send). */}
            {!blocked && prompts.length > 0 && (
              <ul className="mt-2 space-y-1">
                {prompts.map((p) => (
                  <li key={p}>
                    <button type="button" onClick={() => fill(p)} className="text-left text-violet-800 hover:underline">
                      {p}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {[...messages, ...(streaming ? [streaming] : [])].map((m, i) => (
          <Fragment key={i}>
            {m.role === "user" ? (
              <div className="ml-6 rounded-lg bg-brand-surface px-3 py-2 text-gray-900">{m.text}</div>
            ) : (
              <div className="mr-2 rounded-lg border border-violet-200 bg-white px-3 py-2 text-gray-900">
                <MarkdownLite text={m.text || "…"} />
                {m.proposals?.map((p) => <ProposalCard key={p.id} proposal={p} />)}
                {m.nextSteps?.length ? (
                  <ul className="mt-2 divide-y divide-violet-100 rounded border border-violet-200 bg-violet-50/40 px-2 text-xs">
                    {m.nextSteps.map((s) => (
                      <NextStepRow key={s.id} step={s} compact />
                    ))}
                  </ul>
                ) : null}
                {m.flows?.map((r) => <FlowChatCard key={r.runId} run={r} />)}
                {(m.cost !== undefined || m.durationMs !== undefined) && (
                  <p className="mt-1 text-right text-[10px] text-gray-400">
                    {[m.cost !== undefined ? t("chat.cost", { usd: m.cost.toFixed(2) }) : "", m.durationMs !== undefined ? t("chat.duration", { s: fmt.number(m.durationMs / 1000, 1) }) : ""].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>
            )}
          </Fragment>
        ))}
        {error && (
          <div role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
            <p className="font-medium">{t(ERROR_KEY[error.code] ?? "chat.error.failed")}</p>
            {error.message && <p className="mt-0.5 text-red-800/80">{error.message}</p>}
          </div>
        )}
      </div>

      <div className="flex-shrink-0 border-t border-brand-muted/20 px-3 py-2">
        {status && (
          <p className="mb-1 flex items-center justify-between gap-2 text-[11px] text-violet-800" role="status">
            <span className="truncate">{status}</span>
            <button type="button" onClick={cancel} className="shrink-0 rounded border border-violet-300 px-1.5 text-[11px] hover:bg-violet-50">
              {t("chat.cancel")}
            </button>
          </p>
        )}
        <ContextLine items={ctxItems} canRestart={messages.length > 0 || !!chatId} busy={busy} onRestart={startNew} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="flex items-end gap-1.5"
        >
          <textarea
            id="chat-input"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={1}
            maxLength={4000}
            disabled={!!blocked}
            placeholder={blocked ? t(ERROR_KEY[blocked]) : t("chat.placeholder")}
            aria-label={t("chat.placeholder")}
            title={t("chat.inputHint")}
            className="max-h-[8.25rem] min-w-0 flex-1 resize-none overflow-y-auto rounded border border-brand-muted/30 px-2 py-1.5 text-sm leading-5 focus:border-brand focus:outline-none"
          />
          <PromptMenu prompts={prompts} disabled={busy || !!blocked} onPick={fill} />
          <button type="submit" disabled={busy || !input.trim() || !!blocked} className="h-8 rounded bg-brand px-3 text-xs font-medium text-white hover:bg-brand-light disabled:opacity-50">
            {t("chat.send")}
          </button>
        </form>
      </div>
    </div>
  );
}

interface ContextItem {
  key: string;
  short: string;
  full: string;
  onDrop: () => void;
}

/** Close a small popover on an outside click. */
function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open, close]);
  return ref;
}

/**
 * ONE line (24 px) above the input: "Contexto: Grupo … · Todo · 3 elem." —
 * truncated, never wraps; the button opens a popover listing each item with ×.
 */
function ContextLine({ items, canRestart, busy, onRestart }: { items: ContextItem[]; canRestart: boolean; busy: boolean; onRestart: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const close = useMemo(() => () => setOpen(false), []);
  const ref = useOutside(open, close);
  const summary = items.length ? items.map((i) => i.short).join(" · ") : t("chat.ctx.none");
  return (
    <div ref={ref} className="relative mb-1 flex h-6 items-center gap-2 text-[11px] text-gray-500">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={[t("chat.footer"), ...items.map((i) => i.full)].join("\n")}
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-left hover:bg-gray-50"
      >
        <span className="shrink-0 font-medium text-gray-600">{t("chat.contextShort", { count: items.length })}</span>
        <span className="min-w-0 truncate">{summary}</span>
        <IconChevronDown size={11} className="shrink-0" />
      </button>
      {canRestart && (
        <button type="button" onClick={onRestart} disabled={busy} className="shrink-0 text-brand hover:underline disabled:opacity-50">
          {t("chat.newSession")}
        </button>
      )}
      {open && (
        <div role="dialog" aria-label={t("chat.contextLabel")} onKeyDown={(e) => e.key === "Escape" && setOpen(false)} className="absolute bottom-7 left-0 right-0 z-30 rounded-lg border border-brand-muted/20 bg-white p-2 text-xs text-gray-700 shadow-lg">
          <p className="mb-1 text-[11px] text-gray-500">{t("chat.footer")}</p>
          {items.length ? (
            <ul className="space-y-1">
              {items.map((i) => (
                <li key={i.key} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" title={i.full}>
                    {i.full}
                  </span>
                  <button type="button" onClick={i.onDrop} aria-label={t("chat.ctx.drop", { label: i.full })} className="shrink-0 rounded px-1 text-gray-400 hover:text-red-700">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("chat.ctx.none")}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** ✨ "Sugerencias": the context-aware prompts in a menu above the input; picking one fills the input. */
function PromptMenu({ prompts, disabled, onPick }: { prompts: string[]; disabled: boolean; onPick: (p: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const close = useMemo(() => () => setOpen(false), []);
  const ref = useOutside(open, close);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  if (!prompts.length) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("chat.suggestions")}
        title={t("chat.suggestions")}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-8 w-8 items-center justify-center rounded border border-violet-200 text-violet-700 hover:bg-violet-50 disabled:opacity-50"
      >
        <IconSparkle size={14} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("chat.suggestions")}
          onKeyDown={(e) => {
            const i = items.current.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const n = prompts.length;
              items.current[(i + (e.key === "ArrowDown" ? 1 : n - 1)) % n]?.focus();
            }
          }}
          className="absolute bottom-10 right-0 z-30 w-72 rounded-lg border border-brand-muted/20 bg-white py-1 text-sm shadow-lg"
        >
          <p className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">{t("chat.suggestions")}</p>
          {prompts.map((p, i) => (
            <button
              key={p}
              ref={(el) => {
                items.current[i] = el;
              }}
              type="button"
              role="menuitem"
              autoFocus={i === 0}
              onClick={() => {
                onPick(p);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-gray-800 hover:bg-violet-50 focus:bg-violet-50 focus:outline-none"
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** G12: "Crear incidencia · Conflicto" — the action plus the validity label as the UI names it. */
export function cardSummary(t: TFunction, p: ChatProposal): string {
  const c = p.card;
  if (!c) return p.summary;
  if (c.kind === "question") return c.title ?? p.summary;
  const action = c.action && CARD_ACTIONS.has(c.action) ? t(`chat.cardAction.${c.action}` as Parameters<TFunction>[0]) : t("chat.cardAction.other");
  return [action, c.validity ? t(VALIDITY_KEY[c.validity]) : ""].filter(Boolean).join(" · ");
}
const CARD_ACTIONS = new Set(["create_issue", "close", "close_not_issue", "mark_reviewed", "hygiene_issue", "escalate", "request_info", "reopen", "regroup", "issue", "classify"]);
const KIND_LABELS = new Set(["decision", "family_decision", "regroup", "question", "classification", "issue_draft", "status_change", "rule_change"]);

/** WS-N: a flow the agent started — live state from the flow store, cancel, and a link to the Flujos drawer. */
function FlowChatCard({ run: initial }: { run: FlowRunView }) {
  const t = useT();
  const run = useFlowRun(initial.runId, initial) ?? initial;
  return (
    <div className="mt-2 rounded border border-sky-300 bg-sky-50/60 px-2 py-1.5 text-xs">
      <p className="flex items-center gap-1.5">
        <span className="rounded bg-sky-700 px-1 text-[10px] font-medium text-white">{t("flows.chatCard")}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-gray-900">{run.label}</span>
        <button type="button" onClick={() => openFlows(run.runId)} className="shrink-0 text-[11px] text-brand hover:underline">
          {t("flows.chatSee")}
        </button>
      </p>
      <div className="mt-1">
        <FlowRunPanel run={run} compact />
      </div>
    </div>
  );
}

/**
 * A proposal from the agent: «Abrir para decidir» opens the EXISTING human path (nothing applies without
 * a click there). «Rechazar» rejects the proposal on the server and records it as feedback to the agent.
 * Questions look different (dashed border, «? Pregunta del agente · decide N ubicaciones»).
 */
function ProposalCard({ proposal }: { proposal: ChatProposal }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const { store, actions } = useTriageContext();
  const [state, setState] = useState<"open" | "confirm" | "applied" | "dismissed" | "rejecting" | "rejected">("open");
  const [reason, setReason] = useState("");
  const [resolved, setResolved] = useState<string | null>(null);
  const testId = useTriage(store, (s) => s.payload?.test.id ?? "");
  const card = proposal.card;
  const isQuestion = proposal.kind === "question";
  // A rule suggestion is never applied from the chat: it is approved and published (passkey) in Reglas.
  const isRule = proposal.kind === "rule_change";
  // Questions are answered in place with the same flow as the panel callout (store copy wins once loaded).
  const questionId = isQuestion ? (proposal.questionId ?? proposal.id) : "";
  const storedQuestion = useTriage(store, (s) => (questionId ? s.questions.get(questionId) : undefined));
  useEffect(() => {
    if (card?.question) store.upsertQuestion(card.question);
  }, [card?.question, store]);
  const question = storedQuestion ?? card?.question;
  const local =
    proposal.familyId && proposal.kind === "family_decision"
      ? `f:${proposal.familyId}`
      : proposal.groupIds?.[0]
        ? `g:${proposal.groupIds[0]}`
        : proposal.clashIds?.[0]
          ? `c:${proposal.clashIds[0]}`
          : proposal.familyId
            ? `f:${proposal.familyId}`
            : null;
  const target = local ?? resolved;
  // The event has no ids beyond the proposal's: look it up once (server data, never the model's text).
  useEffect(() => {
    if (local || !testId || proposal.kind === "regroup" || isQuestion || isRule) return;
    let live = true;
    api.listProposals({ testId, ids: [proposal.id], limit: 1 }).then(
      (page) => {
        const p = page.items[0];
        if (!live || !p) return;
        store.queueProposalUpdates([p]);
        setResolved(`g:${p.targetId}`);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, local, proposal.id, proposal.kind, store, testId, isQuestion, isRule]);
  // Select the target in the tree (the chat tab stays open).
  const select = () => {
    if (target) store.reveal(target);
  };
  // "Ver": back to the Detalle tab, focused on the item.
  const see = () => {
    if (!target) return;
    store.setRightTab("detail");
    store.reveal(target);
  };

  async function apply() {
    if (proposal.kind === "regroup") {
      if (state !== "confirm") return setState("confirm");
      try {
        if (!testId) return setState("open");
        await api.applyRegroup(proposal.id, testId, "apply");
        setState("applied");
        toast.show(t("chat.regroupApplied"));
      } catch (err) {
        toast.show(err instanceof Error ? err.message : String(err), { tone: "error" });
        setState("open");
      }
      return;
    }
    // The agent's proposal reaches the triage as a normal proposal: take it, then use the usual guarded path.
    store.applyProposalUpdates();
    if (!target) return;
    store.setRightTab("detail");
    store.reveal(target);
    if (proposal.kind === "family_decision" && proposal.familyId) store.setDialog({ type: "familyApprove", familyId: proposal.familyId });
    else if (proposal.kind === "decision" || proposal.kind === "classification") actions.accept(target);
    setState("applied");
  }

  /** «Rechazar»: the proposal moves to rejected on the server (reason optional) and the agent gets it as feedback. */
  async function reject() {
    if (state !== "rejecting") return setState("rejecting");
    try {
      if (proposal.kind === "regroup") {
        if (testId) await api.applyRegroup(proposal.id, testId, "reject");
      } else await api.rejectAgentProposal(proposal.id, reason.trim() || undefined);
      setState("rejected");
    } catch (err) {
      toast.show(t("loop.chat.rejectFailed", { message: err instanceof Error ? err.message : String(err) }), { tone: "error" });
      setState("open");
    }
  }

  const kindLabel = t(`chat.kind.${KIND_LABELS.has(proposal.kind) ? proposal.kind : "other"}` as Parameters<TFunction>[0]);
  const tg = card?.target;
  const targetLine = tg
    ? [t(`chat.cardTarget.${tg.kind}` as Parameters<TFunction>[0], { label: tg.label }), tg.groupCount && tg.groupCount > 1 ? t("chat.cardGroups", { count: tg.groupCount }) : "", t("chat.cardClashes", { count: tg.clashCount })].filter(Boolean).join(" · ")
    : null;
  const detail = card && card.kind !== "question" && card.title ? card.title : null;
  return (
    <div
      className={`mt-2 rounded border px-2 py-1.5 text-xs ${
        state === "dismissed" || state === "rejected" ? "border-gray-200 bg-gray-50 text-gray-500" : isQuestion ? "border-dashed border-actor-agent bg-white" : "border-actor-agent-bd bg-actor-agent-bg"
      }`}
    >
      <p className="flex items-center gap-1.5">
        {/* Shape + word, not colour only: ✦ proposal · ? question (dashed). */}
        <span className="min-w-0 font-semibold text-actor-agent">
          {isQuestion ? `? ${question && decidedCount(question) > 0 ? t("loop.chat.question", { count: decidedCount(question) }) : t("loop.chat.questionNone")}` : `✦ ${t("loop.chat.agentProposes", { kind: kindLabel })}`}
        </span>
        <span className="truncate font-mono text-[10px] text-gray-400" title={proposal.id}>
          {proposal.id}
        </span>
      </p>
      <p className="mt-1 font-medium text-gray-900" lang="es">
        {cardSummary(t, proposal)}
      </p>
      {detail && (
        <p className="truncate text-gray-700" title={detail} lang="es">
          {detail}
        </p>
      )}
      {targetLine && (
        <button type="button" onClick={select} disabled={!target} title={t("chat.selectTarget")} className="mt-0.5 block max-w-full truncate text-left text-brand hover:underline disabled:text-gray-500 disabled:no-underline">
          {targetLine}
        </button>
      )}
      {!targetLine && !card && proposal.targetCount !== undefined && <p className="text-[11px] text-gray-500">{t("chat.targets", { count: proposal.targetCount })}</p>}
      {isQuestion && question ? (
        state === "dismissed" ? (
          <p className="mt-1">{t("chat.dismissed")}</p>
        ) : (
          <QuestionAnswer q={question} />
        )
      ) : (
        <>
          {state === "confirm" && <p className="mt-1 font-medium text-amber-900">{t("chat.regroupConfirm", { count: proposal.targetCount ?? 0 })}</p>}
          {state === "applied" ? (
            <p className="mt-1 text-green-800">{t("chat.applied")}</p>
          ) : state === "rejected" ? (
            <p className="mt-1">{t("loop.chat.rejected")}</p>
          ) : state === "dismissed" ? (
            <p className="mt-1">{t("chat.dismissed")}</p>
          ) : state === "rejecting" ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <input autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void reject()} placeholder={t("loop.chat.rejectReason")} aria-label={t("loop.chat.rejectReason")} className="min-w-0 flex-1 rounded border border-brand-muted/30 bg-white px-1.5 py-0.5" />
              <button type="button" onClick={() => void reject()} className="rounded bg-brand px-2 py-0.5 font-medium text-white hover:bg-brand-light">
                {t("loop.chat.rejectConfirm")}
              </button>
              <button type="button" onClick={() => setState("open")} className="rounded px-2 py-0.5 text-gray-700">
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            <div className="mt-1.5 flex gap-1.5">
              {isRule && (
                <Link to="/reglas" className="rounded bg-brand px-2 py-0.5 font-medium text-white hover:bg-brand-light">
                  {t("chat.reviewRule")}
                </Link>
              )}
              {!isQuestion && !isRule && (
                <button
                  type="button"
                  onClick={() => void apply()}
                  disabled={!target && proposal.kind !== "regroup"}
                  title={!target && proposal.kind !== "regroup" ? t("chat.noTarget") : undefined}
                  className="rounded bg-brand px-2 py-0.5 font-medium text-white hover:bg-brand-light disabled:opacity-50"
                >
                  {state === "confirm" ? t("chat.confirm") : t("chat.apply")}
                </button>
              )}
              {!isRule && (
                <button type="button" onClick={() => void reject()} title={t("loop.chat.rejectTip")} className="rounded border border-brand-muted/30 bg-white px-2 py-0.5 text-gray-700">
                  {t("loop.chat.reject")}
                </button>
              )}
              {target && (
                <button type="button" onClick={see} className="rounded px-2 py-0.5 text-brand hover:underline">
                  {t("chat.see")}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
