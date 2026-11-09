/**
 * Filter bar (spec §3.6): search, filter chips with faceted multi-select
 * popovers, sort, view mode, saved views, clear-all.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT, type TKey } from "~/i18n";
import { IconPlus, IconSearch, IconStar, IconX } from "~/lib/components/icons";
import { inputCls } from "~/lib/components/ui";
import { readJson, writeJson } from "~/lib/storage";
import { useTriageContext } from "./actions";
import { FILTER_KEYS, FIXED_VALUES, SORT_KEYS, facetCounts, isDefaultQuery, tokenLabelKey, type FilterKey, type Filters, type ListQuery, type SortKey } from "./filters";
import { useTriage } from "./store";

const SORT_LABEL: Record<SortKey, TKey> = {
  priority: "sort.priority",
  confidence_asc: "sort.confidenceAsc",
  count_desc: "sort.countDesc",
  distance: "sort.distance",
  level: "sort.level",
  pair: "sort.pair",
  delta: "sort.delta",
  updated: "sort.updated",
};

interface SavedView {
  id: string;
  label: string;
  labelKey?: TKey;
  query: Omit<ListQuery, "q">;
}

const PRESETS: SavedView[] = [
  { id: "p1", label: "", labelKey: "views.pendingHigh", query: { filters: { decision: ["pendiente"], priority: ["1", "2"] }, sort: "priority", view: "families" } },
  { id: "p2", label: "", labelKey: "views.lowConfidence", query: { filters: { decision: ["pendiente"], confidence: ["baja"] }, sort: "confidence_asc", view: "families" } },
  { id: "p3", label: "", labelKey: "views.newInTest", query: { filters: { decision: ["pendiente"], delta: ["nueva"] }, sort: "priority", view: "families" } },
  { id: "p4", label: "", labelKey: "views.proposedFalsePositives", query: { filters: { decision: [], validity: ["falso_positivo"] }, sort: "priority", view: "families" } },
  { id: "p5", label: "", labelKey: "views.withIssueDraft", query: { filters: { decision: [], issue: ["borrador"] }, sort: "priority", view: "families" } },
  { id: "p6", label: "", labelKey: "views.resolvedByTest", query: { filters: { decision: [], delta: ["resuelta"] }, sort: "priority", view: "clashes" } },
];

const VIEWS_KEY = "coord.views";

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return { open, setOpen, ref };
}

function Popover({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      className="absolute left-0 top-8 z-30 max-h-80 min-w-[220px] overflow-y-auto rounded-lg border border-brand-muted/20 bg-white py-1 text-sm shadow-lg"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {children}
    </div>
  );
}

function FilterChip({ fkey, query, onChange, autoOpen }: { fkey: FilterKey; query: ListQuery; onChange: (f: Filters) => void; autoOpen?: boolean }) {
  const t = useT();
  const { store } = useTriageContext();
  const { open, setOpen, ref } = usePopover();
  const selected = query.filters[fkey] ?? [];
  const [counts, setCounts] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen, setOpen]);

  useEffect(() => {
    if (open) setCounts(facetCounts(store.allEvaluated(), query, fkey));
  }, [open, store, query, fkey]);

  const values = useMemo(() => {
    const fixed = FIXED_VALUES[fkey];
    const fromData = [...counts.keys()].sort(new Intl.Collator("es", { numeric: true }).compare);
    return fixed ?? fromData;
  }, [counts, fkey]);

  const label = (v: string) => {
    const k = tokenLabelKey(fkey, v);
    return k ? t(k) : v;
  };

  function toggle(v: string) {
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    onChange({ ...query.filters, [fkey]: next });
  }

  function remove() {
    const next = { ...query.filters };
    if (fkey === "decision") next.decision = [];
    else delete next[fkey];
    onChange(next);
  }

  const active = selected.length > 0;
  return (
    <div ref={ref} className="relative">
      <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${active ? "border-brand-light/40 bg-brand/5 text-brand" : "border-brand-muted/30 text-gray-600"}`}>
        <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="whitespace-nowrap">
          {t(`filters.${fkey}` as TKey)}
          {active && `: ${selected.slice(0, 2).map(label).join(", ")}${selected.length > 2 ? ` +${selected.length - 2}` : ""}`}
        </button>
        {active && (
          <button type="button" onClick={remove} aria-label={`${t("common.clear")} ${t(`filters.${fkey}` as TKey)}`} className="hover:text-brand-light">
            <IconX size={11} />
          </button>
        )}
      </span>
      {open && (
        <Popover onClose={() => setOpen(false)}>
          <div role="listbox" aria-multiselectable="true">
            {values.map((v, i) => (
              <label key={v} className="flex cursor-pointer items-center gap-2 px-3 py-1 hover:bg-brand-surface">
                <input type="checkbox" autoFocus={i === 0} className="accent-brand" checked={selected.includes(v)} onChange={() => toggle(v)} />
                <span className="flex-1">{label(v)}</span>
                <span className="font-mono text-[11px] text-gray-400">{counts.get(v) ?? 0}</span>
              </label>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}

export function FilterBar({ query, onChange }: { query: ListQuery; onChange: (q: ListQuery) => void }) {
  const t = useT();
  const { store } = useTriageContext();
  const manual = useTriage(store, (s) => s.manual);
  const hasFamilies = useTriage(store, (s) => s.families.size > 0);
  const [search, setSearch] = useState(query.q);
  const add = usePopover();
  const views = usePopover();
  const [justAdded, setJustAdded] = useState<FilterKey | null>(null);
  const [userViews, setUserViews] = useState<SavedView[]>(() => readJson<SavedView[]>(VIEWS_KEY, []));

  useEffect(() => setSearch(query.q), [query.q]);
  useEffect(() => {
    if (search === query.q) return;
    const id = window.setTimeout(() => onChange({ ...query, q: search }), 150);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // decision=[] means "all decisions": hide that chip unless the user just added it.
  const shown = FILTER_KEYS.filter((k) => query.filters[k] !== undefined && (k !== "decision" || (query.filters.decision?.length ?? 0) > 0 || justAdded === "decision"));
  const available = FILTER_KEYS.filter((k) => !shown.includes(k));

  function applyView(v: SavedView) {
    onChange({ ...v.query, q: "" });
    views.setOpen(false);
  }

  function saveView() {
    const name = window.prompt(t("views.name"));
    if (!name) return;
    const next = [...userViews, { id: `u${Date.now()}`, label: name, query: { filters: query.filters, sort: query.sort, view: query.view } }];
    setUserViews(next);
    writeJson(VIEWS_KEY, next);
    views.setOpen(false);
  }

  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-brand-muted/20 bg-white px-4 py-2">
      <label className="relative">
        <span className="sr-only">{t("shortcuts.search")}</span>
        <IconSearch size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
        <input id="triage-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("common.search")} className={`${inputCls} w-56 pl-7`} />
      </label>
      {query.docs && <DocsChip docs={query.docs} onClear={() => onChange({ ...query, docs: undefined })} />}
      {shown.map((k) => (
        <FilterChip key={k} fkey={k} query={query} onChange={(filters) => onChange({ ...query, filters })} autoOpen={justAdded === k} />
      ))}
      <div ref={add.ref} className="relative">
        <button id="add-filter-btn" type="button" aria-haspopup="menu" aria-expanded={add.open} onClick={() => add.setOpen((o) => !o)} className="inline-flex items-center gap-1 rounded-full border border-dashed border-brand-muted/40 px-2.5 py-0.5 text-xs text-gray-600 hover:text-brand">
          <IconPlus size={11} />
          {t("filters.add")}
        </button>
        {add.open && (
          <Popover onClose={() => add.setOpen(false)}>
            {available.map((k, i) => (
              <button
                key={k}
                type="button"
                autoFocus={i === 0}
                onClick={() => {
                  onChange({ ...query, filters: { ...query.filters, [k]: [] } });
                  setJustAdded(k);
                  add.setOpen(false);
                }}
                className="block w-full px-3 py-1 text-left hover:bg-brand-surface"
              >
                {t(`filters.${k}` as TKey)}
              </button>
            ))}
          </Popover>
        )}
      </div>
      {!isDefaultQuery(query) && (
        <button type="button" onClick={() => onChange({ filters: { decision: ["pendiente"] }, sort: query.sort, view: query.view, q: "", docs: undefined })} className="text-xs text-brand underline-offset-2 hover:underline">
          {t("list.clearFilters")}
        </button>
      )}
      <div className="ml-auto flex items-center gap-2 text-xs">
        <label className="flex items-center gap-1 text-gray-500">
          {t("sort.label")}
          <select value={query.sort} onChange={(e) => onChange({ ...query, sort: e.target.value as SortKey })} className={`${inputCls} py-0.5 text-xs`}>
            {SORT_KEYS.map((s) => (
              <option key={s} value={s}>
                {t(SORT_LABEL[s])}
              </option>
            ))}
          </select>
        </label>
        {!manual && (
          <div role="group" className="inline-flex overflow-hidden rounded border border-brand-muted/30">
            {(["families", "clashes"] as const).map((v) => {
              const on = v === "clashes" ? query.view === "clashes" : query.view !== "clashes";
              return (
                <button key={v} type="button" aria-pressed={on} title={v === "families" && !hasFamilies ? t("families.unavailable") : undefined} onClick={() => onChange({ ...query, view: v })} className={`px-2 py-0.5 ${on ? "bg-brand text-white" : "bg-white text-gray-600 hover:text-brand"}`}>
                  {v === "families" ? t("list.viewGroups") : t("list.viewClashes")}
                </button>
              );
            })}
          </div>
        )}
        <div ref={views.ref} className="relative">
          <button type="button" aria-haspopup="menu" aria-expanded={views.open} onClick={() => views.setOpen((o) => !o)} className="inline-flex items-center gap-1 rounded border border-brand-muted/30 px-2 py-0.5 text-gray-600 hover:text-brand">
            <IconStar size={12} />
            {t("views.label")}
          </button>
          {views.open && (
            <div className="absolute right-0 top-8 z-30 min-w-[220px] rounded-lg border border-brand-muted/20 bg-white py-1 text-sm shadow-lg" onKeyDown={(e) => e.key === "Escape" && views.setOpen(false)}>
              {[...PRESETS, ...userViews].map((v, i) => (
                <button key={v.id} type="button" autoFocus={i === 0} onClick={() => applyView(v)} className="block w-full px-3 py-1 text-left hover:bg-brand-surface">
                  {v.labelKey ? t(v.labelKey) : v.label}
                </button>
              ))}
              <div className="my-1 border-t border-brand-muted/20" />
              <button type="button" onClick={saveView} className="block w-full px-3 py-1 text-left text-brand hover:bg-brand-surface">
                {t("views.save")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const NO_DOCS: { documentId: number; name: string }[] = [];

/** Document-pair filter coming from the clash grid (docs=a,b). */
function DocsChip({ docs, onClear }: { docs: string; onClear: () => void }) {
  const t = useT();
  const { store } = useTriageContext();
  const documents = useTriage(store, (s) => s.payload?.test.documents ?? NO_DOCS);
  const [a, b] = docs.split(",").map(Number);
  const name = (id: number | undefined) => {
    const d = documents.find((x) => x.documentId === id);
    return d ? d.name.replace(" · ", " - ") : String(id ?? "");
  };
  const label = t("grid.docsFilter", { a: name(a), b: name(b ?? a) });
  return (
    <span className="inline-flex max-w-[420px] items-center gap-1 rounded-full border border-orange-300 bg-orange-50 px-2.5 py-0.5 text-xs text-orange-900" title={label}>
      <span className="truncate">{label}</span>
      <button type="button" onClick={onClear} aria-label={`${t("common.clear")} ${label}`} className="hover:text-brand">
        <IconX size={11} />
      </button>
    </span>
  );
}
