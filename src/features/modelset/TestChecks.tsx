/**
 * "Pruebas" tab: the clash tests of the model set as cards (version, date,
 * clashes, models, state, delta vs previous version) with Analizar/Actualizar
 * and live ingest progress.
 */
import { Link } from "react-router";
import { useI18n, useT, type TKey } from "~/i18n";
import type { GridState, TestRunInfo } from "~/lib/api/types";
import { Button, EmptyState, cardCls } from "~/lib/components/ui";
import { IngestProgressBar } from "./IngestProgressBar";
import type { IngestProgress } from "./useIngest";

const STATE_CLS: Record<GridState, string> = {
  none: "border-gray-200 bg-gray-50 text-gray-600",
  counts: "border-orange-200 bg-orange-50 text-orange-900",
  classified: "border-green-200 bg-green-50 text-green-800",
};

export function testState(r: TestRunInfo): GridState {
  return r.state ?? (r.cached ? "classified" : "none");
}

export function TestChecks({
  projectId,
  modelSetId,
  tests,
  jobs,
  onIngest,
  onShowGrid,
}: {
  projectId: string;
  modelSetId: string;
  tests: TestRunInfo[];
  jobs: Record<string, IngestProgress>;
  onIngest: (r: TestRunInfo, refresh: boolean) => void;
  onShowGrid: (r: TestRunInfo) => void;
}) {
  const t = useT();
  const { fmt } = useI18n();
  if (!tests.length) return <EmptyState title={t("modelSets.lastTestNone")} />;
  return (
    <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {tests.map((r) => {
        const state = testState(r);
        const job = jobs[r.accTestId];
        const running = job && job.phase !== "done" && job.phase !== "failed";
        return (
          <li key={r.accTestId} className={`${cardCls} flex flex-col gap-2 p-4 text-sm`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-lg font-semibold text-gray-900">v{r.modelSetVersion}</p>
                <p className="text-xs text-gray-500">{r.completedOn ? fmt.date(r.completedOn) : "—"}</p>
              </div>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${STATE_CLS[state]}`}>{t(`grid.state.${state}` as TKey)}</span>
            </div>
            <p className="text-xs text-gray-700">
              {state !== "none" && r.clashCount > 0 && <span>{t("list.clashesCount", { count: r.clashCount })} · </span>}
              {r.documentCount !== undefined && <span>{t("grid.models", { count: r.documentCount })}</span>}
            </p>
            {state !== "none" && (
              <p className="text-xs">
                {r.delta ? (
                  <>
                    <span className="text-red-700">+{fmt.number(r.delta.new)}</span>
                    <span className="text-gray-400"> · </span>
                    <span className="text-green-700">−{fmt.number(r.delta.resolved)}</span>
                    <span className="text-gray-400"> · </span>
                    <span className="text-gray-600">{t("grid.persisting", { count: r.delta.persisting })}</span>
                  </>
                ) : (
                  <span className="text-gray-500">{t("grid.firstVersion")}</span>
                )}
              </p>
            )}
            {job && <IngestProgressBar p={job} />}
            <div className="mt-auto flex flex-wrap gap-2 pt-1">
              {state !== "none" && (
                <Button onClick={() => onShowGrid(r)} className="text-xs">
                  {t("grid.tabs.grid")}
                </Button>
              )}
              {state === "classified" && (
                <Link to={`/coordinacion/${projectId}/${modelSetId}?test=${r.id}`} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-light">
                  {t("grid.openCoordination")}
                </Link>
              )}
              <Button variant={state === "none" ? "primary" : "secondary"} disabled={!!running} onClick={() => onIngest(r, state !== "none")} className="text-xs">
                {state === "none" ? t("grid.analyze") : t("grid.update")}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
