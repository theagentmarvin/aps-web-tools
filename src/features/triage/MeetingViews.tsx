/**
 * M4 lens "Reunión" (docs/PLAN-core-features-simplified.md §2, F4; no new page):
 * - "Nota de reunión": opened first in the panel, key N focuses it, debounced
 *   autosave ("Guardado hh:mm"); decisions are still taken in "Aprobar grupo".
 * - "Guardar vista": stores the viewer camera for the grupo (local only).
 * - "Imprimir agenda": window.print() with a print-only agenda (no viewer).
 */
import { useEffect, useRef, useState } from "react";
import { useI18n, useT } from "~/i18n";
import { useApi } from "~/lib/api";
import { useToast } from "~/lib/components/Toast";
import { useTriageContext } from "./actions";
import { Section, useSectionPrefs } from "./detail-accordion";
import { useTriage } from "./store";

type ApsViewer = { getState?: (filter?: unknown) => unknown; restoreState?: (state: unknown, filter?: unknown, immediate?: boolean) => boolean };
export function apsViewer(): ApsViewer | null {
  try {
    return (window as unknown as { __apsViewer?: { getViewer: () => ApsViewer | null } }).__apsViewer?.getViewer() ?? null;
  } catch {
    return null;
  }
}

/** "Nota de reunión" for the row under the cursor (grupo, ubicación, or the issue's grupo). */
export function MeetingNoteSection({ rowKey }: { rowKey: string }) {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const { store } = useTriageContext();
  const target = store.noteTargetOf(rowKey);
  const noteKey = target ? `${target.targetType}:${target.targetId}` : "";
  const note = useTriage(store, (s) => s.notes.get(noteKey));
  const reason = useTriage(store, (s) => s.agendaReason.get(rowKey));
  const familyId = store.viewFamilyOf(rowKey);
  const view = useTriage(store, (s) => (familyId ? s.savedViews.get(familyId) : undefined));
  const [text, setText] = useState(note?.text ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [savedAt, setSavedAt] = useState<string | undefined>(note?.updatedAt);
  const timer = useRef<number | null>(null);
  const { prefs, set } = useSectionPrefs();
  const open = prefs.meetingNote !== false;

  // Saved view of this grupo: loaded lazily (null = none).
  useEffect(() => {
    if (!familyId || store.state.savedViews.has(familyId)) return;
    const testId = store.state.payload?.test.id ?? "";
    api.getFamilyView(testId, familyId).then(
      (v) => store.setSavedView(familyId, v),
      () => store.setSavedView(familyId, null),
    );
  }, [api, familyId, store]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  if (!target) return null;
  function onChange(v: string) {
    setText(v);
    setStatus("saving");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const testId = store.state.payload?.test.id ?? "";
      api.putNote(testId, target!.targetType, target!.targetId, v).then(
        (n) => {
          store.upsertNote({ ...n, text: v });
          setSavedAt(n.updatedAt);
          setStatus("saved");
        },
        () => setStatus("error"),
      );
    }, 800);
  }
  return (
    <Section id="meetingNote" title={t("meeting.noteTitle")} open={open} onToggle={() => set("meetingNote", !open)}>
      {reason && <p className="mb-1.5 text-xs text-gray-600">{t("meeting.onAgenda", { reason })}</p>}
      <label htmlFor="meeting-note" className="sr-only">
        {t("meeting.noteTitle")}
      </label>
      <textarea
        id="meeting-note"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        maxLength={2000}
        rows={4}
        placeholder={t("meeting.notePlaceholder")}
        className="w-full rounded border border-brand-muted/30 px-2 py-1.5 text-sm focus:border-brand focus:outline-none"
      />
      <p className="mt-1 flex items-center justify-between text-[11px] text-gray-500" role="status">
        <span>
          {status === "saving"
            ? t("meeting.saving")
            : status === "error"
              ? <span className="text-red-700">{t("meeting.saveFailed")}</span>
              : savedAt
                ? t("meeting.savedAt", { time: fmt.time(savedAt) })
                : t("meeting.noteHint")}
        </span>
        {familyId && <span>{view ? t("meeting.viewSaved", { time: fmt.time(view.savedAt) }) : t("meeting.noView")}</span>}
      </p>
    </Section>
  );
}

/** Viewer toolbar button (lens Reunión only): save the camera for the grupo of the cursor row. */
export function SaveViewButton({ className }: { className: string }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const { store } = useTriageContext();
  const familyId = useTriage(store, (s) => store.viewFamilyOf(s.cursorKey));
  const ready = useTriage(store, (s) => s.viewer.status === "ready");
  if (!familyId) return null;
  async function save() {
    const v = apsViewer();
    const camera = v?.getState?.({ viewport: true });
    if (!camera || !familyId) return toast.show(t("meeting.noViewer"), { tone: "error" });
    try {
      const saved = await api.putFamilyView(store.state.payload?.test.id ?? "", familyId, camera);
      store.setSavedView(familyId, saved);
      toast.show(t("meeting.viewSavedToast"));
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), { tone: "error" });
    }
  }
  return (
    <button type="button" disabled={!ready} title={ready ? t("meeting.saveViewTip") : t("meeting.noViewer")} onClick={() => void save()} className={`${className} disabled:opacity-40`}>
      {t("meeting.saveView")}
    </button>
  );
}

/** Restore the saved camera when a grupo with a saved view is selected (lens Reunión). */
export function restoreSavedView(camera: unknown): boolean {
  const v = apsViewer();
  if (!v?.restoreState || !camera) return false;
  try {
    return v.restoreState(camera, { seedURN: false, objectSet: false, viewport: true, renderOptions: false }, false);
  } catch {
    return false;
  }
}

/** Print-only agenda (hidden on screen): discipline → items with reason and notes. */
export function PrintAgenda() {
  const t = useT();
  const { fmt } = useI18n();
  const { store } = useTriageContext();
  const agenda = useTriage(store, (s) => s.agenda);
  const notes = useTriage(store, (s) => s.notes);
  const payload = useTriage(store, (s) => s.payload);
  if (!agenda.length || !payload) return null;
  const noteOf = (familyId?: string, groupIds?: string[]) =>
    [familyId ? notes.get(`family:${familyId}`)?.text : undefined, ...(groupIds ?? []).map((g) => notes.get(`group:${g}`)?.text)].filter(Boolean).join(" · ");
  return (
    <div className="print-agenda" aria-hidden="true">
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>{t("meeting.printTitle", { project: payload.project.name, modelSet: payload.modelSet.name, version: payload.test.modelSetVersion })}</h1>
      <p style={{ fontSize: 11, color: "#555" }}>{t("meeting.printDate", { date: fmt.date(new Date().toISOString()) })}</p>
      {agenda.map((d) => (
        <section key={d.discipline} style={{ marginTop: 14, breakInside: "avoid-page" }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, borderBottom: "1px solid #999" }}>
            {d.discipline} · {d.summary}
          </h2>
          <ol style={{ paddingLeft: 18, fontSize: 12 }}>
            {d.items.map((i, k) => {
              const note = noteOf(i.familyId, i.groupIds);
              return (
                <li key={k} style={{ marginTop: 6 }}>
                  <strong>P{i.priority}</strong> · {t(`meeting.kind.${i.kind}`)} · {i.title}
                  <div style={{ color: "#444" }}>{i.reason}</div>
                  {note && <div style={{ fontStyle: "italic" }}>{t("meeting.printNote", { note })}</div>}
                </li>
              );
            })}
          </ol>
          {d.more > 0 && <p style={{ fontSize: 11 }}>{t("meeting.more", { count: d.more })}</p>}
        </section>
      ))}
    </div>
  );
}

/** "Imprimir agenda": print only the agenda (body[data-print="agenda"] + @media print). */
export function printAgenda() {
  document.body.dataset.print = "agenda";
  const done = () => {
    delete document.body.dataset.print;
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
}
