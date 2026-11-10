/**
 * Batch review parts (spec §5.3–5.5): summary, issue previews, conflicts,
 * pre-flight status, irreversible-action confirmation, apply progress.
 */
import { useState, type ReactNode } from "react";
import { useI18n, useT } from "~/i18n";
import type { ApplyResponse, ApplyStatus, Batch, BatchItem, IssueDraft } from "~/lib/api/types";
import { Modal } from "~/lib/components/Modal";
import { IconAlert, IconCheck, Spinner } from "~/lib/components/icons";
import { Button, ProgressBar, cardCls, inputCls } from "~/lib/components/ui";
import { STATUS_KEY } from "~/lib/labels";
import { useApi } from "~/lib/api";
import { AssigneePicker, type AssigneeValue } from "~/lib/components/AssigneePicker";
import { typeChoices, useIssueOptions } from "~/lib/issue-options";
import { accIssueUrl } from "@core/issues/acc-links";

const PREFLIGHT_MAX_AGE = 10 * 60000;

export function preflightFresh(b: Batch): boolean {
  return !!b.lastPreflightAt && Date.now() - new Date(b.lastPreflightAt).getTime() < PREFLIGHT_MAX_AGE;
}

const irreversibleTag = "rounded border border-red-200 px-1 text-[10px] uppercase text-red-700";

export function BatchSummaryView({ batch, preflight }: { batch: Batch; preflight: ReactNode }) {
  const t = useT();
  const { fmt } = useI18n();
  const byDisc = Object.entries(batch.issuesByDiscipline)
    .map(([d, n]) => `${d} ${n}`)
    .join(", ");
  const conflicts = batch.items.filter((i) => i.conflict).length;
  return (
    <div className={`${cardCls} space-y-3 p-4 text-sm`}>
      <h2 className="font-semibold text-gray-800">{t("batch.willWrite")}</h2>
      <ul className="space-y-1.5">
        <li className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-green-700">+</span>
          {t("batch.issuesCreate", { count: batch.counts.issuesCreate })}
          {byDisc && <span className="text-gray-500">({byDisc})</span>}
          {batch.issueEffects?.clashesLinked ? <span className="text-gray-500">· {t("issue.linkedClashes", { count: batch.issueEffects.clashesLinked })}</span> : null}
          {batch.counts.issuesCreate > 0 && <span className={irreversibleTag}>{t("batch.irreversible")}</span>}
        </li>
        <li className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-amber-700">~</span>
          {t("batch.statusChanges", { count: batch.counts.statusChanges })}
          {batch.statusTransitions.length > 0 && (
            <span className="text-gray-500">
              {batch.statusTransitions.map((s) => t("batch.statusTransition", { from: t(STATUS_KEY[s.from]), to: t(STATUS_KEY[s.to]), count: s.count })).join(" · ")}
            </span>
          )}
        </li>
        {batch.counts.assignments > 0 && (
          <li className="flex items-center gap-2">
            <span className="font-mono text-gray-500">=</span>
            {t("batch.assignments", { count: batch.counts.assignments })}
          </li>
        )}
      </ul>
      <p className="text-gray-600">{t("batch.origin", batch.origin)}</p>
      <p className="text-gray-600">{t("batch.reviewCoverage", { pct: fmt.pct(batch.review.humanReviewedPct / 100), low: batch.review.lowConfidence })}</p>
      <div className="text-gray-600">{preflight}</div>
      {conflicts > 0 && <p className="text-amber-800">{t("batch.preflightConflicts", { count: conflicts })}</p>}
    </div>
  );
}

export function PreflightStatus({ batch, running }: { batch: Batch; running: boolean }) {
  const t = useT();
  const { fmt } = useI18n();
  if (running)
    return (
      <span className="inline-flex items-center gap-2">
        <Spinner /> {t("batch.preflightRunning")}
      </span>
    );
  if (!batch.lastPreflightAt) return <span className="text-amber-800">{t("batch.preflightNever")}</span>;
  if (!preflightFresh(batch)) return <span className="text-amber-800">{t("batch.preflightRequired")}</span>;
  return (
    <span className="inline-flex items-center gap-1 text-green-700">
      <IconCheck size={13} />
      {t("batch.preflightOk", { time: fmt.relative(batch.lastPreflightAt) })}
    </span>
  );
}

export function IssuePreviewCard({ item, readOnly, onSave, onToggle, projectId }: { item: BatchItem; readOnly: boolean; onSave: (patch: Partial<IssueDraft>) => void; onToggle: (excluded: boolean) => void; projectId?: string }) {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const issue = item.issue!;
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description);
  // G4/G5: the human confirms or overrides the issue type and the ACC assignee per issue.
  const opts = useIssueOptions(api, editing ? projectId : undefined);
  const [typeKey, setTypeKey] = useState(issue.issueType && issue.issueSubtype ? `${issue.issueType}|${issue.issueSubtype}` : "");
  const [assignee, setAssignee] = useState<AssigneeValue | null>(issue.assigneeId ? { id: issue.assigneeId, type: issue.assigneeType ?? "user", label: issue.assigneeLabel ?? issue.assigneeRole ?? issue.assigneeId } : null);
  const choices = typeChoices(opts?.types ?? []);
  const typeText = issue.issueTypeLabel ?? (issue.issueType ? `${issue.issueType.slice(0, 8)}…` : "—");
  const assigneeText = issue.assigneeLabel ?? issue.assigneeRole;
  function save() {
    const patch: Partial<IssueDraft> = { title, description };
    const c = choices.find((x) => `${x.typeId}|${x.subtypeId}` === typeKey);
    if (c && typeKey !== `${issue.issueType}|${issue.issueSubtype}`) Object.assign(patch, { issueType: c.typeId, issueSubtype: c.subtypeId, issueTypeLabel: c.label });
    if ((assignee?.id ?? "") !== (issue.assigneeId ?? "") || (assignee && assignee.type !== issue.assigneeType)) {
      Object.assign(patch, assignee ? { assigneeId: assignee.id, assigneeType: assignee.type, assigneeLabel: assignee.label } : { assigneeId: "" });
    }
    onSave(patch);
    setEditing(false);
  }
  return (
    <article className={`${cardCls} p-4 text-sm ${item.excluded ? "opacity-60" : ""}`}>
      <header className="mb-2 flex items-start justify-between gap-3">
        {editing ? (
          <input className={`${inputCls} flex-1`} value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t("issue.title")} />
        ) : (
          <h3 className="font-medium text-gray-900" lang="es">
            {issue.title}
          </h3>
        )}
        <label className="flex shrink-0 items-center gap-1 text-xs text-gray-600">
          <input type="checkbox" className="accent-brand" checked={!item.excluded} disabled={readOnly} onChange={(e) => onToggle(!e.target.checked)} />
          {item.excluded ? t("batch.excluded") : t("common.yes")}
        </label>
      </header>
      {editing ? (
        <textarea className={`${inputCls} h-40 w-full font-mono text-xs`} value={description} onChange={(e) => setDescription(e.target.value)} aria-label={t("issue.description")} />
      ) : (
        <pre className="whitespace-pre-wrap rounded bg-gray-50 p-2 font-sans text-xs text-gray-700" lang="es">
          {issue.description}
        </pre>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs md:grid-cols-3">
        <div>
          <dt className="text-gray-500">{t("issue.type")}</dt>
          <dd>
            {editing && choices.length ? (
              <select className={`${inputCls} w-full text-xs`} value={typeKey} onChange={(e) => setTypeKey(e.target.value)} aria-label={t("issue.type")}>
                <option value="">{t("accIssues.typeChoose")}</option>
                {choices.map((c) => (
                  <option key={`${c.typeId}|${c.subtypeId}`} value={`${c.typeId}|${c.subtypeId}`}>
                    {c.label}
                  </option>
                ))}
              </select>
            ) : (
              typeText
            )}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">{t("issue.assignee")}</dt>
          <dd>
            {editing ? (
              <AssigneePicker label={t("issue.assignee")} value={assignee} candidates={opts?.assignees ?? []} onChange={setAssignee} />
            ) : assigneeText ? (
              <>
                {assigneeText} <span className="text-gray-500">({issue.ownerDiscipline})</span>
              </>
            ) : (
              <span className="text-amber-800" title={t("accIssues.unassigned")}>
                {issue.ownerDiscipline} · {t("accIssues.none")}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">{t("issue.dueDate")}</dt>
          <dd>{fmt.date(issue.dueDate)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">{t("issue.location")}</dt>
          <dd>{issue.location ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-gray-500">{t("detail.field.priority")}</dt>
          <dd>{issue.priorityLabel ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-gray-500">{t("batch.snapshot")}</dt>
          <dd>{issue.includeView ? t("issue.snapshotAtApply") : "—"}</dd>
        </div>
      </dl>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 text-xs text-gray-500">
        {t("issue.linkedClashes", { count: issue.linkClashIds.length })}
        {/* G11: after apply, the created ACC issue opens in ACC Build. */}
        {item.result?.status === "applied" &&
          (item.result.accRefs ?? []).map((ref) => {
            const url = accIssueUrl(projectId, ref);
            return url ? (
              <a key={ref} href={url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                {t("accIssues.openIssue")}
              </a>
            ) : (
              <span key={ref} className="select-all font-mono">
                {ref}
              </span>
            );
          })}
      </p>
      {!readOnly && (
        <footer className="mt-3 flex justify-end gap-2">
          {editing ? (
            <>
              <Button onClick={() => setEditing(false)}>{t("common.cancel")}</Button>
              <Button
                variant="primary"
                onClick={save}
              >
                {t("common.save")}
              </Button>
            </>
          ) : (
            <Button onClick={() => setEditing(true)}>{t("common.edit")}</Button>
          )}
        </footer>
      )}
    </article>
  );
}

export function ConflictsList({ items, readOnly, onInclude, onReturn }: { items: BatchItem[]; readOnly: boolean; onInclude: (id: string, include: boolean) => void; onReturn: (id: string) => void }) {
  const t = useT();
  if (!items.length) return <p className="p-6 text-center text-sm text-gray-500">{t("batch.noConflicts")}</p>;
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.id} className={`${cardCls} flex flex-wrap items-center gap-3 p-3 text-sm`}>
          <IconAlert className="text-amber-700" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{i.label}</div>
            <div className="text-xs text-gray-600">{t("batch.conflictReason", { reason: i.conflict?.reason ?? "" })}</div>
          </div>
          <span className="text-xs text-gray-500">{i.excluded ? t("batch.excluded") : t("batch.includeAnyway")}</span>
          {!readOnly && (
            <>
              <Button onClick={() => onInclude(i.id, !!i.excluded)}>{i.excluded ? t("batch.includeAnyway") : t("batch.excluded")}</Button>
              <Button onClick={() => onReturn(i.id)}>{t("batch.returnToReview")}</Button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function changeCount(batch: Batch): number {
  return batch.counts.issuesCreate + batch.counts.statusChanges + batch.counts.assignments + batch.counts.comments;
}

/**
 * Typed confirmation. mode "approve": signs the approval (server requires the
 * word when the batch creates issues or has ≥ 50 changes). mode "apply": real
 * write to ACC, always behind the typed word.
 */
export function ApplyConfirmDialog({
  batch,
  mode,
  onCancel,
  onConfirm,
  busy,
  extra,
  confirmLabel,
}: {
  batch: Batch;
  mode: "approve" | "apply";
  onCancel: () => void;
  onConfirm: (word: string) => void;
  busy: boolean;
  /** Extra content (demo label, passkey hint, error). */
  extra?: ReactNode;
  confirmLabel?: string;
}) {
  const t = useT();
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState("");
  const total = changeCount(batch);
  const needWord = mode === "apply" || batch.counts.issuesCreate > 0 || total >= 50;
  const word = t("apply.confirmWord");
  const ok = checked && (!needWord || typed.trim().toLowerCase() === word.toLowerCase());
  return (
    <Modal
      title={mode === "approve" ? t("approve.title") : t("apply.title")}
      width="w-[520px]"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!ok || busy} onClick={() => onConfirm(typed.trim() || word)}>
            {confirmLabel ?? (mode === "approve" ? t("approve.button", { count: total }) : t("apply.button", { count: total }))}
          </Button>
        </>
      }
    >
      {mode === "approve" && <p className="mb-2 font-medium">{t("approve.body")}</p>}
      {extra}
      <p>{t("apply.intro", { project: batch.projectName })}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {batch.counts.issuesCreate > 0 && <li className="text-red-700">{t("apply.issuesWarning", { count: batch.counts.issuesCreate })}</li>}
        {batch.counts.statusChanges > 0 && <li>{t("apply.statusWarning", { count: batch.counts.statusChanges })}</li>}
      </ul>
      <p className="mt-2 text-gray-600">{t("apply.notifications")}</p>
      <label className="mt-4 flex items-center gap-2">
        <input type="checkbox" className="accent-brand" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        {t("apply.checkbox")}
      </label>
      {needWord && (
        <label className="mt-3 block">
          <span className="text-xs text-gray-600">{t("apply.typeToConfirm", { word })}</span>
          <input className={`${inputCls} mt-1 w-full font-mono`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      )}
    </Modal>
  );
}

export function ApplyProgress({ status }: { status: ApplyStatus }) {
  const t = useT();
  const done = status.state === "applied" || status.state === "partial";
  return (
    <div className={`${cardCls} space-y-3 p-4 text-sm`} aria-live="polite">
      <p className="font-medium">
        {done ? (status.state === "applied" ? t("apply.done", { count: status.issues.total + status.statuses.total }) : t("apply.partial", { count: status.failures.length })) : t("apply.progress")}
      </p>
      {status.issues.total > 0 && (
        <div>
          <p className="text-xs text-gray-600">{t("apply.progressIssues", { done: status.issues.done, total: status.issues.total })}</p>
          <ProgressBar done={status.issues.done} total={status.issues.total} />
        </div>
      )}
      {status.statuses.total > 0 && (
        <div>
          <p className="text-xs text-gray-600">{t("apply.progressStatuses", { done: status.statuses.done, total: status.statuses.total })}</p>
          <ProgressBar done={status.statuses.done} total={status.statuses.total} />
        </div>
      )}
      {!done && <p className="text-xs text-gray-500">{t("apply.canLeave")}</p>}
      {status.log.length > 0 && (
        <ul className="max-h-32 overflow-y-auto font-mono text-[11px] text-gray-600">
          {status.log.map((l, i) => (
            <li key={i} className={l.ok ? "" : "text-red-700"}>
              {l.text}
            </li>
          ))}
        </ul>
      )}
      {status.failures.length > 0 && (
        <table className="w-full text-xs">
          <tbody>
            {status.failures.map((f) => (
              <tr key={f.itemId} className="border-t border-red-100 text-red-700">
                <td className="py-1 font-mono">{f.label}</td>
                <td>{f.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Dry-run preview: the exact ACC requests the apply would send. */
export function DryRunPreview({ res, projectId }: { res: ApplyResponse; projectId?: string }) {
  const t = useT();
  if (res.refused) return <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{t("batch.refused", { message: res.refused.message })}</p>;
  return (
    <div className={`${cardCls} space-y-3 p-4 text-sm`}>
      <h2 className="font-semibold text-gray-800">{res.dryRun ? t("batch.dryRunTitle") : t("batch.result")}</h2>
      {res.dryRun && <p className="text-xs text-gray-600">{t("batch.dryRunHint")}</p>}
      {res.requests.map((r) => (
        <details key={r.idempotencyKey} className="rounded border border-brand-muted/20" open={res.requests.length <= 2}>
          <summary className="cursor-pointer px-3 py-2 text-xs">
            <span className="font-mono font-medium">POST {r.path}</span>
            <span className="ml-2 text-gray-600">{t("batch.requestSummary", { operation: r.operation, groups: r.groups, clashes: r.clashes })}</span>
            <span className={`ml-2 rounded px-1 ${r.outcome === "failed" || r.outcome === "refused" ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-700"}`}>{r.outcome}</span>
          </summary>
          {r.message && <p className="px-3 text-xs text-gray-600">{r.message}</p>}
          {r.body !== undefined && <pre className="max-h-72 overflow-auto border-t border-brand-muted/20 bg-gray-50 p-3 font-mono text-[11px] text-gray-800">{JSON.stringify(r.body, null, 2)}</pre>}
          {r.createdIssueIds && r.createdIssueIds.length > 0 && (
            <p className="flex flex-wrap gap-x-3 px-3 pb-2 font-mono text-[11px] text-green-800" aria-label={t("accIssues.createdIssues")}>
              {r.createdIssueIds.map((id) => {
                const url = accIssueUrl(projectId, id);
                return url ? (
                  <a key={id} href={url} target="_blank" rel="noopener noreferrer" className="underline hover:text-green-900" title={t("accIssues.openIssue")}>
                    {id}
                  </a>
                ) : (
                  <span key={id}>{id}</span>
                );
              })}
            </p>
          )}
        </details>
      ))}
    </div>
  );
}
