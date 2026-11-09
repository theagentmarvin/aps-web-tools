/**
 * Family tree rows (docs/domain/solution-families-proposal.md §5.1):
 * level 1 = discipline pair (or the "Conjunto de modelos" / "No es problema"
 * buckets), level 2 = problem type, level 3 = family, level 4 = instances
 * (today's group rows, rendered by GroupList).
 */
import { memo } from "react";
import { useT } from "~/i18n";
import type { FamilyGroup, TriageFamily } from "~/lib/api/types";
import { PriorityChip, ValidityBadge } from "~/lib/components/badges";
import { IconAlert, IconChevronDown, IconChevronRight, IconFlag, IconClosed, IconInherited, IconIssue } from "~/lib/components/icons";
import { problemTypeOf } from "~/lib/problem-types";
import { useTriageContext } from "./actions";
import { familyChangeCounts, topChange } from "./change";
import { ChangeChip, accTooltip } from "./RowMarks";
import { CopyReminderButton } from "./IssueViews";
import { useTriage, type Row, type TreeNode } from "./store";

export const NODE_H = 32;

/** Tri-state checkbox: checks every ubicación under a tree row. */
function TriCheck({ rowKey }: { rowKey: string }) {
  const t = useT();
  const { store } = useTriageContext();
  const state = useTriage(store, (s) => (s.checked.size === 0 ? "none" : store.checkState(rowKey)));
  const anyChecked = useTriage(store, (s) => s.checked.size > 0);
  return (
    <input
      type="checkbox"
      tabIndex={-1}
      aria-label={t("families.checkSubtree")}
      title={t("families.checkSubtree")}
      checked={state === "all"}
      ref={(el) => {
        if (el) el.indeterminate = state === "some";
      }}
      aria-checked={state === "some" ? "mixed" : state === "all"}
      onClick={(e) => {
        e.stopPropagation();
        store.toggleCheckSubtree(rowKey);
      }}
      onChange={() => undefined}
      className={`h-3.5 w-3.5 shrink-0 accent-brand ${anyChecked || state !== "none" ? "opacity-100" : "opacity-0 group-hover/row:opacity-100"}`}
    />
  );
}
export const FAMILY_H = 56;

/** Left padding per tree depth (px). */
export const indent = (depth = 0) => 4 + depth * 14;

function rowCls(isCursor: boolean) {
  return [
    "group/row flex h-full cursor-pointer select-none border-b border-brand-muted/10 pr-2",
    isCursor ? "border-l-2 border-l-brand bg-brand-surface" : "border-l-2 border-l-transparent hover:bg-gray-50",
  ].join(" ");
}

function Chevron({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      onClick={(ev) => {
        ev.stopPropagation();
        onClick();
      }}
      className="flex h-5 w-5 shrink-0 items-center justify-center text-gray-400 hover:text-brand"
    >
      {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
    </button>
  );
}

export function useNodeLabel(n: TreeNode | undefined): string {
  const t = useT();
  const { store } = useTriageContext();
  const pts = useTriage(store, (s) => s.problemTypes);
  if (!n) return "";
  if (n.depth === 1) return problemTypeOf(pts, n.problemType as TriageFamily["parts"]["problemType"])?.nameEs ?? n.problemType ?? "";
  if (n.bucket === "model_set") return t("families.bucket.modelSet");
  if (n.bucket === "non_issue") return t("families.bucket.nonIssue");
  if (n.bucket === "loose") return t("families.bucket.loose");
  if (n.bucket === "discipline") return t("issues.disciplineNode", { discipline: n.discipline ?? "" });
  if (n.bucket === "unchanged") return `↺ ${t("lens.unchangedRow", { count: n.instanceCount })}`;
  return n.pair ? `${n.pair[0]} × ${n.pair[1]}` : n.id;
}

export const NodeRow = memo(function NodeRow({ row }: { row: Row }) {
  const t = useT();
  const { store } = useTriageContext();
  const isCursor = useTriage(store, (s) => s.cursorKey === row.key);
  const open = useTriage(store, (s) => !s.collapsedNodes.has(row.id));
  const n = useTriage(store, (s) => s.nodes.get(row.id));
  const label = useNodeLabel(n);
  if (!n) return null;
  return (
    <div
      id={`row-${row.key}`}
      role="treeitem"
      aria-level={n.depth + 1}
      aria-expanded={open}
      aria-selected={isCursor}
      className={`${rowCls(isCursor)} items-center gap-1 ${n.depth === 0 ? "bg-gray-50/80" : ""}`}
      style={{ paddingLeft: indent(row.depth) }}
      onClick={() => store.setCursor(row.key)}
      onDoubleClick={() => store.toggleNode(row.id)}
    >
      <TriCheck rowKey={row.key} />
      <Chevron open={open} label={open ? t("list.collapse") : t("list.expand")} onClick={() => store.toggleNode(row.id)} />
      {n.depth === 1 && n.problemType && <span className="shrink-0 rounded bg-gray-100 px-1 font-mono text-[10px] text-gray-500">{n.problemType}</span>}
      <span className={`min-w-0 flex-1 truncate ${n.depth === 0 ? "text-sm font-semibold text-gray-900" : "text-[13px] text-gray-800"}`} title={n.bucket === "discipline" ? t("issues.disciplineNodeTip", { discipline: n.discipline ?? "" }) : label}>
        {label}
      </span>
      {n.worst && n.depth === 0 && <PriorityChip value={n.worst} />}
      {n.needsReview > 0 && n.depth === 0 && <span className="shrink-0 text-[10px] text-amber-800">{t("families.needsReviewCount", { count: n.needsReview })}</span>}
      {n.bucket === "discipline" && n.discipline && <CopyReminderButton discipline={n.discipline} />}
      <span className="shrink-0 whitespace-nowrap text-[11px] text-gray-500">
        {n.bucket === "discipline"
          ? t("issues.nodeCounts", { count: n.issueIds?.length ?? 0, existing: n.clashCount })
          : n.bucket === "loose" || n.bucket === "unchanged"
          ? t("families.countsLoose", { instances: n.instanceCount, clashes: n.clashCount })
          : t("families.counts", { count: n.familyIds.length, instances: n.instanceCount, clashes: n.clashCount })}
      </span>
    </div>
  );
});

/** "Típico", "validez mixta", "orientación por confirmar" badges. */
export function FamilyTags({ family, compact }: { family: TriageFamily; compact?: boolean }) {
  const t = useT();
  return (
    <>
      {family.tags.includes("tipico") && (
        <span title={t("families.typicalTooltip")} className="shrink-0 rounded border border-sky-200 bg-sky-50 px-1 text-[10px] font-medium leading-4 text-sky-800">
          {t("families.typical")}
        </span>
      )}
      {family.tags.includes("validez_mixta") && (
        <span title={t("families.mixedTooltip")} className="inline-flex shrink-0 items-center gap-0.5 rounded border border-amber-300 bg-amber-50 px-1 text-[10px] font-medium leading-4 text-amber-900">
          <IconAlert size={10} />
          {t("families.mixed")}
        </span>
      )}
      {family.tags.includes("orientacion_por_confirmar") && (
        <span title={t("families.orientationTooltip")} className="shrink-0 rounded border border-dashed border-gray-400 px-1 text-[10px] leading-4 text-gray-600">
          {compact ? t("families.orientationShort") : t("families.orientation")}
        </span>
      )}
    </>
  );
}

export function levelRange(levels: string[]): string {
  if (!levels.length) return "";
  if (levels.length === 1) return levels[0];
  return `${levels[0]} – ${levels[levels.length - 1]}`;
}

export const FamilyRow = memo(function FamilyRow({ row }: { row: Row }) {
  const t = useT();
  const { store } = useTriageContext();
  const isCursor = useTriage(store, (s) => s.cursorKey === row.key);
  const open = useTriage(store, (s) => s.expanded.has(row.id));
  const f = useTriage(store, (s) => s.families.get(row.id));
  useTriage(store, (s) => s.latest);
  if (!f) return null;
  const worst = store.familyWorst(f);
  const st = store.state.familyStats.get(f.id);
  const decided = f.decision?.status === "approved";
  return (
    <div
      id={`row-${row.key}`}
      role="treeitem"
      aria-level={3}
      aria-expanded={open}
      aria-selected={isCursor}
      className={`${rowCls(isCursor)} gap-1`}
      style={{ paddingLeft: indent(row.depth) }}
      onClick={() => store.setCursor(row.key)}
      onDoubleClick={() => store.toggleExpand(row.id)}
    >
      <div className="flex items-center">
        <TriCheck rowKey={row.key} />
        <Chevron open={open} label={open ? t("list.collapse") : t("list.expand")} onClick={() => store.toggleExpand(row.id)} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {worst && <PriorityChip value={worst} />}
          <span className="shrink-0 text-xs">
            <ValidityBadge value={f.decision?.status === "approved" ? f.decision.validity : f.proposed.validity} />
          </span>
          <FamilyStatusChip family={f} />
          <span className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-gray-500" title={`${t("families.uniqueTooltip", { raw: f.rawClashCount, unique: f.uniqueClashCount })}
${f.levels.join(", ")}`}>
            {t("families.rowCounts", { instances: st?.instanceCount ?? f.instanceCount, clashes: st?.clashCount ?? f.rawClashCount, levels: st?.levels ?? f.levels.length })}
          </span>
          {decided ? (
            <IconInherited size={13} label={t("families.decided")} className="shrink-0 text-green-700" />
          ) : f.acc ? (
            f.acc.status === "closed" ? <IconClosed size={13} label={accTooltip(t, f.acc)} className="shrink-0 text-gray-500" /> : <IconIssue size={13} label={accTooltip(t, f.acc)} className="shrink-0 text-brand" />
          ) : null}
        </div>
        <div className="truncate text-sm font-medium text-gray-900" title={f.title}>
          {f.title}
        </div>
      </div>
    </div>
  );
});

/**
 * The ONE status chip of a grupo row, by precedence:
 * Reapareció > Cambió > Nuevo > validez mixta > orientación por confirmar > Típico.
 * The other tags stay visible in the grupo panel header.
 */
export function FamilyStatusChip({ family }: { family: TriageFamily }) {
  const { store } = useTriageContext();
  const groups = useTriage(store, (s) => s.groups);
  const change = topChange(familyChangeCounts(family, groups));
  if (change) return <ChangeChip change={change} />;
  const tag = (["validez_mixta", "orientacion_por_confirmar", "tipico"] as const).find((x) => family.tags.includes(x));
  if (!tag) return null;
  return <FamilyTags family={{ ...family, tags: [tag] }} compact />;
}

/** Inheritance mark on an instance row: ↳ heredada · ⚑ excepción · ◌ pendiente. */
export function InheritanceMark({ group }: { group: FamilyGroup }) {
  const t = useT();
  const { store } = useTriageContext();
  const pendingException = useTriage(store, (s) => (group.familyId ? s.familyExceptions.get(group.familyId)?.has(group.id) : false));
  const st = group.inheritance?.state;
  if (st === "exception" || pendingException) return <IconFlag size={12} label={t("families.exception")} className="shrink-0 text-amber-700" />;
  if (st === "inherited") return <IconInherited size={12} label={t("families.inherited")} className="shrink-0 text-green-700" />;
  if (st === "inherited_pending") return <span title={t("families.inheritedPending")} className="shrink-0 text-xs text-gray-500">◌</span>;
  return null;
}
