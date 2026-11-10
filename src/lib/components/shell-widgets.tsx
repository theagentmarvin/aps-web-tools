/**
 * Small widgets used in the app shell and pages: language switch, agent
 * status indicator, copy-command box.
 */
import { useEffect, useState } from "react";
import { useI18n, useT, type Lang } from "~/i18n";
import { useApi } from "~/lib/api";
import type { AgentStatus } from "~/lib/api/types";
import { IconCheck, IconCopy } from "./icons";
import { useToast } from "./Toast";

export function LanguageSwitch() {
  const { lang, setLang } = useI18n();
  const t = useT();
  const opts: Lang[] = ["es", "en"];
  return (
    <div role="group" aria-label={t("nav.language")} className="inline-flex overflow-hidden rounded border border-brand-muted/30 text-xs">
      {opts.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={lang === l}
          onClick={() => setLang(l)}
          className={`px-2 py-0.5 uppercase ${lang === l ? "bg-brand text-white" : "bg-white text-gray-600 hover:text-brand"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** Window event: re-read the agent status now (e.g. a chat turn ended: done, error or cancel). */
export const AGENT_STATUS_REFRESH = "coord:agent-status-refresh";

export function useAgentStatus(pollMs = 30000): AgentStatus | undefined {
  const api = useApi();
  const [status, setStatus] = useState<AgentStatus>();
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.getAgentStatus().then(
        (s) => alive && setStatus(s),
        () => undefined,
      );
    void load();
    const id = window.setInterval(load, pollMs);
    const now = () => void load();
    window.addEventListener(AGENT_STATUS_REFRESH, now);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.removeEventListener(AGENT_STATUS_REFRESH, now);
    };
  }, [api, pollMs]);
  return status;
}

export function AgentStatusIndicator() {
  const t = useT();
  const { fmt } = useI18n();
  const status = useAgentStatus();
  if (!status) return null;
  const last = status.lastActivityAt ? new Date(status.lastActivityAt).getTime() : 0;
  const active = status.running || Date.now() - last < 5 * 60000;
  const label = active ? t("agent.active") : t("agent.idle");
  const tooltip = [status.currentTask, status.lastActivityAt ? t("agent.lastActivity", { time: fmt.relative(status.lastActivityAt) }) : t("agent.never")]
    .filter(Boolean)
    .join(" · ");
  return (
    <span title={tooltip} className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-gray-600">
      <span aria-hidden className={`h-2 w-2 rounded-full ${active ? "bg-green-600" : "bg-gray-400"}`} />
      {label}
      {status.lastActivityAt && <span className="hidden text-gray-400 xl:inline">· {fmt.relative(status.lastActivityAt)}</span>}
    </span>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyCommand({ text, compact }: { text: string; compact?: boolean }) {
  const t = useT();
  const toast = useToast();
  const [done, setDone] = useState(false);
  async function copy() {
    const ok = await copyText(text);
    setDone(ok);
    toast.show(ok ? t("agent.commandCopied") : t("common.unknownError"), { tone: ok ? "default" : "error" });
    window.setTimeout(() => setDone(false), 1500);
  }
  return (
    <div className="flex min-w-0 items-center gap-1">
      {!compact && <code className="min-w-0 truncate rounded border border-brand-muted/20 bg-gray-50 px-2 py-1 font-mono text-xs text-gray-700" title={text}>{text}</code>}
      <button type="button" onClick={copy} title={t("agent.copyCommand")} className="inline-flex items-center gap-1 rounded border border-brand-muted/30 bg-white px-2 py-1 text-xs text-gray-700 hover:border-brand-light/40 hover:text-brand">
        {done ? <IconCheck /> : <IconCopy />}
        {compact ? t("agent.copyCommand") : <span className="sr-only">{t("agent.copyCommand")}</span>}
      </button>
    </div>
  );
}
