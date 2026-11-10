/**
 * Chat with the domain agent (propose-only), as a tab of the right column so
 * the viewer keeps its size. Streaming answer (markdown-lite), a status line,
 * cancel, history per test, context chips (lens, focused row, viewer
 * selection: nothing is sent until the user sends), suggested prompts, and
 * proposal cards that apply ONLY through the existing human paths.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n, useT, type TFunction } from "~/i18n";
import { useApi } from "~/lib/api";
import type { ChatContext, ChatErrorCode, ChatMessage, ChatProposal, ChatSelectedElement, ChatStatus } from "~/lib/api/types";
import { useToast } from "~/lib/components/Toast";
import { VALIDITY_KEY } from "~/lib/labels";
import { readJson, readString, writeJson, writeString } from "~/lib/storage";
import { useTriageContext } from "./actions";
import { useTriage, type TriageStore } from "./store";
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

/** Three prompts that fit the context. */
export function suggestedPrompts(t: TFunction, store: TriageStore, selectionCount: number): string[] {
  const s = store.state;
  const key = s.cursorKey;
  const out: string[] = [];
  const gid = key?.startsWith("g:") ? key.slice(2) : key?.startsWith("c:") ? s.clashes.get(key.slice(2))?.groupId : undefined;
  const validity = gid ? s.groups.get(gid)?.validity : key?.startsWith("f:") ? s.families.get(key.slice(2))?.proposed.validity : undefined;
  if (validity) out.push(t("chat.prompt.why", { validity: t(VALIDITY_KEY[validity]).toLowerCase() }));
  if (selectionCount) out.push(t("chat.prompt.regroup"));
  if (validity === "real") out.push(t("chat.prompt.issue"));
  if (key?.startsWith("i:")) out.push(t("chat.prompt.verdict"));
  for (const p of [t("chat.prompt.changed"), t("chat.prompt.p1"), t("chat.prompt.summary")]) if (out.length < 3 && !out.includes(p)) out.push(p);
  return out.slice(0, 3);
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
      if (current.text || current.proposals?.length) setMessages((m) => [...m, current]);
      setStreaming(null);
      setStatus(null);
      abort.current = null;
    }
  }

  function cancel() {
    abort.current?.abort();
    if (chatId) void api.cancelChat(chatId).catch(() => undefined);
  }

  const drop = (k: string) => setDropped((d) => new Set(d).add(k));
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
        {!messages.length && !streaming && <p className="text-xs text-gray-500">{t("chat.empty")}</p>}
        {[...messages, ...(streaming ? [streaming] : [])].map((m, i) => (
          <Fragment key={i}>
            {m.role === "user" ? (
              <div className="ml-6 rounded-lg bg-brand-surface px-3 py-2 text-gray-900">{m.text}</div>
            ) : (
              <div className="mr-2 rounded-lg border border-violet-200 bg-white px-3 py-2 text-gray-900">
                <MarkdownLite text={m.text || "…"} />
                {m.proposals?.map((p) => <ProposalCard key={p.id} proposal={p} />)}
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
          <p className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-violet-800" role="status">
            <span className="truncate">{status}</span>
            <button type="button" onClick={cancel} className="shrink-0 rounded border border-violet-300 px-1.5 text-[11px] hover:bg-violet-50">
              {t("chat.cancel")}
            </button>
          </p>
        )}
        <div className="mb-1.5 flex flex-wrap gap-1">
          {prompts.map((p) => (
            <button key={p} type="button" disabled={busy || !!blocked} onClick={() => void send(p)} className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] text-violet-900 hover:border-violet-400 disabled:opacity-50">
              {p}
            </button>
          ))}
        </div>
        <div className="mb-1.5 flex flex-wrap gap-1" aria-label={t("chat.contextLabel")}>
          {ctx.lens && <ContextChip label={t("chat.ctx.lens", { lens: t(`lens.${ctx.lens}` as Parameters<TFunction>[0]) })} onDrop={() => drop("lens")} />}
          {ctx.focus && ctx.focus.kind !== "node" && <ContextChip label={t(`chat.ctx.${ctx.focus.kind}` as Parameters<TFunction>[0], { label: (ctx.focus.label ?? ctx.focus.id).slice(0, 48) })} onDrop={() => drop("focus")} />}
          {ctx.selection && (
            <ContextChip
              label={selection.truncated ? t("chat.ctx.selectionCapped", { count: selection.total, cap: ctx.selection.length }) : t("chat.ctx.selection", { count: ctx.selection.length })}
              onDrop={() => drop("selection")}
            />
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="flex items-end gap-1.5"
        >
          <textarea
            id="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={2}
            maxLength={4000}
            disabled={!!blocked}
            placeholder={blocked ? t(ERROR_KEY[blocked]) : t("chat.placeholder")}
            aria-label={t("chat.placeholder")}
            className="min-w-0 flex-1 resize-none rounded border border-brand-muted/30 px-2 py-1.5 text-sm focus:border-brand focus:outline-none"
          />
          <button type="submit" disabled={busy || !input.trim() || !!blocked} className="rounded bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-light disabled:opacity-50">
            {t("chat.send")}
          </button>
        </form>
        <p className="mt-1 flex items-center justify-between gap-2 text-[10px] text-gray-400">
          <span>{t("chat.footer")}</span>
          {(messages.length > 0 || chatId) && (
            <button type="button" onClick={startNew} disabled={busy} className="shrink-0 text-brand hover:underline disabled:opacity-50">
              {t("chat.newSession")}
            </button>
          )}
        </p>
      </div>
    </div>
  );
}

function ContextChip({ label, onDrop }: { label: string; onDrop: () => void }) {
  const t = useT();
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-brand-muted/30 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-700">
      <span className="truncate">{label}</span>
      <button type="button" onClick={onDrop} aria-label={t("chat.ctx.drop", { label })} className="shrink-0 text-gray-400 hover:text-red-700">
        ×
      </button>
    </span>
  );
}

/** A proposal from the agent: Aplicar uses the EXISTING human paths; nothing applies without a click. */
function ProposalCard({ proposal }: { proposal: ChatProposal }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const { store, actions } = useTriageContext();
  const [state, setState] = useState<"open" | "confirm" | "applied" | "dismissed">("open");
  const [resolved, setResolved] = useState<string | null>(null);
  const testId = useTriage(store, (s) => s.payload?.test.id ?? "");
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
    if (local || !testId || proposal.kind === "regroup") return;
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
  }, [api, local, proposal.id, proposal.kind, store, testId]);
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
        await api.applyRegroup(proposal.id);
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
    // question: revealing the ubicación shows its callout.
    setState("applied");
  }

  const kindLabel = t(`chat.kind.${["decision", "family_decision", "regroup", "question"].includes(proposal.kind) ? proposal.kind : "other"}` as Parameters<TFunction>[0]);
  return (
    <div className={`mt-2 rounded border px-2 py-1.5 text-xs ${state === "dismissed" ? "border-gray-200 bg-gray-50 text-gray-400" : "border-violet-300 bg-violet-50"}`}>
      <p className="flex items-center gap-1.5">
        <span className="rounded bg-violet-600 px-1 text-[10px] font-medium text-white">{kindLabel}</span>
        {proposal.targetCount !== undefined && <span className="text-[11px] text-gray-500">{t("chat.targets", { count: proposal.targetCount })}</span>}
      </p>
      <p className="mt-1 text-gray-900">{proposal.summary}</p>
      {state === "confirm" && <p className="mt-1 font-medium text-amber-900">{t("chat.regroupConfirm", { count: proposal.targetCount ?? 0 })}</p>}
      {state === "applied" ? (
        <p className="mt-1 text-green-800">{t("chat.applied")}</p>
      ) : state === "dismissed" ? (
        <p className="mt-1">{t("chat.dismissed")}</p>
      ) : (
        <div className="mt-1.5 flex gap-1.5">
          <button
            type="button"
            onClick={() => void apply()}
            disabled={!target && proposal.kind !== "regroup"}
            title={!target && proposal.kind !== "regroup" ? t("chat.noTarget") : undefined}
            className="rounded bg-brand px-2 py-0.5 font-medium text-white hover:bg-brand-light disabled:opacity-50"
          >
            {state === "confirm" ? t("chat.confirm") : t("chat.apply")}
          </button>
          <button type="button" onClick={() => setState("dismissed")} className="rounded border border-brand-muted/30 px-2 py-0.5 text-gray-700">
            {t("chat.dismiss")}
          </button>
          {target && (
            <button type="button" onClick={see} className="rounded px-2 py-0.5 text-brand hover:underline">
              {t("chat.see")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
