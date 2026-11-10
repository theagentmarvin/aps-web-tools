/**
 * /proyectos/:projectId — model set page in the language of ACC Model
 * Coordination: Clash grid (matriz), Clash checks (pruebas), Disciplinas,
 * Closed (cerradas). Query: modelSet, test (test key or ACC test id), tab.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { ClashGrid, GridDocument, ModelSetSummary, ProjectDisciplines, TestsOverview } from "~/lib/api/types";
import { PageHeader } from "~/lib/components/PageHeader";
import { CopyCommand } from "~/lib/components/shell-widgets";
import { useToast } from "~/lib/components/Toast";
import { Button, EmptyState, ErrorState, Skeleton, inputCls } from "~/lib/components/ui";
import { readJson, writeJson } from "~/lib/storage";
import { ClashGridView } from "~/features/modelset/ClashGridView";
import { DisciplineDialog } from "~/features/modelset/DisciplineDialog";
import { DisciplinesPanel } from "~/features/modelset/DisciplinesPanel";
import { IssueSettingsPanel } from "~/features/modelset/IssueSettingsPanel";
import { IngestProgressBar } from "~/features/modelset/IngestProgressBar";
import { TestChecks, testState } from "~/features/modelset/TestChecks";
import { useIngest } from "~/features/modelset/useIngest";
import { loadDisciplines, loadGrid } from "~/features/modelset/gridFallback";
import { RECENT_KEY } from "./projects";
import { CycleReportMenu } from "~/features/modelset/CycleReportMenu";
import { HygienePanel } from "~/features/modelset/HygienePanel";
import { ProjectNotesPanel } from "~/features/modelset/ProjectNotesPanel";

const TABS = ["matriz", "pruebas", "disciplinas", "higiene", "cerradas"] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY: Record<Tab, TKey> = { matriz: "grid.tabs.grid", pruebas: "grid.tabs.checks", disciplinas: "grid.tabs.disciplines", higiene: "parity.hygiene.tab", cerradas: "grid.tabs.closed" };

export function ProjectPage() {
  const t = useT();
  const api = useApi();
  const { projectId = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const project = useAsync(() => api.getProject(projectId), [api, projectId]);
  const sets = useAsync(() => api.listModelSets(projectId), [api, projectId]);

  useEffect(() => {
    if (!project.data) return;
    const recent = readJson<string[]>(RECENT_KEY, []).filter((id) => id !== projectId);
    writeJson(RECENT_KEY, [projectId, ...recent].slice(0, 5));
  }, [project.data, projectId]);

  if (project.error) return <ErrorState error={project.error} onRetry={project.reload} />;
  const selectedId = sp.get("modelSet") ?? sets.data?.[0]?.id;
  const ms = sets.data?.find((m) => m.id === selectedId);

  return (
    <div>
      <PageHeader title={project.data?.name ?? t("common.loading")} crumbs={[{ label: t("nav.projects"), to: "/proyectos" }, { label: project.data?.name ?? "…" }]} />
      <ProjectNotesPanel projectId={projectId} />
      {sets.loading ? (
        <Skeleton className="h-96" />
      ) : sets.error ? (
        <ErrorState error={sets.error} onRetry={sets.reload} />
      ) : !sets.data?.length ? (
        <EmptyState title={t("modelSets.empty")} />
      ) : (
        <>
          {sets.data.length > 1 && (
            <div role="tablist" aria-label={t("modelSets.title")} className="mb-4 flex flex-wrap gap-2">
              {sets.data.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={m.id === selectedId}
                  onClick={() => setSp({ modelSet: m.id }, { replace: true })}
                  className={`rounded-full border px-3 py-1 text-sm ${m.id === selectedId ? "border-brand-light/40 bg-brand/5 text-brand" : "border-brand-muted/30 text-gray-600 hover:text-brand"}`}
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
          {ms && <ModelSetPanel key={ms.id} projectId={projectId} projectName={project.data?.name ?? ""} ms={ms} onChanged={sets.reload} />}
        </>
      )}
    </div>
  );
}

function ModelSetPanel({ projectId, projectName, ms, onChanged }: { projectId: string; projectName: string; ms: ModelSetSummary; onChanged: () => void }) {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(sp.get("tab") ?? "") ? (sp.get("tab") as Tab) : "matriz";
  const test = sp.get("test") ?? undefined;
  const overview = useAsync<TestsOverview>(() => api.getTestsOverview(projectId, ms.id), [api, projectId, ms.id]);
  const gridQ = useAsync<ClashGrid>(() => loadGrid(api, projectId, ms.id, test, overview.data?.tests), [api, projectId, ms.id, test]);
  const disciplines = useAsync<ProjectDisciplines & { unsupported?: boolean }>(() => loadDisciplines(api, projectId), [api, projectId]);
  const [queue, setQueue] = useState<GridDocument[] | null>(null);

  const setParam = useCallback(
    (k: string, v: string | undefined) => {
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (v) next.set(k, v);
          else next.delete(k);
          return next;
        },
        { replace: true },
      );
    },
    [setSp],
  );

  const grid = gridQ.data;
  const selectedAcc = grid?.accTestId;
  const ingest = useIngest(projectId, ms.id, {
    onGridReady: (acc) => {
      if (!test || acc === selectedAcc || acc === test) gridQ.reload();
    },
    onDone: (acc) => {
      const run = overview.data?.tests.find((r) => r.accTestId === acc);
      toast.show(t("modelSets.analyzed", { version: run?.modelSetVersion ?? "" }));
      overview.reload();
      gridQ.reload();
      onChanged();
    },
    onError: (_acc, err) => toast.show(t("ingest.failed", { error: err }), { tone: "error" }),
  });

  const tests = overview.data?.tests ?? [];
  const current = tests.find((r) => r.accTestId === grid?.accTestId);
  const job = grid ? ingest.jobs[grid.accTestId] : undefined;

  function openPair(a: GridDocument, b: GridDocument) {
    if (!grid?.testKey) {
      toast.show(t("grid.needsAnalysis"), { action: { label: t("grid.analyze"), onClick: () => grid && void ingest.start(grid.accTestId) } });
      return;
    }
    const docs = [a.documentId, b.documentId].sort((x, y) => x - y).join(",");
    navigate(`/coordinacion/${projectId}/${ms.id}?test=${grid.testKey}&docs=${docs}&decision=`);
  }

  return (
    <section aria-label={ms.name}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-gray-900">{ms.name}</h2>
        <label className="flex items-center gap-2 text-xs text-gray-600">
          {t("grid.version")}
          <select className={`${inputCls} text-xs`} value={grid?.accTestId ?? ""} onChange={(e) => setParam("test", e.target.value)} disabled={!tests.length}>
            {tests.map((r) => (
              <option key={r.accTestId} value={r.accTestId}>
                v{r.modelSetVersion} · {r.completedOn ? fmt.date(r.completedOn) : "—"} · {t(`grid.state.${testState(r)}` as TKey)}
              </option>
            ))}
          </select>
        </label>
        {current && testState(current) === "classified" && (
          <Link to={`/coordinacion/${projectId}/${ms.id}?test=${current.id}`} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-light">
            {t("grid.openCoordination")}
          </Link>
        )}
        <CycleReportMenu projectId={projectId} projectName={projectName} modelSetId={ms.id} modelSetName={ms.name} />
        <span className="ml-auto">
          <CopyCommand text={ms.agentCommand} compact />
        </span>
      </div>

      <div role="tablist" className="mb-4 flex gap-1 border-b border-brand-muted/20">
        {TABS.map((tb) => (
          <button
            key={tb}
            type="button"
            role="tab"
            aria-selected={tab === tb}
            onClick={() => setParam("tab", tb === "matriz" ? undefined : tb)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === tb ? "border-brand text-brand" : "border-transparent text-gray-600 hover:text-brand"}`}
          >
            {t(TAB_KEY[tb])}
          </button>
        ))}
      </div>

      {tab === "matriz" &&
        (gridQ.error ? (
          <ErrorState error={gridQ.error} onRetry={gridQ.reload} />
        ) : !grid ? (
          <Skeleton className="h-96" />
        ) : (
          <div className="space-y-3">
            {job && <IngestProgressBar p={job} />}
            {grid.state === "none" ? (
              <EmptyState
                title={t("grid.stateNone")}
                action={
                  <Button variant="primary" disabled={!!job && job.phase !== "failed" && job.phase !== "done"} onClick={() => void ingest.start(grid.accTestId)}>
                    {t("grid.analyze")} v{grid.modelSetVersion}
                  </Button>
                }
              />
            ) : (
              <>
                {grid.state === "counts" && !job && (
                  <div className="flex justify-end">
                    <Button onClick={() => void ingest.start(grid.accTestId, { refresh: true })}>
                      {t("grid.analyze")} v{grid.modelSetVersion}
                    </Button>
                  </div>
                )}
                <ClashGridView grid={grid} views={overview.data?.views ?? []} onOpenPair={openPair} onEditDiscipline={(docs) => setQueue(docs)} />
              </>
            )}
          </div>
        ))}
      {tab === "pruebas" &&
        (overview.error ? (
          <ErrorState error={overview.error} onRetry={overview.reload} />
        ) : overview.loading ? (
          <Skeleton className="h-48" />
        ) : (
          <TestChecks
            projectId={projectId}
            modelSetId={ms.id}
            tests={tests}
            jobs={ingest.jobs}
            onIngest={(r, refresh) => void ingest.start(r.accTestId, { refresh })}
            onShowGrid={(r) => {
              setParam("test", r.accTestId);
              setParam("tab", undefined);
            }}
          />
        ))}
      {tab === "disciplinas" && <DisciplinesPanel projectId={projectId} modelSetId={ms.id} grid={grid} test={test} onGrid={gridQ.setData} />}
      {tab === "disciplinas" && <div className="mt-6"><IssueSettingsPanel projectId={projectId} /></div>}
      {tab === "higiene" && <HygienePanel testKey={grid?.state === "classified" ? grid.testKey : undefined} version={grid?.modelSetVersion} />}
      {tab === "cerradas" && <EmptyState title={t("grid.tabs.closed")} body={t("grid.closedEmpty")} />}

      {queue && disciplines.data && (
        <DisciplineDialog projectId={projectId} modelSetId={ms.id} test={test} queue={queue} disciplines={disciplines.data.disciplines} onGrid={(g) => gridQ.setData(g)} onClose={() => setQueue(null)} />
      )}
    </section>
  );
}

/** Kept for the triage "not ingested" panel: the tests of a model set with Analizar and progress. */
export function TestList({ projectId, modelSetId, onChanged }: { projectId: string; modelSetId: string; onChanged: () => void }) {
  const api = useApi();
  const overview = useAsync<TestsOverview>(() => api.getTestsOverview(projectId, modelSetId), [api, projectId, modelSetId]);
  const ingest = useIngest(projectId, modelSetId, {
    onDone: () => {
      overview.reload();
      onChanged();
    },
  });
  if (overview.loading) return <Skeleton className="mt-3 h-10" />;
  if (overview.error) return <ErrorState error={overview.error} onRetry={overview.reload} />;
  return (
    <div className="mt-3">
      <TestChecks projectId={projectId} modelSetId={modelSetId} tests={overview.data?.tests ?? []} jobs={ingest.jobs} onIngest={(r, refresh) => void ingest.start(r.accTestId, { refresh })} onShowGrid={() => undefined} />
    </div>
  );
}
