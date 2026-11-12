/**
 * "Disciplinas" tab: the project's naming rules in order (add, edit, delete,
 * reorder by drag or Alt+↑/↓), test them against the current models, save;
 * plus agent discipline_mapping proposals with Accept / Reject.
 * Precedence: manual assignment > project rules > Revit categories.
 */
import { useEffect, useState } from "react";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { ClashGrid, DisciplinePreview, DisciplineRuleInput, DisciplineSuggestion, ProjectDisciplines } from "~/lib/api/types";
import { useToast } from "~/lib/components/Toast";
import { IconArrowDown, IconArrowUp, IconX } from "~/lib/components/icons";
import { Banner, Button, EmptyState, ErrorState, Skeleton, cardCls, inputCls } from "~/lib/components/ui";
import { assignDiscipline, ruleText } from "./disciplines";
import { loadDisciplines } from "./gridFallback";

interface Props {
  projectId: string;
  modelSetId: string;
  grid?: ClashGrid;
  test?: string;
  onGrid: (g: ClashGrid) => void;
}

const FIELDS: DisciplineRuleInput["field"][] = ["fileName", "folder", "viewName"];
const MATCHES: DisciplineRuleInput["match"][] = ["contains", "startsWith", "regex"];

export function DisciplinesPanel({ projectId, modelSetId, grid, test, onGrid }: Props) {
  const t = useT();
  const api = useApi();
  const { data, error, loading, reload } = useAsync<ProjectDisciplines>(() => loadDisciplines(api, projectId), [api, projectId]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <Skeleton className="h-48" />;
  const regrid = () => void api.getClashGrid(projectId, modelSetId, test).then(onGrid, () => undefined);
  return (
    <div className="space-y-6">
      <Banner tone="info" className="rounded">
        <strong>{t("disc.precedence")}</strong>
      </Banner>
      {data.unsupported && (
        <Banner tone="warning" className="rounded">
          {t("disc.unsupported")}
        </Banner>
      )}
      <RulesEditor
        projectId={projectId}
        modelSetId={modelSetId}
        data={data}
        readOnly={!!data.unsupported}
        onSaved={() => {
          reload();
          regrid();
        }}
      />
      <Suggestions projectId={projectId} modelSetId={modelSetId} data={data} grid={grid} test={test} onGrid={onGrid} onChanged={reload} />
    </div>
  );
}

function RulesEditor({ projectId, modelSetId, data, readOnly, onSaved }: { projectId: string; modelSetId: string; data: ProjectDisciplines; readOnly: boolean; onSaved: () => void }) {
  const t = useT();
  const { lang } = useI18n();
  const api = useApi();
  const toast = useToast();
  const [rules, setRules] = useState<DisciplineRuleInput[]>(data.rules);
  const [dirty, setDirty] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [preview, setPreview] = useState<DisciplinePreview | null>(null);
  const [saving, setSaving] = useState(false);
  const codes = data.disciplines;

  useEffect(() => {
    setRules(data.rules);
    setDirty(false);
  }, [data.rules]);

  const change = (next: DisciplineRuleInput[]) => {
    setRules(next);
    setDirty(true);
    setPreview(null);
  };
  const patch = (i: number, p: Partial<DisciplineRuleInput>) => change(rules.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rules.length || from === to) return;
    const next = [...rules];
    const [r] = next.splice(from, 1);
    next.splice(to, 0, r);
    change(next);
  };

  async function test() {
    try {
      setPreview(await api.previewDisciplineRules(projectId, { modelSetId, rules }));
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), { tone: "error" });
    }
  }

  async function save() {
    setSaving(true);
    try {
      await api.saveDisciplineRules(projectId, rules, data.version);
      setDirty(false);
      toast.show(t("disc.rulesSaved"));
      onSaved();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), { tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={`${cardCls} space-y-3 p-4 text-sm`} aria-labelledby="h-rules">
      <header className="flex flex-wrap items-center gap-2">
        <h2 id="h-rules" className="font-semibold text-gray-800">
          {t("disc.rulesTitle")}
        </h2>
        {dirty && <span className="rounded bg-amber-50 px-1.5 text-[11px] text-amber-800">{t("disc.unsaved")}</span>}
      </header>
      <p className="text-xs text-gray-600">{t("disc.rulesIntro")}</p>
      {rules.length === 0 && <p className="text-xs text-gray-500">{t("disc.noRules")}</p>}
      <ol className="space-y-1.5">
        {rules.map((r, i) => {
          const res = preview?.rules.find((x) => x.index === i);
          return (
            <li
              key={r.id ?? `new-${i}`}
              draggable={!readOnly}
              onDragStart={() => setDragFrom(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom !== null) move(dragFrom, i);
                setDragFrom(null);
              }}
              onKeyDown={(e) => {
                if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                  e.preventDefault();
                  move(i, e.key === "ArrowUp" ? i - 1 : i + 1);
                }
              }}
              className={`rounded border px-2 py-1.5 ${dragFrom === i ? "border-brand bg-brand/5" : "border-brand-muted/20 bg-white"}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span aria-label={t("disc.dragHandle")} title={t("disc.dragHandle")} className="cursor-grab select-none text-gray-400">
                  ⋮⋮
                </span>
                <span className="w-6 text-right font-mono text-xs text-gray-400">{i + 1}.</span>
                <select aria-label={t("disc.fieldLabel")} disabled={readOnly} className={`${inputCls} py-0.5 text-xs`} value={r.field} onChange={(e) => patch(i, { field: e.target.value as DisciplineRuleInput["field"] })}>
                  {FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {t(`disc.field.${f}` as TKey)}
                    </option>
                  ))}
                </select>
                <select aria-label={t("disc.matchLabel")} disabled={readOnly} className={`${inputCls} py-0.5 text-xs`} value={r.match} onChange={(e) => patch(i, { match: e.target.value as DisciplineRuleInput["match"] })}>
                  {MATCHES.map((m) => (
                    <option key={m} value={m}>
                      {t(`disc.match.${m}` as TKey)}
                    </option>
                  ))}
                </select>
                <input aria-label={t("disc.token")} disabled={readOnly} className={`${inputCls} w-44 py-0.5 font-mono text-xs`} value={r.value} onChange={(e) => patch(i, { value: e.target.value })} />
                <span aria-hidden>→</span>
                <select aria-label={t("disc.choose")} disabled={readOnly} className={`${inputCls} py-0.5 text-xs`} value={r.discipline} onChange={(e) => patch(i, { discipline: e.target.value })}>
                  {codes.map((d) => (
                    <option key={d.code} value={d.code}>
                      {d.code} · {lang === "en" ? d.en : d.es}
                    </option>
                  ))}
                </select>
                {!readOnly && (
                  <span className="ml-auto flex gap-1">
                    <button type="button" aria-label={t("disc.moveUp")} title={`${t("disc.moveUp")} (Alt+↑)`} disabled={i === 0} onClick={() => move(i, i - 1)} className="rounded p-1 text-gray-500 hover:text-brand disabled:opacity-30">
                      <IconArrowUp size={13} />
                    </button>
                    <button type="button" aria-label={t("disc.moveDown")} title={`${t("disc.moveDown")} (Alt+↓)`} disabled={i === rules.length - 1} onClick={() => move(i, i + 1)} className="rounded p-1 text-gray-500 hover:text-brand disabled:opacity-30">
                      <IconArrowDown size={13} />
                    </button>
                    <button type="button" aria-label={t("disc.deleteRule")} title={t("disc.deleteRule")} onClick={() => change(rules.filter((_, j) => j !== i))} className="rounded p-1 text-gray-500 hover:text-red-700">
                      <IconX size={13} />
                    </button>
                  </span>
                )}
              </div>
              {res && (
                <p className="mt-1 pl-14 text-xs text-gray-600" aria-live="polite">
                  {res.matches.length === 0
                    ? t("disc.previewNone")
                    : t("disc.rulePreview", { count: res.matches.length, effective: res.effective, names: res.matches.map((m) => `${m.fileName} - ${m.viewName}`).join(", ") })}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => change([...rules, { discipline: codes[0]?.code ?? "ARQ", field: "fileName", match: "contains", value: "" }])}>{t("disc.addRule")}</Button>
          <Button onClick={test} disabled={!rules.length}>
            {t("disc.test")}
          </Button>
          <Button variant="primary" className="ml-auto" disabled={!dirty || saving || rules.some((r) => !r.value.trim())} onClick={save}>
            {t("disc.saveRules")}
          </Button>
        </div>
      )}
    </section>
  );
}

function Suggestions({ projectId, modelSetId, data, grid, test, onGrid, onChanged }: { projectId: string; modelSetId: string; data: ProjectDisciplines; grid?: ClashGrid; test?: string; onGrid: (g: ClashGrid) => void; onChanged: () => void }) {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(s: DisciplineSuggestion, decision: "approve" | "reject") {
    setBusy(s.id);
    try {
      if (decision === "approve") {
        // Accepting = the same PUT as assigning from the grid (the rule is saved once, with the first document).
        let g: ClashGrid | undefined;
        for (const [i, urn] of s.lineageUrns.entries()) g = await assignDiscipline(api, projectId, modelSetId, { lineageUrn: urn }, { discipline: s.discipline, ...(i === 0 && s.rule ? { createRule: s.rule } : {}) }, test);
        if (g) onGrid(g);
      }
      await api.decideDisciplineSuggestion(projectId, s.id, decision);
      toast.show(decision === "approve" ? t("disc.accepted") : t("disc.rejected"));
      onChanged();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  const fileLabel = (s: DisciplineSuggestion) => (s.fileNames.length ? s.fileNames : s.lineageUrns.map((u) => grid?.documents.find((d) => d.lineageUrn === u)?.fileName ?? u));

  return (
    <section className="space-y-2" aria-labelledby="h-sugg">
      <h2 id="h-sugg" className="text-sm font-semibold text-gray-800">
        {t("disc.suggestionsTitle")}
      </h2>
      {data.suggestions.length === 0 ? (
        <EmptyState title={t("disc.noSuggestions")} />
      ) : (
        data.suggestions.map((s) => (
          <article key={s.id} className={`${cardCls} flex flex-wrap items-start gap-3 p-3 text-sm`}>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-medium text-gray-900">
                {s.discipline || s.summary}
                {s.confidence !== undefined && <span className="ml-2 text-xs font-normal text-gray-500">{fmt.pct(s.confidence)}</span>}
                <span className="ml-2 font-mono text-[11px] font-normal text-gray-400">{s.id}</span>
              </p>
              {s.summary && s.discipline && <p className="text-xs text-gray-700">{s.summary}</p>}
              <p className="text-xs text-gray-600">{t("disc.suggestionFiles", { files: fileLabel(s).join(", ") })}</p>
              {s.rule && <p className="text-xs text-gray-600">{ruleText(t, s.rule)}</p>}
              <p className="text-xs text-gray-700" lang="es">
                {s.rationale}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" disabled={busy !== null || !s.discipline || !s.lineageUrns.length} onClick={() => decide(s, "approve")}>
                {t("disc.accept")}
              </Button>
              <Button disabled={busy !== null} onClick={() => decide(s, "reject")}>
                {t("disc.reject")}
              </Button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
