/**
 * Project conventions (.coordinator/projects/<id>/notes.md) on the project page
 * (docs/ai/agent-human-parity.md #70, #71). The agent reads them at the start of
 * every session and only writes a line after the coordinator confirms it; here the
 * human writes the line directly. The server dates it and signs it with the role
 * ("confirmado por coordinador", no names). Append-only: to change a convention,
 * add a new line that supersedes it.
 */
import { useState } from "react";
import { useT } from "~/i18n";
import { ApiError, useApi, useAsync } from "~/lib/api";
import type { ProjectNotes } from "~/lib/api/types";
import { useToast } from "~/lib/components/Toast";
import { Button, inputCls } from "~/lib/components/ui";
import { noteLines } from "./project-notes";

const KINDS = ["convención", "decisión", "excepción", "alcance"] as const;

export function ProjectNotesPanel({ projectId }: { projectId: string }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const q = useAsync<ProjectNotes>(() => api.getProjectNotes(projectId), [api, projectId]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("convención");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lines = q.data ? noteLines(q.data.text) : [];
  const clean = text.replace(/\s+/g, " ").trim();
  const valid = clean.length >= 3 && clean.length <= 500;
  const today = new Date().toISOString().slice(0, 10);

  async function save() {
    if (!valid || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      q.setData(await api.appendProjectNote(projectId, clean, kind));
      setText("");
      setConfirmed(false);
      setAdding(false);
      toast.show(t("parity.notes.saved"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} className="mb-4 rounded-lg border border-brand-muted/20 bg-white px-3 py-2">
      <summary className="cursor-pointer select-none text-sm text-gray-700">
        <span className="font-medium">{t("parity.notes.title")}</span>
        <span className="ml-2 text-xs text-gray-500">{q.loading ? t("common.loading") : q.error ? t("parity.notes.unavailable") : t("parity.notes.count", { count: lines.length })}</span>
      </summary>
      {open && (
        <div className="mt-2 space-y-2 text-sm">
          <p className="text-xs text-gray-500">{t("parity.notes.hint")}</p>
          {lines.length ? (
            <ul className="max-h-56 space-y-1 overflow-y-auto">
              {lines.map((l, i) => (
                <li key={i} className="break-words rounded bg-gray-50 px-2 py-1 text-xs text-gray-800">
                  {l}
                </li>
              ))}
            </ul>
          ) : (
            !q.loading && <p className="text-xs text-gray-500">{t("parity.notes.empty")}</p>
          )}
          {!adding ? (
            <Button onClick={() => setAdding(true)} disabled={!!q.error}>
              {t("parity.notes.add")}
            </Button>
          ) : (
            <div className="space-y-2 rounded border border-brand-muted/30 p-2">
              <div className="flex flex-wrap gap-2">
                <label className="flex items-center gap-1 text-xs text-gray-600">
                  {t("parity.notes.kind")}
                  <select className={`${inputCls} text-xs`} value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <textarea
                className={`${inputCls} w-full text-sm`}
                rows={2}
                maxLength={500}
                value={text}
                placeholder={t("parity.notes.placeholder")}
                aria-label={t("parity.notes.text")}
                onChange={(e) => setText(e.target.value)}
              />
              {valid && (
                <p className="break-words rounded bg-brand-surface px-2 py-1 font-mono text-[11px] text-gray-700" aria-label={t("parity.notes.preview")}>
                  - {today} · [{kind}] {clean} ({t("parity.notes.signature")})
                </p>
              )}
              <label className="flex items-start gap-1.5 text-xs text-gray-700">
                <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                {t("parity.notes.confirm")}
              </label>
              {error && (
                <p role="alert" className="text-xs text-red-700">
                  {error}
                </p>
              )}
              <div className="flex gap-2">
                <Button variant="primary" disabled={!valid || !confirmed || busy} onClick={() => void save()}>
                  {t("parity.notes.save")}
                </Button>
                <Button onClick={() => (setAdding(false), setError(null))}>{t("common.cancel")}</Button>
                <span className="ml-auto self-center text-[11px] text-gray-500">{clean.length}/500</span>
              </div>
            </div>
          )}
        </div>
      )}
    </details>
  );
}
