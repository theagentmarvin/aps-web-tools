/**
 * Home dashboard "/" (spec §6.1): queue, batches to approve, weekly KPIs,
 * agent activity. Shows the sign-in card when not authenticated (http mode).
 */
import { Link } from "react-router";
import { useI18n, useT } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import { useAuth } from "~/lib/auth-context";
import { SignInCard } from "~/lib/components/AuthGate";
import { IconChevronRight } from "~/lib/components/icons";
import { EmptyState, ErrorState, Skeleton, cardCls } from "~/lib/components/ui";
import { ReportKpis } from "~/features/reports/ReportKpis";

export function HomePage() {
  const api = useApi();
  const { isAuthenticated } = useAuth();
  const t = useT();
  if (api.mode !== "mock" && !isAuthenticated) return <SignInCard title={t("home.signInTitle")} body={t("home.signInBody")} />;
  return <Dashboard />;
}

function Dashboard() {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const { data, error, loading, reload } = useAsync(() => api.getHomeSummary(), [api]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const firstName = data?.user.name.split(" ")[0] ?? "";

  return (
    <div className="space-y-6">
      <header>
        {loading ? <Skeleton className="h-8 w-56" /> : <h1 className="text-2xl font-bold text-brand">{t("home.greeting", { name: firstName })}</h1>}
        <p className="mt-1 text-sm text-gray-500">{t("home.subtitle")}</p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={`${cardCls} p-4`} aria-labelledby="h-queue">
          <h2 id="h-queue" className="mb-3 text-sm font-semibold text-gray-800">
            {t("home.myQueue")}
          </h2>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : !data?.queue.length ? (
            <EmptyState title={t("home.queueEmpty")} />
          ) : (
            <ul className="divide-y divide-brand-muted/10">
              {data.queue.map((q) => (
                <li key={q.modelSetId}>
                  <Link to={`/coordinacion/${q.projectId}/${q.modelSetId}?decision=pendiente`} className="flex items-center justify-between gap-2 py-2 text-sm hover:text-brand">
                    <span className="truncate">
                      {q.projectName} / {q.modelSetName}
                    </span>
                    <span className="flex items-center gap-1 whitespace-nowrap text-gray-500">
                      {t("home.pending", { count: q.pending })}
                      <IconChevronRight size={14} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={`${cardCls} p-4`} aria-labelledby="h-batches">
          <h2 id="h-batches" className="mb-3 text-sm font-semibold text-gray-800">
            {t("home.batchesToApprove")}
          </h2>
          {loading ? (
            <Skeleton className="h-10" />
          ) : !data?.batches.length ? (
            <EmptyState title={t("home.noBatches")} />
          ) : (
            <ul className="divide-y divide-brand-muted/10">
              {data.batches.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="truncate">
                    <span className="font-mono text-xs text-gray-500">{b.id}</span> {b.projectName.split(" — ")[0]} · {b.counts.issuesCreate + b.counts.statusChanges} {t("approvals.columns.changes").toLowerCase()}
                  </span>
                  <Link to={`/aprobaciones/${b.id}`} className="rounded border border-brand-muted/30 px-2 py-0.5 text-xs text-gray-700 hover:text-brand">
                    {t("approvals.review")}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section aria-labelledby="h-kpis">
        <h2 id="h-kpis" className="mb-2 text-sm font-semibold text-gray-800">
          {t("home.weekKpis")}
        </h2>
        {data ? <ReportKpis kpis={data.kpis} /> : <Skeleton className="h-24" />}
      </section>

      <section className={`${cardCls} p-4`} aria-labelledby="h-activity">
        <h2 id="h-activity" className="mb-3 text-sm font-semibold text-gray-800">
          {t("home.agentActivity")}
        </h2>
        {!data?.activity.length ? (
          loading ? <Skeleton className="h-16" /> : <EmptyState title={t("home.noActivity")} />
        ) : (
          <ul className="space-y-1.5 text-sm">
            {data.activity.map((a, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-28 shrink-0 text-xs text-gray-400">{fmt.relative(a.at)}</span>
                <span lang="es">{a.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
