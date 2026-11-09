/**
 * M3 lens "Incidencias" (READ-ONLY verification, docs/PLAN-core-features-simplified.md §3):
 * discipline node (Copiar recordatorio) → issue row (one verdict chip) → ubicaciones.
 * The panel opens on "Verificación en vNN": verdict, existing/resolved, the 3
 * checks, template evidence, "Abrir en ACC", Aceptar / Rechazar (V01–V05).
 * Nothing is written to ACC: an accepted "resuelta" only reminds the coordinator
 * to move the issue to "En revisión" by hand (until M5).
 */
import { memo, useEffect, useRef, useState } from "react";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi } from "~/lib/api";
import type { IssueCheck, IssueVerdict, ReasonCode } from "~/lib/api/types";
import { PriorityChip } from "~/lib/components/badges";
import { IconChevronLeft, IconChevronRight, IconCopy, IconExternal, IconIssue } from "~/lib/components/icons";
import { Modal } from "~/lib/components/Modal";
import { useToast } from "~/lib/components/Toast";
import { Button, EmptyState, Kbd } from "~/lib/components/ui";
import { useTriageContext } from "./actions";
import { Section, useSectionPrefs } from "./detail-accordion";
import { indent } from "./FamilyRows";
import { useTriage, type Row } from "./store";

const VERDICT_CLS: Record<IssueVerdict, string> = {
  resuelta: "bg-green-50 text-green-800 border-green-200",
  avance: "bg-sky-50 text-sky-800 border-sky-200",
  sigue_abierta: "bg-amber-50 text-amber-900 border-amber-200",
  dice_resuelta: "bg-red-50 text-red-800 border-red-300",
  no_verificable: "bg-gray-50 text-gray-600 border-gray-300",
};

/** Suggested reject reason per verdict (preselected in the picker: Enter confirms). */
const SUGGESTED: Record<IssueVerdict, ReasonCode> = {
  resuelta: "V03",
  avance: "V05",
  sigue_abierta: "V02",
  dice_resuelta: "V01",
  no_verificable: "V02",
};
const V_CODES: ReasonCode[] = ["V01", "V02", "V03", "V04", "V05"];

/** One verdict chip: Resuelta n/n · Avance n/m · Sigue abierta · Dice resuelta ✕ · No verificable (tooltip: reason). */
export function VerdictChip({ check, large }: { check: IssueCheck; large?: boolean }) {
  const t = useT();
  const total = check.existing + check.resolved;
  const label =
    check.verdict === "resuelta"
      ? t("verdict.resuelta", { resolved: check.resolved, total })
      : check.verdict === "avance"
        ? t("verdict.avance", { resolved: check.resolved, total })
        : t(`verdict.${check.verdict}` as TKey);
  return (
    <span title={check.reason} className={`shrink-0 rounded border px-1 font-medium ${large ? "text-xs leading-5" : "text-[10px] leading-4"} ${VERDICT_CLS[check.verdict]}`}>
      {label}
    </span>
  );
}

function DecisionMark({ check }: { check: IssueCheck }) {
  const t = useT();
  if (check.decision)
    return (
      <span title={t(check.decision.kind === "accept" ? "issues.accepted" : "issues.rejected", { by: check.decision.decidedBy })} className={`shrink-0 text-xs ${check.decision.kind === "accept" ? "text-green-700" : "text-red-700"}`}>
        {check.decision.kind === "accept" ? "✓" : "✕"}
      </span>
    );
  return <IconIssue size={13} label={t("issues.issueIcon", { status: check.accStatus })} className="shrink-0 text-brand" />;
}

/** Issue row in the tree: priority · verdict chip · (overdue / stuck as text) · counts · state icon. */
export const IssueRow = memo(function IssueRow({ row }: { row: Row }) {
  const t = useT();
  const { fmt } = useI18n();
  const { store } = useTriageContext();
  const isCursor = useTriage(store, (s) => s.cursorKey === row.key);
  const open = useTriage(store, (s) => s.expanded.has(row.id));
  const c = useTriage(store, (s) => s.issueChecks.get(row.id));
  if (!c) return null;
  const extra = [c.overdue ? t("issues.overdue") : "", c.stuckCycles >= 2 ? t("issues.stuck", { count: c.stuckCycles }) : ""].filter(Boolean).join(" · ");
  return (
    <div
      id={`row-${row.key}`}
      role="treeitem"
      aria-level={2}
      aria-expanded={open}
      aria-selected={isCursor}
      title={`${c.title}\n${c.reason}`}
      className={`group/row flex h-full cursor-pointer select-none items-stretch gap-1 border-b border-brand-muted/10 pr-2 ${isCursor ? "border-l-2 border-l-brand bg-brand-surface" : "border-l-2 border-l-transparent hover:bg-gray-50"}`}
      style={{ paddingLeft: indent(row.depth) }}
      onClick={() => store.setCursor(row.key)}
      onDoubleClick={() => store.toggleExpand(row.id)}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? t("list.collapse") : t("list.expand")}
        onClick={(ev) => {
          ev.stopPropagation();
          store.toggleExpand(row.id);
        }}
        className="flex w-5 shrink-0 items-center justify-center text-gray-400 hover:text-brand"
      >
        {open ? "▾" : "▸"}
      </button>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {c.priority && <PriorityChip value={c.priority} />}
          <span className="shrink-0 font-mono text-[11px] text-gray-600">{c.displayId ? `#${c.displayId}` : c.issueId.slice(0, 10)}</span>
          <VerdictChip check={c} />
          {extra && <span className="truncate text-[10px] font-medium text-red-700">{extra}</span>}
          <span className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-gray-500">{t("issues.rowCounts", { existing: fmt.number(c.existing), resolved: fmt.number(c.resolved) })}</span>
          <DecisionMark check={c} />
        </div>
        <div className="truncate text-sm text-gray-900">{c.title}</div>
      </div>
    </div>
  );
});

/** "Copiar recordatorio" on the discipline header row (server text → clipboard + toast). */
export function CopyReminderButton({ discipline }: { discipline: string }) {
  const t = useT();
  const toast = useToast();
  const { store } = useTriageContext();
  const r = useTriage(store, (s) => s.reminders.get(discipline));
  if (!r) return null;
  return (
    <button
      type="button"
      title={r.text}
      onClick={(ev) => {
        ev.stopPropagation();
        navigator.clipboard?.writeText(r.text).then(
          () => toast.show(t("issues.reminderCopied", { discipline })),
          () => toast.show(t("issues.copyFailed"), { tone: "error" }),
        );
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded border border-brand-muted/30 bg-white px-1.5 py-0.5 text-[11px] text-gray-700 hover:border-brand hover:text-brand"
    >
      <IconCopy size={11} />
      {t("issues.copyReminder")}
    </button>
  );
}

/** Accept / reject a verdict (server stores it; READ-ONLY against ACC). */
export function useIssueDecision() {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const { store } = useTriageContext();
  return async (c: IssueCheck, decision: "accept" | "reject", reasonCode?: ReasonCode, note?: string) => {
    const testId = store.state.payload?.test.id ?? "";
    try {
      const res = await api.decideIssueVerdict(testId, c.issueId, { decision, reasonCode, note });
      store.applyIssueDecision(c.issueId, res.decision ?? { kind: decision, reasonCode, note, decidedBy: "", decidedAt: new Date().toISOString() });
      toast.show(decision === "reject" ? t("issues.rejectedToast") : c.verdict === "resuelta" ? t("issues.acceptedResuelta") : t("issues.acceptedMeeting"));
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), { tone: "error" });
    }
  };
}

function CheckLine({ label, state, okKey, badKey }: { label: string; state: string; okKey: TKey; badKey: TKey }) {
  const t = useT();
  const ok = state === "ok";
  const unknown = state === "unknown";
  return (
    <li className="flex items-center gap-1.5">
      <span className={`w-3 text-center font-bold ${ok ? "text-green-700" : unknown ? "text-gray-400" : "text-red-700"}`}>{ok ? "✓" : unknown ? "–" : "✕"}</span>
      <span className="text-gray-500">{label}:</span>
      <span className="text-gray-800">{ok ? t(okKey) : unknown ? t("issues.check.unknown") : t(badKey)}</span>
    </li>
  );
}

/** "Verificación en vNN" (opened first in the Incidencias lens). */
export function VerificationSection({ check }: { check: IssueCheck }) {
  const t = useT();
  const { fmt } = useI18n();
  const toast = useToast();
  const { store } = useTriageContext();
  const version = useTriage(store, (s) => s.issueVersion ?? s.payload?.test.modelSetVersion);
  const decide = useIssueDecision();
  const { prefs, set } = useSectionPrefs();
  const open = prefs.verification !== false;
  return (
    <Section id="verification" title={t("issues.sectionTitle", { version: version ?? "—" })} open={open} onToggle={() => set("verification", !open)}>
      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <VerdictChip check={check} large />
          <span className="text-xs text-gray-600">{t("issues.counts", { existing: fmt.number(check.existing), resolved: fmt.number(check.resolved) })}</span>
          {check.overdue && <span className="text-xs font-medium text-red-700">{t("issues.overdueDue", { date: check.dueDate ? fmt.date(check.dueDate) : "—" })}</span>}
          {check.stuckCycles >= 2 && <span className="text-xs font-medium text-red-700">{t("issues.stuck", { count: check.stuckCycles })}</span>}
        </div>
        <p className="text-xs text-gray-700">{check.reason}</p>
        <ul className="space-y-0.5 text-xs" aria-label={t("issues.checksLabel")}>
          <CheckLine label={t("issues.check.displacement")} state={check.checks.displacement} okKey="issues.check.displacementOk" badKey="issues.check.displacementBlocked" />
          <CheckLine label={t("issues.check.modelAge")} state={check.checks.modelAge} okKey="issues.check.modelAgeOk" badKey="issues.check.modelAgeStale" />
          <CheckLine label={t("issues.check.scope")} state={check.checks.scope} okKey="issues.check.scopeOk" badKey="issues.check.scopeOut" />
        </ul>
        <div className="rounded border border-brand-muted/20 bg-gray-50 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{t("issues.evidence")}</span>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(check.evidence).then(() => toast.show(t("issues.evidenceCopied")), () => toast.show(t("issues.copyFailed"), { tone: "error" }))}
              className="inline-flex items-center gap-1 text-[11px] text-brand hover:underline"
            >
              <IconCopy size={11} />
              {t("issues.copy")}
            </button>
          </div>
          <pre className="whitespace-pre-wrap break-words font-sans text-xs text-gray-800">{check.evidence}</pre>
        </div>
        <p className="flex items-center gap-1 text-xs text-gray-600">
          <IconExternal size={12} />
          {/* The contract has no issue URL yet: show the ACC id (copyable) to find it in ACC. */}
          {t("issues.openInAcc")}: <span className="select-all font-mono">{check.displayId ? `#${check.displayId}` : check.issueId}</span>
          <span className="text-gray-400">· {t("issues.accStatus", { status: check.accStatus })}</span>
        </p>
        {check.decision ? (
          <div className="rounded border border-brand-muted/20 px-2 py-1.5 text-xs">
            <p>
              {t(check.decision.kind === "accept" ? "issues.accepted" : "issues.rejected", { by: check.decision.decidedBy || "—" })}
              {check.decision.reasonCode && ` · ${check.decision.reasonCode} ${t(`reasons.${check.decision.reasonCode}` as TKey)}`}
            </p>
            {check.decision.kind === "accept" && check.verdict === "resuelta" && <p className="mt-0.5 font-medium text-brand">{t("issues.moveReminder")}</p>}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            <button type="button" onClick={() => void decide(check, "accept")} className="flex items-center justify-center gap-1 rounded bg-brand px-2 py-1.5 text-xs font-medium text-white hover:bg-brand-light">
              {check.verdict === "resuelta" ? t("issues.acceptResuelta") : t("issues.acceptMeeting")} <kbd className="rounded border border-white/40 px-1 font-mono text-[10px]">A</kbd>
            </button>
            <button type="button" onClick={() => store.setDialog({ type: "issueReject", issueId: check.issueId })} className="flex items-center justify-center gap-1 rounded border border-brand-muted/30 px-2 py-1.5 text-xs text-gray-700 hover:border-brand-light/40">
              {t("actions.reject")} <Kbd>X</Kbd>
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}

/** Right pane for an issue row. */
export function IssuePanel({ issueId }: { issueId: string }) {
  const t = useT();
  const { store } = useTriageContext();
  const c = useTriage(store, (s) => s.issueChecks.get(issueId));
  if (!c) return <EmptyState title={t("detail.noSelection")} />;
  const groups = c.groupIds.filter((g) => store.state.groups.has(g));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex-shrink-0 border-b border-brand-muted/20 px-4 pb-2 pt-3">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-gray-900">{c.title}</h2>
          <span className="flex shrink-0 gap-0.5">
            <button type="button" aria-label={t("shortcuts.prev")} onClick={() => store.move(-1)} className="rounded p-0.5 text-gray-500 hover:bg-brand-surface">
              <IconChevronLeft size={14} />
            </button>
            <button type="button" aria-label={t("shortcuts.next")} onClick={() => store.move(1)} className="rounded p-0.5 text-gray-500 hover:bg-brand-surface">
              <IconChevronRight size={14} />
            </button>
          </span>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
          {c.priority && <PriorityChip value={c.priority} />}
          <span>{t("issues.responsible", { discipline: c.discipline })}</span>
          <span className="ml-auto font-mono text-[11px] text-gray-400">{c.displayId ? `#${c.displayId}` : c.issueId}</span>
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" id="triage-detail" tabIndex={-1}>
        <VerificationSection check={c} />
        <section className="border-t border-brand-muted/20 px-4 py-2 text-xs">
          <h3 className="mb-1 font-semibold uppercase tracking-wide text-gray-500">{t("issues.locations", { count: groups.length })}</h3>
          <ul className="divide-y divide-brand-muted/10">
            {groups.map((gid) => {
              const g = store.state.groups.get(gid)!;
              return (
                <li key={gid} className="py-1">
                  <button type="button" onClick={() => store.reveal(`g:${gid}`)} className="w-full truncate text-left text-gray-800 hover:text-brand hover:underline" title={g.title}>
                    {g.hostLevelLabel ?? g.location?.level ?? "—"} · {g.title}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}

/** Rechazar with a V01–V05 picker: the suggested code is preselected, Enter confirms (≤ 2 keystrokes). */
export function IssueRejectDialog({ issueId }: { issueId: string }) {
  const t = useT();
  const { store } = useTriageContext();
  const c = useTriage(store, (s) => s.issueChecks.get(issueId));
  const decide = useIssueDecision();
  const [code, setCode] = useState<ReasonCode>(c ? SUGGESTED[c.verdict] : "V01");
  const [note, setNote] = useState("");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  if (!c) return null;
  const close = () => store.setDialog(null);
  const confirm = () => {
    close();
    void decide(c, "reject", code, note.trim() || undefined);
  };
  return (
    <Modal
      title={t("issues.rejectTitle")}
      onClose={close}
      onKeyDown={(e) => {
        const n = Number(e.key);
        if (n >= 1 && n <= 5 && !(e.target instanceof HTMLTextAreaElement)) setCode(V_CODES[n - 1]);
        if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
          e.preventDefault();
          confirm();
        }
      }}
      footer={
        <>
          <Button onClick={close}>{t("common.cancel")}</Button>
          <Button variant="danger" onClick={confirm}>
            {t("actions.reject")}
          </Button>
        </>
      }
    >
      <fieldset className="space-y-1 text-sm">
        <legend className="mb-1 text-xs text-gray-600">{t("issues.rejectHint")}</legend>
        {V_CODES.map((v, i) => (
          <label key={v} className="flex items-center gap-2 text-xs">
            <input ref={v === code ? first : undefined} type="radio" name="vcode" checked={code === v} onChange={() => setCode(v)} className="accent-brand" />
            <Kbd>{i + 1}</Kbd>
            <span className="font-mono text-[11px] text-gray-500">{v}</span> {t(`reasons.${v}` as TKey)}
            {v === SUGGESTED[c.verdict] && <span className="rounded bg-brand-surface px-1 text-[10px] text-brand">{t("reasons.suggested")}</span>}
          </label>
        ))}
      </fieldset>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("reasons.note")} rows={2} className="mt-2 w-full rounded border border-brand-muted/30 px-2 py-1 text-xs" />
    </Modal>
  );
}
