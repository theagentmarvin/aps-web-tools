/**
 * Virtualised group / clash list (spec §3.3, §9.2). Flattened row model:
 * expanded groups render their clashes as extra rows in the same list.
 * role=listbox with aria-activedescendant so focus stays on the container.
 */
import { memo, useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n, useT } from "~/i18n";
import { ConfidenceDots, DecisionStateIcon, DeltaBadge, DisciplinePairChip, PriorityChip, SpotCheckChip, StatusBadge } from "~/lib/components/badges";
import { IconChevronDown, IconChevronRight, IconFlag, IconNoCube } from "~/lib/components/icons";
import { useTriageContext } from "./actions";
import { useTriage, type Row } from "./store";

const GROUP_H = 56;
const NESTED_H = 36;

export function GroupList() {
  const t = useT();
  const { store } = useTriageContext();
  const rows = useTriage(store, (s) => s.rows);
  const cursorKey = useTriage(store, (s) => s.cursorKey);
  const view = useTriage(store, (s) => s.query.view);
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (rows[i]?.nested ? NESTED_H : GROUP_H),
    overscan: 10,
    getItemKey: (i) => rows[i]?.key ?? i,
  });

  useEffect(() => {
    const idx = rows.findIndex((r) => r.key === cursorKey);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [cursorKey, rows, virtualizer]);

  useEffect(() => {
    parentRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      id="triage-list"
      ref={parentRef}
      role="listbox"
      tabIndex={0}
      aria-multiselectable="true"
      aria-label={view === "groups" ? t("a11y.groupList") : t("a11y.clashList")}
      aria-activedescendant={cursorKey ? `row-${cursorKey}` : undefined}
      className="min-h-0 flex-1 overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/30"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (!row) return null;
          return (
            <div key={vi.key} style={{ position: "absolute", top: 0, left: 0, right: 0, height: vi.size, transform: `translateY(${vi.start}px)` }}>
              {row.nested ? <NestedClashRow row={row} /> : row.kind === "group" ? <GroupRow row={row} /> : <FlatClashRow row={row} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function useRowState(row: Row) {
  const { store } = useTriageContext();
  const isCursor = useTriage(store, (s) => s.cursorKey === row.key);
  const isChecked = useTriage(store, (s) => s.checked.has(row.key));
  const anyChecked = useTriage(store, (s) => s.checked.size > 0);
  // Re-render when this row's (or its group's) decision or proposal changes.
  useTriage(store, (s) => s.latest.get(row.id));
  useTriage(store, (s) => s.latest.get(row.groupId));
  useTriage(store, (s) => s.proposals.get(row.groupId));
  useTriage(store, (s) => s.thresholds);
  const flagged = useTriage(store, (s) => s.agentUpdated.has(row.id));
  const noViewer = useTriage(store, (s) => {
    const failed = s.viewer.failedDocs;
    if (!failed.length) return false;
    const c = row.kind === "clash" ? s.clashes.get(row.id) : s.clashesByGroup.get(row.id)?.[0];
    return !!c && (failed.includes(c.a.documentId) || failed.includes(c.b.documentId));
  });
  const e = store.evaluate(row.kind, row.id);
  return { store, isCursor, isChecked, anyChecked, e, flagged, noViewer };
}

function rowCls(isCursor: boolean, isChecked: boolean, decided: boolean) {
  return [
    "group/row flex h-full cursor-pointer select-none border-b border-brand-muted/10 pr-2",
    isCursor ? "border-l-2 border-l-brand bg-brand-surface" : isChecked ? "border-l-2 border-l-transparent bg-brand/5" : "border-l-2 border-l-transparent hover:bg-gray-50",
    decided ? "text-gray-500" : "text-gray-800",
  ].join(" ");
}

function CheckBox({ rowKey, checked, visible }: { rowKey: string; checked: boolean; visible: boolean }) {
  const t = useT();
  const { store } = useTriageContext();
  return (
    <input
      type="checkbox"
      tabIndex={-1}
      aria-label={t("list.check")}
      checked={checked}
      onClick={(e) => {
        e.stopPropagation();
        if (e.shiftKey) store.rangeCheck(rowKey);
        else store.toggleCheck(rowKey);
      }}
      onChange={() => undefined}
      className={`h-3.5 w-3.5 accent-brand ${visible || checked ? "opacity-100" : "opacity-0 group-hover/row:opacity-100"}`}
    />
  );
}

const GroupRow = memo(function GroupRow({ row }: { row: Row }) {
  const t = useT();
  const { store, isCursor, isChecked, anyChecked, e, flagged, noViewer } = useRowState(row);
  const expanded = useTriage(store, (s) => s.expanded.has(row.id));
  if (!e?.s.group) return null;
  const g = e.s.group;
  const decided = e.d.state !== "pending" && e.d.state !== "inherited";
  return (
    <div id={`row-${row.key}`} role="option" aria-selected={isChecked} aria-expanded={expanded} className={rowCls(isCursor, isChecked, decided)} onClick={() => store.setCursor(row.key)} onDoubleClick={() => store.toggleExpand(row.id)}>
      <div className="flex w-7 flex-col items-center justify-center gap-1">
        <CheckBox rowKey={row.key} checked={isChecked} visible={anyChecked} />
        <button
          type="button"
          tabIndex={-1}
          aria-label={expanded ? t("list.collapse") : t("list.expand")}
          onClick={(ev) => {
            ev.stopPropagation();
            store.toggleExpand(row.id);
          }}
          className="text-gray-400 hover:text-brand"
        >
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </button>
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <div className="flex items-center gap-1.5">
          {e.d.priority && <PriorityChip value={e.d.priority} edited={e.d.edited && e.d.priority !== e.s.proposal?.fields.priority.value} />}
          {e.d.confidence !== null && <ConfidenceDots value={e.d.confidence} />}
          <DisciplinePairChip a={g.pair[0]} b={g.pair[1]} />
          <span className="font-mono text-xs text-gray-500">×{g.clashIds.length}</span>
          <DeltaBadge delta={g.delta} />
          {e.s.proposal?.spotCheck && <SpotCheckChip />}
          <span className="ml-auto flex items-center gap-1">
            {noViewer && <IconNoCube size={13} label={t("list.noViewer")} className="text-gray-400" />}
            {flagged && <IconFlag size={13} label={t("detail.agentUpdated")} className="text-amber-700" />}
            <DecisionStateIcon state={e.d.state} />
          </span>
        </div>
        <div className={`truncate text-sm ${g.elementMissing ? "text-gray-400" : ""}`} title={g.title}>
          {g.title}
        </div>
      </div>
    </div>
  );
});

function ClashLine({ row }: { row: Row }) {
  const { fmt } = useI18n();
  const { store } = useTriageContext();
  const c = store.state.clashes.get(row.id);
  if (!c) return null;
  return (
    <>
      <span className="font-mono text-[11px] text-gray-500" title={c.id}>
        {c.id.slice(-6)}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs" title={`${c.a.name} ↔ ${c.b.name}`}>
        <span className="text-clash-a-ink">{c.a.name}</span>
        <span className="text-gray-400"> ↔ </span>
        <span className="text-clash-b-ink">{c.b.name}</span>
      </span>
      <span className="font-mono text-[11px] text-gray-600">{fmt.mm(c.distanceMm)}</span>
      <span className="hidden text-[11px] text-gray-500 xl:inline">{c.level?.replace("Nivel ", "N")}</span>
      <StatusBadge status={c.status} />
    </>
  );
}

const NestedClashRow = memo(function NestedClashRow({ row }: { row: Row }) {
  const { store, isCursor, isChecked, anyChecked, e } = useRowState(row);
  const own = useTriage(store, (s) => s.latest.get(row.id));
  return (
    <div id={`row-${row.key}`} role="option" aria-selected={isChecked} className={`${rowCls(isCursor, isChecked, false)} items-center gap-2 pl-7`} onClick={() => store.setCursor(row.key)}>
      <CheckBox rowKey={row.key} checked={isChecked} visible={anyChecked} />
      <ClashLine row={row} />
      {own && e && <DecisionStateIcon state={e.d.state} />}
    </div>
  );
});

const FlatClashRow = memo(function FlatClashRow({ row }: { row: Row }) {
  const { store, isCursor, isChecked, anyChecked, e } = useRowState(row);
  if (!e?.s.clash) return null;
  const decided = e.d.state !== "pending" && e.d.state !== "inherited";
  return (
    <div id={`row-${row.key}`} role="option" aria-selected={isChecked} className={rowCls(isCursor, isChecked, decided)} onClick={() => store.setCursor(row.key)}>
      <div className="flex w-7 items-center justify-center">
        <CheckBox rowKey={row.key} checked={isChecked} visible={anyChecked} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <div className="flex items-center gap-1.5">
          {e.d.priority && <PriorityChip value={e.d.priority} edited={e.d.edited} />}
          {e.d.confidence !== null && <ConfidenceDots value={e.d.confidence} />}
          <span className="min-w-0 flex-1 truncate text-xs text-gray-600" title={e.s.group?.title}>
            {e.s.group?.title}
          </span>
          <DeltaBadge delta={e.s.clash.delta} />
          <DecisionStateIcon state={e.d.state} />
        </div>
        <div className="flex items-center gap-2">
          <ClashLine row={row} />
        </div>
      </div>
    </div>
  );
});
