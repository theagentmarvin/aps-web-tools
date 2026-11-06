/**
 * /auditoria — append-only audit log with filters in the URL, expandable
 * rows (key/value details) and CSV export (spec §5.6).
 */
import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n, useT } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { AuditEvent } from "~/lib/api/types";
import { PageHeader } from "~/lib/components/PageHeader";
import { IconChevronDown, IconChevronRight } from "~/lib/components/icons";
import { Button, EmptyState, ErrorState, SkeletonRows, cardCls, inputCls } from "~/lib/components/ui";
import { downloadCsv } from "~/lib/csv";

const ACTIONS = ["proposal", "decision", "batch", "preflight", "acc", "rule", "settings", "feedback"];
const ROW_H = 40;

export function AuditPage() {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const [sp, setSp] = useSearchParams();
  const q = {
    project: sp.get("project") ?? undefined,
    user: sp.get("user") ?? undefined,
    action: sp.get("action") ?? undefined,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    batch: sp.get("batch") ?? undefined,
  };
  const projects = useAsync(() => api.listProjects(), [api]);
  const { data, error, loading, reload } = useAsync(() => api.listAudit(q), [api, sp.toString()]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);
  const items = data?.items ?? [];
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => ROW_H + (open.has(items[i]?.id) ? 24 + Object.keys(items[i].details).length * 18 : 0),
    overscan: 10,
  });

  function setParam(k: string, val: string) {
    const next = new URLSearchParams(sp);
    if (val) next.set(k, val);
    else next.delete(k);
    setSp(next, { replace: true });
  }

  function toggle(id: string) {
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
    window.setTimeout(() => v.measure(), 0);
  }

  function exportCsv() {
    downloadCsv("auditoria.csv", [
      ["id", "at", "actorType", "actor", "action", "projectId", "modelSetId", "testId", "batchId", "targets", "accResponseId", "details"],
      ...items.map((e) => [e.id, e.at, e.actor.type, e.actor.name, e.action, e.projectId, e.modelSetId, e.testId, e.batchId, e.targetIds.join(" "), e.accResponseId, JSON.stringify(e.details)]),
    ]);
  }

  const actorLabel = (e: AuditEvent) => `${t(`audit.actor.${e.actor.type}`)} · ${e.actor.name}`;
  const grid = "grid grid-cols-[24px_130px_180px_200px_1fr] items-center gap-2 px-3";

  return (
    <div>
      <PageHeader title={t("audit.title")} subtitle={t("audit.chain")} actions={<Button onClick={exportCsv}>{t("common.exportCsv")}</Button>} />
      <div className="mb-4 flex flex-wrap items-end gap-3 text-xs text-gray-500">
        <label className="flex flex-col">
          {t("reports.filters.project")}
          <select className={inputCls} value={q.project ?? ""} onChange={(e) => setParam("project", e.target.value)}>
            <option value="">{t("reports.allProjects")}</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          {t("audit.filters.user")}
          <input className={inputCls} value={q.user ?? ""} onChange={(e) => setParam("user", e.target.value)} />
        </label>
        <label className="flex flex-col">
          {t("audit.filters.action")}
          <select className={inputCls} value={q.action ?? ""} onChange={(e) => setParam("action", e.target.value)}>
            <option value="">{t("audit.allActions")}</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}.*
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          {t("reports.filters.from")}
          <input type="date" className={inputCls} value={q.from ?? ""} onChange={(e) => setParam("from", e.target.value)} />
        </label>
        <label className="flex flex-col">
          {t("reports.filters.to")}
          <input type="date" className={inputCls} value={q.to ?? ""} onChange={(e) => setParam("to", e.target.value)} />
        </label>
        <label className="flex flex-col">
          {t("audit.filters.batch")}
          <input className={`${inputCls} font-mono`} value={q.batch ?? ""} onChange={(e) => setParam("batch", e.target.value)} placeholder="L-…" />
        </label>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <SkeletonRows count={8} height="h-9" />
      ) : items.length === 0 ? (
        <EmptyState title={t("audit.empty")} />
      ) : (
        <div className={`${cardCls} text-sm`}>
          <div className={`${grid} border-b border-brand-muted/20 py-2 text-xs font-medium text-gray-500`}>
            <span />
            <span>{t("audit.columns.date")}</span>
            <span>{t("audit.columns.actor")}</span>
            <span>{t("audit.columns.action")}</span>
            <span>{t("audit.columns.object")}</span>
          </div>
          <div ref={parentRef} className="max-h-[65vh] overflow-y-auto">
            <div style={{ height: v.getTotalSize(), position: "relative" }}>
              {v.getVirtualItems().map((vi) => {
                const e = items[vi.index];
                const isOpen = open.has(e.id);
                return (
                  <div key={e.id} data-index={vi.index} ref={v.measureElement} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }} className="border-b border-brand-muted/10">
                    <div className={`${grid} min-h-10 py-1.5`}>
                      <button type="button" aria-expanded={isOpen} aria-label={t("audit.columns.details")} onClick={() => toggle(e.id)} className="text-gray-400 hover:text-brand">
                        {isOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                      </button>
                      <span className="text-xs text-gray-500">{fmt.dateTime(e.at)}</span>
                      <span className="truncate text-xs">{actorLabel(e)}</span>
                      <span className="truncate font-mono text-xs">{e.action}</span>
                      <span className="truncate text-xs text-gray-600">
                        {e.batchId && (
                          <Link to={`/aprobaciones/${e.batchId}`} className="mr-2 font-mono text-brand hover:underline">
                            {e.batchId}
                          </Link>
                        )}
                        {e.targetIds.join(", ")}
                        {e.accResponseId && <span className="ml-2 text-gray-400">{t("audit.accResponse", { id: e.accResponseId })}</span>}
                      </span>
                    </div>
                    {isOpen && (
                      <dl className="mx-10 mb-2 grid grid-cols-[180px_1fr] gap-x-3 rounded bg-gray-50 p-2 text-xs">
                        {Object.entries(e.details).map(([k, val]) => (
                          <div key={k} className="contents">
                            <dt className="text-gray-500">{k}</dt>
                            <dd className="font-mono">{val === null ? "—" : String(val)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
