/**
 * /proyectos/:projectId — model set cards with agent analysis status (spec §2.4).
 */
import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { useI18n, useT } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { ModelSetSummary } from "~/lib/api/types";
import { PageHeader } from "~/lib/components/PageHeader";
import { CopyCommand } from "~/lib/components/shell-widgets";
import { EmptyState, ErrorState, ProgressBar, Skeleton } from "~/lib/components/ui";
import { readJson, writeJson } from "~/lib/storage";
import { RECENT_KEY } from "./projects";

export function ProjectPage() {
  const t = useT();
  const api = useApi();
  const { projectId = "" } = useParams();
  const project = useAsync(() => api.getProject(projectId), [api, projectId]);
  const sets = useAsync(() => api.listModelSets(projectId), [api, projectId]);

  useEffect(() => {
    if (!project.data) return;
    const recent = readJson<string[]>(RECENT_KEY, []).filter((id) => id !== projectId);
    writeJson(RECENT_KEY, [projectId, ...recent].slice(0, 5));
  }, [project.data, projectId]);

  if (project.error) return <ErrorState error={project.error} onRetry={project.reload} />;
  return (
    <div>
      <PageHeader title={project.data?.name ?? t("common.loading")} crumbs={[{ label: t("nav.projects"), to: "/proyectos" }, { label: project.data?.name ?? "…" }]} subtitle={t("modelSets.title")} />
      {sets.loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
        </div>
      ) : sets.error ? (
        <ErrorState error={sets.error} onRetry={sets.reload} />
      ) : !sets.data?.length ? (
        <EmptyState title={t("modelSets.empty")} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {sets.data.map((ms) => (
            <ModelSetCard key={ms.id} ms={ms} projectId={projectId} />
          ))}
        </div>
      )}
    </div>
  );
}

function ModelSetCard({ ms, projectId }: { ms: ModelSetSummary; projectId: string }) {
  const t = useT();
  const { fmt } = useI18n();
  const status = ms.analyzedVersion === undefined ? "none" : ms.analyzedVersion < ms.latestVersion ? "stale" : "ok";
  return (
    <article className="rounded-lg border border-brand-muted/20 bg-white p-4 transition-all hover:border-brand-muted/40 hover:shadow-md">
      <header className="flex items-start justify-between gap-2">
        <h2 className="font-medium text-gray-900">{ms.name}</h2>
        <span className="font-mono text-xs text-gray-500">{t("modelSets.version", { version: ms.latestVersion })}</span>
      </header>
      <p className="mt-2 text-sm text-gray-600">
        {ms.lastTest ? t("modelSets.lastTest", { date: fmt.date(ms.lastTest.completedOn), count: ms.lastTest.clashCount }) : t("modelSets.lastTestNone")}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-gray-600">
        {t("modelSets.analysis")}:
        <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${status === "ok" ? "bg-green-600" : status === "stale" ? "bg-amber-500" : "bg-gray-300"}`} />
        <span className={status === "stale" ? "text-amber-800" : ""}>
          {status === "ok"
            ? t("modelSets.analysisUpToDate", { version: ms.analyzedVersion ?? "" })
            : status === "stale"
              ? t("modelSets.analysisStale", { version: ms.analyzedVersion ?? "" })
              : t("modelSets.analysisNone")}
        </span>
      </p>
      {ms.groupsTotal > 0 && (
        <div className="mt-3">
          <ProgressBar done={ms.groupsReviewed} total={ms.groupsTotal} />
          <p className="mt-1 text-xs text-gray-500">{t("modelSets.reviewed", { done: ms.groupsReviewed, total: ms.groupsTotal })}</p>
        </div>
      )}
      {ms.readyToApprove > 0 && <p className="mt-1 text-xs text-brand">{t("modelSets.readyToApprove", { count: ms.readyToApprove })}</p>}
      <footer className="mt-4 flex flex-wrap items-center gap-2">
        <Link to={`/coordinacion/${projectId}/${ms.id}`} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-light">
          {t("modelSets.openWorkspace")}
        </Link>
        <CopyCommand text={ms.agentCommand} compact />
      </footer>
    </article>
  );
}
