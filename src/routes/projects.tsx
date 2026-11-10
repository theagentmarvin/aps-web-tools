/**
 * /proyectos — hub → project picker (spec §2.4). Remembers the last hub and
 * the five most recently opened projects.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useT } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { ProjectSummary } from "~/lib/api/types";
import { PageHeader } from "~/lib/components/PageHeader";
import { EmptyState, ErrorState, Skeleton, inputCls } from "~/lib/components/ui";
import { readJson, readString, writeString } from "~/lib/storage";

export const RECENT_KEY = "coord.recentProjects";

export const LAST_WORKSPACE_KEY = "coord.lastWorkspace";

export function ProjectsPage() {
  const t = useT();
  const api = useApi();
  const hubs = useAsync(() => api.listHubs(), [api]);
  const [hubId, setHubId] = useState<string | null>(() => readString("coord.lastHub"));
  const [q, setQ] = useState("");
  const projects = useAsync(() => (hubId ? api.listProjects({ hubId }) : Promise.resolve([] as ProjectSummary[])), [api, hubId]);
  const all = useAsync(() => api.listProjects(), [api]);
  const recentIds = readJson<string[]>(RECENT_KEY, []);
  // "Continue where you left off" (was on the removed Inicio page): the last coordinación opened.
  const last = readJson<{ url: string; label: string } | null>(LAST_WORKSPACE_KEY, null);
  const recent = (all.data ?? []).filter((p) => recentIds.includes(p.id)).sort((a, b) => recentIds.indexOf(a.id) - recentIds.indexOf(b.id));

  useEffect(() => {
    if (!hubId && hubs.data?.length) setHubId(hubs.data[0].id);
  }, [hubId, hubs.data]);

  function pickHub(id: string) {
    setHubId(id);
    writeString("coord.lastHub", id);
  }

  if (hubs.error) return <ErrorState error={hubs.error} onRetry={hubs.reload} />;
  const filtered = (projects.data ?? []).filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <PageHeader title={t("projects.title")} />
      {last && (
        <p className="-mt-2 mb-3 text-sm">
          <Link to={last.url} className="text-brand hover:underline">
            {t("projects.continue", { label: last.label })} →
          </Link>
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-[240px_1fr]">
        <nav aria-label={t("projects.hubs")}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{t("projects.hubs")}</h2>
          {hubs.loading ? (
            <Skeleton className="h-20" />
          ) : (
            <ul className="space-y-1">
              {hubs.data?.map((h) => (
                <li key={h.id}>
                  <button type="button" aria-current={hubId === h.id} onClick={() => pickHub(h.id)} className={`w-full rounded px-3 py-2 text-left text-sm ${hubId === h.id ? "bg-brand-surface font-medium text-brand" : "text-gray-700 hover:bg-gray-50"}`}>
                    {h.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
        <div className="space-y-6">
          {recent.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{t("projects.recent")}</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {recent.slice(0, 5).map((p) => (
                  <ProjectCard key={p.id} p={p} />
                ))}
              </div>
            </section>
          )}
          <section>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("projects.searchProjects")} aria-label={t("projects.searchProjects")} className={`${inputCls} mb-3 w-72`} />
            {!hubId ? (
              <EmptyState title={t("projects.selectHub")} />
            ) : projects.loading ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
            ) : projects.error ? (
              <ErrorState error={projects.error} onRetry={projects.reload} />
            ) : filtered.length === 0 ? (
              <EmptyState title={t("projects.noProjects")} />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {filtered.map((p) => (
                  <ProjectCard key={p.id} p={p} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function ProjectCard({ p }: { p: ProjectSummary }) {
  const t = useT();
  return (
    <Link to={`/proyectos/${p.id}`} className="block rounded-lg border border-brand-muted/20 bg-white p-4 transition-all hover:border-brand-muted/40 hover:shadow-md">
      <div className="font-medium text-gray-900">{p.name}</div>
      {p.modelSetCount > 0 && <div className="mt-1 text-xs text-gray-500">{t("projects.modelSets", { count: p.modelSetCount })}</div>}
      {p.pendingDecisions > 0 && <span className="mt-2 inline-block rounded-full bg-brand/10 px-2 py-0.5 text-xs text-brand">{t("projects.pendingBadge", { count: p.pendingDecisions })}</span>}
    </Link>
  );
}
