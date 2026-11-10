/**
 * /reglas/:ruleId — rule detail + performance (read-only in v1).
 */
import { Link, useParams } from "react-router";
import { useI18n, useT } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { DecisionState } from "~/lib/api/types";
import { DecisionStateIcon } from "~/lib/components/badges";
import { ChartCard } from "~/lib/components/charts";
import { PageHeader } from "~/lib/components/PageHeader";
import { copyText } from "~/lib/components/shell-widgets";
import { useToast } from "~/lib/components/Toast";
import { Banner, Button, ErrorState, SkeletonRows, cardCls } from "~/lib/components/ui";
import { BRAND } from "~/lib/charts/theme";
import { RULE_STATE_CLS } from "./rules";

const STATES: DecisionState[] = ["pending", "accepted", "corrected", "rejected", "postponed", "inherited"];
/** The server sends decision as free text; unknown values render as pending. */
function asDecisionState(v: string): DecisionState {
  return (STATES as string[]).includes(v) ? (v as DecisionState) : "pending";
}

export function RulePage() {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const toast = useToast();
  const { ruleId = "" } = useParams();
  const { data: r, error, loading, reload } = useAsync(() => api.getRule(ruleId), [api, ruleId]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !r) return <SkeletonRows count={4} height="h-16" />;
  return (
    <div>
      <PageHeader title={`${r.id} · ${r.nameEs ?? r.name}`} crumbs={[{ label: t("nav.rules"), to: "/reglas" }, { label: r.id }]} subtitle={<span className={RULE_STATE_CLS[r.state]}>{t(`rules.state.${r.state}`)}</span>} />
      <Banner tone="info" className="mb-4 rounded">
        {t("rules.readOnlyNote")}
      </Banner>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className={`${cardCls} space-y-3 p-4 text-sm`}>
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t("rules.description")}</h2>
            <p className="mt-1">{r.description}</p>
            {r.outcomeEs && <p className="mt-1 font-medium text-gray-800">{r.outcomeEs}</p>}
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-brand hover:underline">{t("rules.technicalDetail")}</summary>
            <div className="mt-2 space-y-3">
              <div>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t("rules.conditions")}</h2>
                <ul className="mt-1 list-disc pl-5 text-gray-700">
                  {r.conditions.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
              <p className="text-xs text-gray-600">
                {t("rules.columns.hits")}: {fmt.number(r.hits7d)} · {t("rules.columns.acceptance")}: {r.acceptance === null ? "—" : fmt.pct(r.acceptance)} · {t("rules.columns.corrections")}: {r.corrections}
              </p>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-500">{t("rules.file")}:</span>
                <code className="font-mono">{r.file}</code>
                <Button
                  onClick={async () => {
                    const ok = await copyText(r.file);
                    toast.show(ok ? t("common.copied") : t("common.unknownError"));
                  }}
                >
                  {t("rules.copyPath")}
                </Button>
              </div>
              <div>
                <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{t("rules.yaml")}</h2>
                <pre className="overflow-auto rounded border border-brand-muted/20 bg-gray-50 p-2 font-mono text-xs">{r.yaml}</pre>
              </div>
            </div>
          </details>
        </section>
        <div className="space-y-4">
          <ChartCard title={t("rules.reasonDistribution")} filename={`razones-${r.id}`} labels={r.reasonDistribution.map((x) => x.code)} series={[{ label: t("reports.count"), data: r.reasonDistribution.map((x) => x.count), color: BRAND }]} horizontal height={180} />
          <section className={`${cardCls} p-4`}>
            <h2 className="mb-2 text-sm font-semibold text-gray-800">{t("rules.recentHits")}</h2>
            {r.recentHits.length === 0 ? (
              <p className="text-sm text-gray-500">{t("rules.noData")}</p>
            ) : (
              <ul className="divide-y divide-brand-muted/10 text-sm">
                {r.recentHits.map((h) => (
                  <li key={h.groupId} className="flex items-center gap-2 py-1.5">
                    <DecisionStateIcon state={asDecisionState(h.decision)} />
                    <Link to={`/coordinacion/${h.projectId}/${h.modelSetId}?group=${h.groupId}&decision=`} className="min-w-0 flex-1 truncate hover:text-brand">
                      <span className="font-mono text-xs text-gray-500">{h.groupId}</span> {h.title}
                    </Link>
                    <span className="text-xs text-gray-400">{fmt.date(h.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
