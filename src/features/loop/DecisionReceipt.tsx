/**
 * Decision receipt (C4): stays in the panel until the group changes (not a toast). Says what changed
 * and what the rules learned — every number from the server response (`receipt.learning`, same tally
 * as Reglas). Variants: aceptado · corrección · umbral cruzado · agente aceptado · una por una · deshecha.
 */
import { Link } from "react-router";
import { useT } from "~/i18n";
import type { FamilyDecisionReceipt, LearningEntry } from "~/lib/api/types";
import { ActorMark } from "./actors";
import { pct } from "./OriginBadge";

/** Event the triage workspace listens to: opens «Enviar a aprobación». */
export const SEND_TO_APPROVAL_EVENT = "coord:send-to-approval";

/** «+7 aciertos EST-004 · 1 corrección TOL-001 (Dentro de tolerancia → Conflicto)». */
export function learningParts(t: ReturnType<typeof useT>, entries: LearningEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.hits > 0) out.push(t("loop.cons.hits", { count: e.hits, id: e.ruleId }));
    for (const c of e.corrections) if (c.count > 0) out.push(t("loop.cons.corr", { count: c.count, id: e.ruleId, label: c.label }));
  }
  return out;
}

export function DecisionReceipt({ receipt, onUndo, undoBusy, corrected }: { receipt: FamilyDecisionReceipt; onUndo?: () => void; undoBusy?: boolean; corrected?: boolean }) {
  const t = useT();
  const r = receipt;
  const parts = learningParts(t, r.learning);
  const corrections = r.learning.flatMap((e) => e.corrections.filter((c) => c.count > 0).map((c) => ({ ...c, ruleId: e.ruleId })));
  const crossed = r.learning.filter((e) => e.thresholdCrossed);
  const ready = r.readyToSend.families + r.readyToSend.groups;
  const title =
    r.kind === "undone" ? t("loop.receipt.undone") : r.kind === "rejected" ? t("loop.receipt.rejected") : r.agent ? t("loop.receipt.agent") : corrected || corrections.length ? t("loop.receipt.corrected") : t("loop.receipt.approved");
  return (
    <section role="status" aria-live="polite" className="mx-4 mt-3 rounded-lg border border-actor-human-bd bg-actor-human-bg px-3 py-2 text-xs text-gray-800">
      <p className="flex items-center gap-1.5 font-semibold text-actor-human">
        <span aria-hidden="true">{r.agent && r.kind === "approved" ? "✦" : "●"}</span>
        <span className="min-w-0 flex-1">{title}</span>
        {onUndo && r.kind !== "undone" && (
          <button type="button" onClick={onUndo} disabled={undoBusy} className="font-normal text-brand hover:underline disabled:opacity-50">
            {undoBusy ? t("loop.receipt.undoing") : t("loop.receipt.undo")}
          </button>
        )}
      </p>
      {r.kind === "approved" && <p className="mt-0.5">{ready || r.rawClashCount ? t("loop.receipt.body", { instances: r.instances, clashes: r.rawClashCount }) : t("loop.receipt.bodyNone", { instances: r.instances })}</p>}
      {r.kind === "rejected" && <p className="mt-0.5">{t("loop.receipt.rejectedBody")}</p>}
      {r.kind === "undone" && <p className="mt-0.5">{t("loop.receipt.undoneBody")}</p>}
      {r.kind !== "rejected" && (
        <p className="mt-1 flex flex-wrap items-center gap-1">
          <span className="font-semibold">{t("loop.receipt.learn")}</span>
          {parts.length ? parts.map((p) => <ActorMark key={p} actor="engine">{p}</ActorMark>) : <span>{t("loop.receipt.learnNone")}</span>}
        </p>
      )}
      {r.kind === "approved" && r.agent && (
        <p className="mt-0.5 text-gray-700">
          {!r.agent.unchanged ? t("loop.receipt.agentChanged") : corrections[0] ? t("loop.receipt.agentCorrection", { id: corrections[0].ruleId }) : t("loop.receipt.agentSame")}
        </p>
      )}
      {r.kind === "approved" && corrected && !corrections.length && <p className="mt-0.5 text-gray-700">{t("loop.receipt.actionOnly")}</p>}
      {r.kind === "approved" &&
        corrections.slice(0, 2).map((c) => (
          <p key={`${c.ruleId}${c.label}`} className="mt-0.5 text-gray-700">
            {t("loop.receipt.same", { label: c.label, id: c.ruleId, total: c.total, threshold: r.curationThreshold, uncurated: r.uncuratedCorrections })}
          </p>
        ))}
      {crossed.map((e) => (
        <p key={e.ruleId} className="mt-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-amber-900">
          <span className="font-semibold">! {t("loop.receipt.threshold")}: </span>
          {t("loop.receipt.thresholdBody", { id: e.ruleId, rate: pct(e.thresholdCrossed!.rate), n: e.thresholdCrossed!.n })}{" "}
          <Link to={`/reglas/${encodeURIComponent(e.ruleId)}`} className="text-brand underline">
            {t("loop.receipt.openRule", { id: e.ruleId })}
          </Link>
        </p>
      ))}
      {r.kind === "approved" && ready > 0 && (
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(SEND_TO_APPROVAL_EVENT))} className="mt-1.5 rounded bg-brand px-2 py-0.5 font-medium text-white hover:bg-brand-light">
          {t("loop.receipt.next", { count: ready })} →
        </button>
      )}
    </section>
  );
}
