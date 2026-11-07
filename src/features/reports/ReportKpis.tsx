/**
 * KPI row K1–K6 (spec §6.2), shared by Home and Reports.
 */
import { useI18n, useT } from "~/i18n";
import type { ReportData } from "~/lib/api/types";
import { KpiTile } from "~/lib/components/charts";
import { ProgressBar } from "~/lib/components/ui";
import { useSettings } from "~/lib/settings";

export function ReportKpis({ kpis }: { kpis: ReportData["kpis"] }) {
  const t = useT();
  const { fmt } = useI18n();
  const { settings } = useSettings();
  const k = kpis;
  const deltaPct = k.activeClashesPrev ? (k.activeClashes - k.activeClashesPrev) / k.activeClashesPrev : null;
  const aiTotal = k.aiAccepted + k.aiCorrected + k.aiRejected;
  const savedHours = Math.max(0, (k.rawClashesReviewed * settings.baselineSec - k.actualReviewSeconds) / 3600);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <KpiTile
        label={t("reports.kpi.activeClashes")}
        value={fmt.number(k.activeClashes)}
        delta={deltaPct === null ? undefined : t("reports.kpi.vsPrevious", { delta: fmt.pct(Math.abs(deltaPct)) })}
        deltaGood={deltaPct !== null && deltaPct <= 0}
      />
      <KpiTile label={t("reports.kpi.groups")} value={fmt.number(k.groups)}>
        <div className="mt-0.5 text-xs text-gray-500">{t("reports.kpi.reduction", { pct: fmt.pct(k.rawClashes ? 1 - k.groups / k.rawClashes : 0) })}</div>
      </KpiTile>
      <KpiTile label={t("reports.kpi.reviewed")} value={fmt.pct(k.groups ? k.groupsReviewed / k.groups : 0)}>
        <ProgressBar done={k.groupsReviewed} total={k.groups} className="mt-2" />
      </KpiTile>
      <KpiTile label={t("reports.kpi.issuesCreated")} value={fmt.number(k.issuesCreated)} />
      <KpiTile label={t("reports.kpi.aiAcceptance")} value={fmt.pct(aiTotal ? k.aiAccepted / aiTotal : 0)} />
      <KpiTile label={t("reports.kpi.timeSaved")} value={t("reports.kpi.timeSavedValue", { hours: fmt.number(savedHours) })} hint={t("reports.kpi.timeSavedFormula", { baseline: settings.baselineSec })}>
        <div className="mt-0.5 text-xs text-gray-500">{t("common.estimated")}</div>
      </KpiTile>
    </div>
  );
}
