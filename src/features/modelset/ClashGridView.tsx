/**
 * Clash grid, ACC Model Coordination style: rows and columns are models
 * ("MECHANICAL.rvt - {3D}"), each cell the clash groups (classified) or
 * clashes (counts only) for that pair, orange heat scale, diagonal = model
 * against itself. Sticky headers, rotated column headers, horizontal scroll
 * inside the card. Keyboard: arrows move, Enter opens triage for the pair.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useI18n, useT } from "~/i18n";
import type { ClashGrid, GridCell, GridDocument, ModelSetView } from "~/lib/api/types";
import { IconSearch } from "~/lib/components/icons";
import { Banner, Button, EmptyState, cardCls, inputCls } from "~/lib/components/ui";
import { isUnassigned, sourceLabel } from "./disciplines";

/** Brand-compatible orange heat scale (like ACC). Index 0 = empty. */
const HEAT = ["bg-white text-gray-300", "bg-orange-50 text-orange-900", "bg-orange-100 text-orange-900", "bg-orange-200 text-orange-950", "bg-orange-300 text-orange-950", "bg-orange-400 text-white", "bg-orange-500 text-white", "bg-orange-600 text-white"];

function heatIndex(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0;
  // Linear on the share of the busiest pair, so the scale stays readable (like ACC).
  return Math.max(1, Math.min(HEAT.length - 1, Math.ceil((v / max) * (HEAT.length - 1))));
}

export function docLabel(d: GridDocument): string {
  return `${d.fileName} - ${d.viewName}`;
}

interface Props {
  grid: ClashGrid;
  views: ModelSetView[];
  onOpenPair: (a: GridDocument, b: GridDocument) => void;
  onEditDiscipline: (docs: GridDocument[]) => void;
}

export function ClashGridView({ grid, views, onOpenPair, onEditDiscipline }: Props) {
  const t = useT();
  const { fmt } = useI18n();
  const [q, setQ] = useState("");
  const [view, setView] = useState("");
  const [onlyWith, setOnlyWith] = useState(false);
  const [showCompared, setShowCompared] = useState(false);
  const [focus, setFocus] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const cellRefs = useRef(new Map<string, HTMLTableCellElement>());
  const classified = grid.state === "classified";

  const cellOf = useMemo(() => {
    const m = new Map<string, GridCell>();
    for (const c of grid.cells) m.set(`${Math.min(c.a, c.b)}:${Math.max(c.a, c.b)}`, c);
    return (a: number, b: number) => m.get(`${Math.min(a, b)}:${Math.max(a, b)}`);
  }, [grid.cells]);

  const valueOf = (c: GridCell | undefined) => (c ? (classified ? c.groups : c.clashes) : 0);
  const totalOf = (d: GridDocument) => (classified ? d.groups : d.clashes);

  const dupNames = useMemo(() => {
    const count = new Map<string, number>();
    for (const d of grid.documents) count.set(d.fileName, (count.get(d.fileName) ?? 0) + 1);
    return new Set([...count].filter(([, n]) => n > 1).map(([k]) => k));
  }, [grid.documents]);

  const docs = useMemo(() => {
    const viewDocs = views.find((v) => v.name === view)?.documents;
    const needle = q.trim().toLowerCase();
    return grid.documents.filter(
      (d) =>
        (!viewDocs || viewDocs.includes(d.fileName)) &&
        (!needle || `${d.fileName} ${d.viewName} ${d.folderPath ?? ""} ${d.discipline}`.toLowerCase().includes(needle)) &&
        (!onlyWith || totalOf(d) > 0),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.documents, views, view, q, onlyWith, classified]);

  const max = useMemo(() => Math.max(0, ...grid.cells.map((c) => (classified ? c.groups : c.clashes))), [grid.cells, classified]);
  const unassigned = grid.documents.filter(isUnassigned);

  function move(r: number, c: number) {
    const nr = Math.max(0, Math.min(docs.length - 1, r));
    const nc = Math.max(0, Math.min(docs.length - 1, c));
    setFocus({ r: nr, c: nc });
    cellRefs.current.get(`${nr}:${nc}`)?.focus();
  }

  function onCellKey(e: KeyboardEvent, r: number, c: number) {
    const moves: Record<string, [number, number]> = { ArrowUp: [r - 1, c], ArrowDown: [r + 1, c], ArrowLeft: [r, c - 1], ArrowRight: [r, c + 1], Home: [r, 0], End: [r, docs.length - 1] };
    if (moves[e.key]) {
      e.preventDefault();
      move(...moves[e.key]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (valueOf(cellOf(docs[r].documentId, docs[c].documentId)) > 0) onOpenPair(docs[r], docs[c]);
    }
  }

  const tooltip = (a: GridDocument, b: GridDocument, cell: GridCell | undefined) => {
    const head = t("grid.cellTitle", { a: docLabel(a), b: docLabel(b) });
    if (!cell) return `${head}\n0`;
    return `${head}\n${
      classified
        ? t("grid.cellTooltip", { clashes: cell.clashes, groups: cell.groups, real: cell.real, p1: cell.p1, review: cell.needsReview, fresh: cell.newSinceLast })
        : t("grid.cellTooltipCounts", { clashes: cell.clashes, fresh: cell.newSinceLast })
    }`;
  };

  return (
    <div className="space-y-3">
      {unassigned.length > 0 && (
        <Banner tone="warning" className="rounded" actions={<Button onClick={() => onEditDiscipline(unassigned)}>{t("disc.assignNow")}</Button>}>
          {t("disc.bannerUnassigned", { count: unassigned.length })}
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="relative">
          <span className="sr-only">{t("grid.searchModels")}</span>
          <IconSearch size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("grid.searchModels")} className={`${inputCls} w-56 pl-7`} />
        </label>
        <label className="flex items-center gap-1 text-gray-600">
          {t("grid.view")}
          <select className={`${inputCls} py-0.5 text-xs`} value={view} onChange={(e) => setView(e.target.value)}>
            <option value="">{t("grid.allViews")}</option>
            {views.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-gray-600">
          <input type="checkbox" className="accent-brand" checked={onlyWith} onChange={(e) => setOnlyWith(e.target.checked)} />
          {t("grid.onlyWithClashes")}
        </label>
        <button type="button" aria-expanded={showCompared} onClick={() => setShowCompared((v) => !v)} className="text-brand hover:underline">
          {t("grid.whatCompared")}
        </button>
        <Legend classified={classified} />
      </div>

      {showCompared && (
        <section className={`${cardCls} p-3 text-xs`} aria-label={t("grid.whatCompared")}>
          <p className="mb-2 text-gray-600">{t("grid.whatComparedIntro")}</p>
          {views.length === 0 ? (
            <p className="text-gray-500">{grid.documents.map(docLabel).join(" · ")}</p>
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {views.map((v) => (
                <li key={v.name} className="rounded border border-brand-muted/20 p-2">
                  <p className="font-medium text-gray-800">{v.name}</p>
                  <p className="text-gray-600">{v.documents.join(" × ")}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {docs.length === 0 ? (
        <EmptyState title={t("grid.noModels")} />
      ) : (
        <div className={`${cardCls} max-h-[70vh] max-w-full overflow-auto`}>
          <table role="grid" aria-label={t("grid.gridLabel")} aria-describedby="grid-kbd-hint" className="border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 top-0 z-30 min-w-[300px] border-b border-r border-brand-muted/20 bg-white p-2 text-left align-bottom font-normal text-gray-500">
                  <span id="grid-kbd-hint">{t("grid.keyboardHint")}</span>
                </th>
                {docs.map((d) => (
                  <th key={d.documentId} scope="col" title={`${docLabel(d)}${d.folderPath ? `\n${d.folderPath}` : ""}`} className="sticky top-0 z-20 h-48 w-11 min-w-11 border-b border-brand-muted/20 bg-white p-1 align-bottom font-medium text-gray-700">
                    <span className="mx-auto block max-h-44 truncate [writing-mode:vertical-rl] rotate-180 text-left">{docLabel(d)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {docs.map((row, r) => (
                <tr key={row.documentId}>
                  <th scope="row" className="sticky left-0 z-10 max-w-[340px] border-b border-r border-brand-muted/20 bg-white p-2 text-left font-normal">
                    <RowHeader d={row} dup={dupNames.has(row.fileName)} total={totalOf(row)} classified={classified} onEdit={() => onEditDiscipline([row])} pct={fmt.pct} />
                  </th>
                  {docs.map((col, c) => {
                    const cell = cellOf(row.documentId, col.documentId);
                    const v = valueOf(cell);
                    const diag = row.documentId === col.documentId;
                    const isFocus = focus.r === r && focus.c === c;
                    return (
                      <td
                        key={col.documentId}
                        ref={(el) => {
                          if (el) cellRefs.current.set(`${r}:${c}`, el);
                          else cellRefs.current.delete(`${r}:${c}`);
                        }}
                        role="gridcell"
                        tabIndex={isFocus ? 0 : -1}
                        title={tooltip(row, col, cell)}
                        aria-label={`${tooltip(row, col, cell).replace("\n", ": ")}`}
                        onClick={() => {
                          setFocus({ r, c });
                          if (v > 0) onOpenPair(row, col);
                        }}
                        onKeyDown={(e) => onCellKey(e, r, c)}
                        aria-disabled={v === 0 || undefined}
                        className={`h-9 w-11 min-w-11 ${v > 0 ? "cursor-pointer" : "cursor-default"} border-b border-r border-white text-center tabular-nums outline-offset-[-2px] focus:outline-2 focus:outline-brand ${HEAT[heatIndex(v, max)]} ${diag ? "ring-1 ring-inset ring-gray-300" : ""} hover:ring-2 hover:ring-inset hover:ring-brand/50`}
                      >
                        {v > 0 ? fmt.number(v) : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-gray-500">{t("grid.diagonal")}</p>
    </div>
  );
}

function RowHeader({ d, dup, total, classified, onEdit, pct }: { d: GridDocument; dup: boolean; total: number; classified: boolean; onEdit: () => void; pct: (r: number) => string }) {
  const t = useT();
  const unassigned = isUnassigned(d);
  const source = sourceLabel(t, d, pct);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-gray-900" title={`${docLabel(d)}${d.folderPath ? `\n${d.folderPath}` : ""}`}>
          {docLabel(d)}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-gray-500">
          {dup && d.folderPath && (
            <span className="truncate rounded bg-gray-100 px-1" title={d.folderPath}>
              {d.folderPath.split("/").slice(-2).join("/")}
            </span>
          )}
          <span className="whitespace-nowrap">{classified ? t("grid.rowGroups", { count: total }) : t("grid.rowClashes", { count: total })}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onEdit}
        title={`${t("disc.change", { file: d.fileName })} · ${source}`}
        aria-label={`${t("disc.change", { file: d.fileName })}: ${unassigned ? t("disc.unassignedLabel") : d.discipline} (${source})`}
        className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${
          unassigned ? "border-amber-400 bg-amber-100 font-semibold text-amber-900 ring-2 ring-amber-300" : d.disciplineSource === "assignment" ? "border-brand-light/40 bg-brand/10 text-brand" : "border-gray-200 bg-gray-50 text-gray-700"
        } hover:border-brand`}
      >
        {unassigned ? t("disc.unassignedLabel") : (
          <>
            {d.discipline} <span className="font-normal text-gray-500">· {source}</span>
          </>
        )}{" "}
        ▾
      </button>
    </div>
  );
}

function Legend({ classified }: { classified: boolean }) {
  const t = useT();
  return (
    <div className="ml-auto flex items-center gap-2 text-gray-600">
      <span>{classified ? t("grid.legendGroups") : t("grid.legendClashes")}</span>
      <span className="flex items-center gap-0.5" aria-hidden>
        <span className="text-[10px]">{t("grid.legendScale")}</span>
        {HEAT.slice(1).map((c) => (
          <span key={c} className={`inline-block h-3 w-4 ${c.split(" ")[0]}`} />
        ))}
        <span className="text-[10px]">{t("grid.legendScaleMore")}</span>
      </span>
    </div>
  );
}

