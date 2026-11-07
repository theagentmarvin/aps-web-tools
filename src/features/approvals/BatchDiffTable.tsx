/**
 * Field-level diff of a batch (spec §5.3 "Cambios"): one row per field change,
 * grouped by operation with collapsible headers, virtualised. Unchecking a
 * row excludes it (it returns to triage, not lost).
 */
import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n, useT } from "~/i18n";
import type { Batch, BatchItem, BatchOperation } from "~/lib/api/types";
import { ConfidenceBadge, ReasonChip } from "~/lib/components/badges";
import { IconChevronDown, IconChevronRight, IconExternal } from "~/lib/components/icons";
import { OPERATION_KEY } from "~/lib/labels";

type FlatRow =
  | { type: "header"; op: BatchOperation; count: number }
  | { type: "field"; item: BatchItem; field: BatchItem["fields"][number]; first: boolean };

const ROW_H = 34;

function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function BatchDiffTable({ batch, readOnly, onToggle }: { batch: Batch; readOnly: boolean; onToggle: (itemIds: string[], excluded: boolean) => void }) {
  const t = useT();
  const { fmt } = useI18n();
  const [collapsed, setCollapsed] = useState<Set<BatchOperation>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);
  const items = batch.items.filter((i) => !i.conflict);

  const rows = useMemo(() => {
    const byOp = new Map<BatchOperation, BatchItem[]>();
    for (const i of items) byOp.set(i.operation, [...(byOp.get(i.operation) ?? []), i]);
    const out: FlatRow[] = [];
    for (const [op, list] of byOp) {
      out.push({ type: "header", op, count: list.length });
      if (collapsed.has(op)) continue;
      for (const item of list) item.fields.forEach((field, idx) => out.push({ type: "field", item, field, first: idx === 0 }));
    }
    return out;
  }, [items, collapsed]);

  const v = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_H, overscan: 10 });
  const originLabel = (o: BatchItem["origin"]) => (o === "ai_accepted" ? t("batch.originAccepted") : o === "ai_corrected" ? t("batch.originCorrected") : t("batch.originManual"));
  const grid = "grid grid-cols-[28px_minmax(140px,1.4fr)_110px_120px_1fr_1fr_120px_90px_110px] items-center gap-2 px-2";

  if (!items.length) return <p className="p-6 text-center text-sm text-gray-500">{t("batch.noChanges")}</p>;

  return (
    <div className="rounded-lg border border-brand-muted/20 bg-white text-xs">
      <div className={`${grid} border-b border-brand-muted/20 py-2 font-medium text-gray-500`}>
        <span />
        <span>{t("batch.columns.object")}</span>
        <span>{t("batch.columns.operation")}</span>
        <span>{t("batch.columns.field")}</span>
        <span>{t("batch.columns.current")}</span>
        <span>{t("batch.columns.new")}</span>
        <span>{t("batch.columns.origin")}</span>
        <span>{t("batch.columns.reviewer")}</span>
        <span>{t("batch.columns.confidence")}</span>
      </div>
      <div ref={parentRef} className="max-h-[60vh] overflow-y-auto">
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((vi) => {
            const r = rows[vi.index];
            const style = { position: "absolute" as const, top: 0, left: 0, right: 0, height: vi.size, transform: `translateY(${vi.start}px)` };
            if (r.type === "header") {
              const open = !collapsed.has(r.op);
              return (
                <div key={vi.key} style={style} className="flex items-center border-b border-brand-muted/10 bg-gray-50 px-2">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-label={t("batch.toggleGroup", { op: t(OPERATION_KEY[r.op]) })}
                    onClick={() => setCollapsed((prev) => {
                      const n = new Set(prev);
                      if (n.has(r.op)) n.delete(r.op);
                      else n.add(r.op);
                      return n;
                    })}
                    className="flex items-center gap-1 font-medium text-gray-700"
                  >
                    {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                    {t(OPERATION_KEY[r.op])} · {fmt.number(r.count)}
                  </button>
                </div>
              );
            }
            const { item, field, first } = r;
            return (
              <div key={vi.key} style={style} className={`${grid} border-b border-brand-muted/10 ${item.excluded ? "opacity-50" : ""}`}>
                <span>
                  {first && (
                    <input
                      type="checkbox"
                      className="accent-brand"
                      aria-label={item.label}
                      checked={!item.excluded}
                      disabled={readOnly}
                      onChange={(e) => onToggle([item.id], !e.target.checked)}
                    />
                  )}
                </span>
                <span className="flex min-w-0 items-center gap-1 truncate" title={item.label}>
                  {first && (
                    <>
                      <span className={`truncate ${item.targetType === "clash" ? "font-mono" : ""}`}>{item.label}</span>
                      {item.mcOperation === "none" && <span title={item.conflict?.reason} className="shrink-0 rounded bg-gray-100 px-1 text-[10px] text-gray-600">{t("batch.mcNone")}</span>}
                      {item.result && (
                        <span title={item.result.message} className={`shrink-0 rounded px-1 text-[10px] ${item.result.status === "applied" ? "bg-green-50 text-green-800" : item.result.status === "failed" ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-600"}`}>
                          {item.result.status}
                        </span>
                      )}
                      {item.groupId && (
                        <a
                          href={`/coordinacion/${batch.projectId}/${batch.modelSetId}?test=${batch.testId}&${item.targetType === "clash" ? "clash" : "group"}=${item.targetType === "clash" ? item.targetIds[0] : item.groupId}&decision=`}
                          target="_blank"
                          rel="noreferrer"
                          title={t("batch.openInWorkspace")}
                          className="shrink-0 text-gray-400 hover:text-brand"
                        >
                          <IconExternal size={12} />
                        </a>
                      )}
                    </>
                  )}
                </span>
                <span className="truncate">{first ? t(OPERATION_KEY[item.operation]) : ""}</span>
                <span className="truncate text-gray-600">{field.field}</span>
                <span className="truncate">
                  {field.accCurrent === null || field.accCurrent === undefined ? <span className="text-gray-400">—</span> : <span className="rounded bg-red-50 px-1 text-red-700 line-through">{fmtVal(field.accCurrent)}</span>}
                </span>
                <span className="truncate" title={fmtVal(field.accNew)}>
                  <span className="rounded bg-green-50 px-1 text-green-800">{fmtVal(field.accNew)}</span>
                </span>
                <span className="flex items-center gap-1 truncate">
                  {first && originLabel(item.origin)}
                  {first && item.reasonCode && <ReasonChip code={item.reasonCode} />}
                </span>
                <span className="truncate">{first ? item.reviewer : ""}</span>
                <span>{first && item.aiConfidence !== undefined && <ConfidenceBadge value={item.aiConfidence} />}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
