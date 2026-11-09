/**
 * Row vocabulary (docs/PLAN-core-features-simplified.md §1.4, UX analysis §5.1):
 * per row at most 3 chips + counts + ONE state icon.
 *
 * Chip precedence (status slot, one chip): Reapareció > Cambió > Nuevo >
 *   (grupo rows only) validez mixta > orientación por confirmar > Típico.
 * State icon precedence (one icon): your decision in this version (✓ ✎ ✕ ⏸)
 *   > ACC (closed ⊘, assigned/mixed 🗎) > exception ⚑ > inherited ↺ / ◌ > pending ○.
 * Everything else (confidence, spot-check, agent-updated, no-viewer) lives in
 * the row tooltip or the panel; the spot-check guard still applies.
 */
import { useT, type TFunction } from "~/i18n";
import type { AccState, ChangeKind, DecisionState, FamilyGroup } from "~/lib/api/types";
import { DecisionStateIcon } from "~/lib/components/badges";
import { IconCircle, IconClosed, IconFlag, IconInherited, IconIssue } from "~/lib/components/icons";

const CHANGE_CLS: Record<Exclude<ChangeKind, "unchanged">, string> = {
  reappeared: "bg-red-50 text-red-800 border-red-200",
  changed: "bg-amber-50 text-amber-900 border-amber-200",
  new: "bg-sky-50 text-sky-800 border-sky-200",
};

/** One change word: Nuevo · Cambió · Reapareció (nothing when unchanged). */
export function ChangeChip({ change }: { change: ChangeKind | null | undefined }) {
  const t = useT();
  if (!change || change === "unchanged") return null;
  return <span className={`shrink-0 rounded border px-1 text-[10px] font-medium leading-4 ${CHANGE_CLS[change]}`}>{t(`change.${change}`)}</span>;
}

export function accTooltip(t: TFunction, acc: AccState): string {
  if (acc.status === "closed") return t("acc.closedTip", { reason: acc.closedReason ?? "—" });
  return t("acc.assignedTip", { ids: acc.issueIds.join(", ") || "—", existing: acc.existing, resolved: acc.resolved });
}

/** The single right-side state icon of a row. */
export function RowStateIcon({ state, acc, inheritance, pendingException }: { state: DecisionState; acc?: AccState; inheritance?: FamilyGroup["inheritance"]; pendingException?: boolean }) {
  const t = useT();
  const own = state === "accepted" || state === "corrected" || state === "rejected" || state === "postponed";
  if (own) return <DecisionStateIcon state={state} />;
  if (acc) {
    const tip = accTooltip(t, acc);
    return acc.status === "closed" ? <IconClosed size={13} label={tip} className="shrink-0 text-gray-500" /> : <IconIssue size={13} label={tip} className="shrink-0 text-brand" />;
  }
  if (inheritance?.state === "exception" || pendingException) return <IconFlag size={12} label={t("families.exception")} className="shrink-0 text-amber-700" />;
  if (inheritance?.state === "inherited" || state === "inherited") return <IconInherited size={13} label={t("families.inherited")} className="shrink-0 text-gray-500" />;
  if (inheritance?.state === "inherited_pending")
    return (
      <span title={t("families.inheritedPending")} className="shrink-0 text-xs text-gray-500">
        ◌
      </span>
    );
  return <IconCircle size={13} label={t("decision.pending")} className="shrink-0 text-gray-400" />;
}
