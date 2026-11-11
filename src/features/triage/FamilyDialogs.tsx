/**
 * "Aprobar familia" mandatory confirmation (proposal §4.2, §5.2 item 5) and
 * "Rechazar propuesta de familia". High blast radius: the dialog states how
 * many clashes and instances the decision touches, lists every instance whose
 * current validity would change (each needs an explicit tick), lists real
 * instances a closing decision will NOT touch, and blocks until the spot-check
 * and exception reasons are complete.
 */
import { useEffect, useState } from "react";
import { useT } from "~/i18n";
import { ApiError, useApi } from "~/lib/api";
import type { CoordinatorApi } from "~/lib/api";
import type { FamilyDecisionPreview, FamilyDecisionRequest, ReasonCode, TriageFamily } from "~/lib/api/types";
import { Modal } from "~/lib/components/Modal";
import { ValidityBadge } from "~/lib/components/badges";
import { useToast } from "~/lib/components/Toast";
import { Button } from "~/lib/components/ui";
import { VALIDITY_KEY } from "~/lib/labels";
import { REASONS_BY_FIELD, useTriageContext } from "./actions";
import { FAMILY_ACTION_KEY, clashCount, familyImpact, instanceLabel } from "./FamilyPanel";
import { useTriage, type FamilyDraft, type TriageStore } from "./store";

function decisionRequest(store: TriageStore, f: TriageFamily, draft: FamilyDraft, spotChecked: string[], acknowledge: boolean): FamilyDecisionRequest {
  return {
    testId: store.state.payload?.test.id ?? "",
    decision: "approve",
    validity: draft.validity,
    action: draft.action,
    responsibleDiscipline: draft.responsibleDiscipline,
    secondaryDiscipline: f.proposed.secondaryDiscipline,
    solutionOption: draft.solutionOption,
    typicalDetail: f.tags.includes("tipico") ? { name: f.title.slice(0, 120), note: draft.typicalNote?.slice(0, 400) || undefined } : undefined,
    issueMode: store.state.familySplit.has(f.id) ? "per_instance" : "family",
    spotChecked,
    acknowledgeValidityChanges: acknowledge,
  };
}

/** Push pending exception changes (added, edited, removed) before the decision. */
async function syncExceptions(api: CoordinatorApi, store: TriageStore, f: TriageFamily) {
  const testId = store.state.payload?.test.id ?? "";
  const pending = store.state.familyExceptions.get(f.id) ?? new Map<string, string>();
  const server = new Map(f.exceptions.map((e) => [e.groupId, e.reason]));
  for (const [groupId, reason] of pending) if (server.get(groupId) !== reason.trim()) await api.setFamilyException(f.id, { testId, groupId, reason: reason.trim() });
  for (const groupId of server.keys()) if (!pending.has(groupId)) await api.setFamilyException(f.id, { testId, groupId, reason: "", remove: true });
}

export function FamilyApproveDialog({ familyId }: { familyId: string }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const { store } = useTriageContext();
  const f = useTriage(store, (s) => s.families.get(familyId));
  useTriage(store, (s) => s.familyExceptions);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FamilyDecisionPreview | null>(null);
  const draft = f ? store.familyDraft(f.id)! : null;
  const draftKey = JSON.stringify(draft);
  // Server preview (authoritative counts and validity changes); the local computation is the fallback.
  useEffect(() => {
    if (!f || !draft) return;
    let alive = true;
    api.previewFamilyDecision(f.id, decisionRequest(store, f, draft, [], false)).then(
      (p) => alive && setPreview(p),
      () => undefined,
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, f?.id, draftKey]);
  if (!f || !draft) return null;
  const impact = familyImpact(store, f, draft);
  // Instances to acknowledge: union of the server preview and the local check.
  const changeIds = new Set([...impact.validityChanges.map((g) => g.id), ...(preview?.validityChanges.map((v) => v.groupId) ?? [])]);
  const changeRows = [...changeIds].map((id) => store.state.groups.get(id)).filter((g): g is NonNullable<typeof g> => !!g);
  // Instances inherited but changed / reappeared / gated: they stay pending until confirmed one by one.
  const pendingConfirm = impact.pendingConfirm;
  const close = () => store.setDialog(null);
  const spotOk = impact.spotDone.length >= impact.spotRequired;
  const missingReason = impact.excepted.filter((x) => !x.reason.trim());
  const allTicked = changeRows.every((g) => ticked.has(g.id));
  const canConfirm = spotOk && !missingReason.length && allTicked && impact.applied.length > 0 && !busy;
  const toggle = (id: string) =>
    setTicked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function confirm() {
    if (!f || !canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      await syncExceptions(api, store, f);
      await api.decideFamily(f.id, decisionRequest(store, f, draft!, impact.spotDone, changeRows.length > 0));
      store.recordFamilyDecision("accept");
      store.applyFamilies(await api.getFamilies(store.state.payload?.test.id ?? ""), f.id);
      toast.show(t("families.approved", { instances: impact.applied.length, clashes: impact.affectedClashes }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("families.approveTitle")}
      onClose={close}
      width="w-[560px]"
      footer={
        <>
          <Button onClick={close}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!canConfirm} onClick={() => void confirm()}>
            {t("families.approveConfirm", { instances: impact.applied.length })}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="rounded border border-brand/30 bg-brand-surface px-3 py-2 text-base font-semibold text-gray-900" role="status">
          {t("families.blastRadius", { clashes: impact.affectedClashes, instances: impact.applied.length })}
        </p>
        <p className="text-sm font-medium text-gray-900">
          {t("families.approveSummary", { validity: t(VALIDITY_KEY[draft.validity]), action: t(FAMILY_ACTION_KEY[draft.action]), owner: draft.responsibleDiscipline })}
          {impact.excepted.length > 0 && ` · ${t("families.exceptionsCount", { count: impact.excepted.length })}`}
        </p>
        <p className="text-xs text-gray-700">{t("families.approveExplain", { instances: impact.applied.length })}</p>

        {changeRows.length > 0 && (
          <fieldset className="min-w-0 rounded border border-amber-300 bg-amber-50 p-2">
            <legend className="px-1 text-xs font-semibold text-amber-900">{t("families.validityChangesTitle", { count: changeRows.length })}</legend>
            <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
              {changeRows.map((g) => (
                <li key={g.id}>
                  <label className="flex min-w-0 items-center gap-1.5">
                    <input type="checkbox" className="h-3.5 w-3.5 accent-amber-700" checked={ticked.has(g.id)} onChange={() => toggle(g.id)} />
                    <span className="min-w-0 flex-1 truncate" title={g.title}>
                      {instanceLabel(g)} · {g.title}
                    </span>
                    <ValidityBadge value={g.validity} />
                    <span aria-hidden="true">→</span>
                    <ValidityBadge value={draft.validity} />
                    <span className="shrink-0 font-mono text-[11px] text-gray-500">×{clashCount(g)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}

        {pendingConfirm.length > 0 && (
          <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            <p className="font-semibold">{t("families.pendingConfirmTitle", { count: pendingConfirm.length })}</p>
            <p>{t("families.pendingConfirmBody")}</p>
            <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-4">
              {pendingConfirm.map((g) => (
                <li key={g.id} className="truncate" title={g.title}>
                  {instanceLabel(g)} · {g.title}
                </li>
              ))}
            </ul>
          </div>
        )}
        {impact.protectedReal.length > 0 && (
          <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-900">
            <p className="font-semibold">{t("families.protectedRealTitle", { count: impact.protectedReal.length })}</p>
            <p>{t("families.protectedRealBody")}</p>
          </div>
        )}

        {preview && <p className="text-xs text-gray-600">{t("families.previewIssues", { count: preview.issues })}</p>}
        {!spotOk && (
          <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
            <p className="font-medium">{t("families.spotCheckNeeded", { count: impact.spotRequired, done: impact.spotDone.length })}</p>
            {impact.spotRequired > 1 && <p className="mt-0.5">{t("families.spotCheckWhy")}</p>}
          </div>
        )}
        {missingReason.length > 0 && <p className="text-xs text-amber-800">{t("families.exceptionReasonMissing", { count: missingReason.length })}</p>}
        {impact.applied.length === 0 && <p className="text-xs text-amber-800">{t("families.nothingToApply")}</p>}
        <p className="text-[11px] text-gray-500">{t("families.approveFootnote")}</p>
        {error && (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export function FamilyRejectDialog({ familyId }: { familyId: string }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const { store } = useTriageContext();
  const f = useTriage(store, (s) => s.families.get(familyId));
  const [code, setCode] = useState<ReasonCode>("R07");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!f) return null;
  const close = () => store.setDialog(null);
  async function confirm() {
    if (!f) return;
    setBusy(true);
    try {
      const testId = store.state.payload?.test.id ?? "";
      await api.decideFamily(f.id, { testId, decision: "reject", note: [code, note.trim()].filter(Boolean).join(" · ") });
      store.recordFamilyDecision("reject");
      store.applyFamilies(await api.getFamilies(testId), f.id);
      toast.show(t("families.rejected"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t("families.rejectTitle")}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || (code === "R99" && !note.trim())} onClick={() => void confirm()}>
            {t("families.splitConfirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm">
        <p className="text-xs text-gray-600">{t("families.rejectBody")}</p>
        <fieldset className="space-y-1">
          {REASONS_BY_FIELD.reject.map((c) => (
            <label key={c} className="flex items-center gap-2 text-xs">
              <input type="radio" name="family-reason" checked={code === c} onChange={() => setCode(c)} className="accent-brand" />
              <span className="font-mono text-[11px] text-gray-500">{c}</span> {t(`reasons.${c}` as Parameters<typeof t>[0])}
            </label>
          ))}
        </fieldset>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("reasons.note")} className="w-full rounded border border-brand-muted/30 px-2 py-1 text-xs" rows={2} />
        {error && (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
