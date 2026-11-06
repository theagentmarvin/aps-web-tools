/**
 * /ajustes — language, autonomy level (read-only L1), workspace preferences,
 * developer tools link (spec §2.1).
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useT } from "~/i18n";
import { useApi } from "~/lib/api";
import { PageHeader } from "~/lib/components/PageHeader";
import { LanguageSwitch } from "~/lib/components/shell-widgets";
import { cardCls, inputCls } from "~/lib/components/ui";
import { useSettings } from "~/lib/settings";

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-t border-brand-muted/10 py-3 first:border-t-0">
      <div>
        <div className="text-sm text-gray-800">{label}</div>
        {hint && <div className="text-xs text-gray-500">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const t = useT();
  const api = useApi();
  const { settings, update } = useSettings();
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : fallback);

  return (
    <div className="max-w-3xl">
      <PageHeader title={t("settings.title")} />
      <section className={`${cardCls} mb-4 px-4`}>
        <Row label={t("settings.language")}>
          <LanguageSwitch />
        </Row>
        <Row label={t("settings.autonomy")} hint={t("settings.autonomyReadOnly")}>
          <span className="rounded border border-brand-light/30 bg-brand/10 px-2 py-1 text-sm text-brand">{t("settings.autonomyValue")}</span>
        </Row>
        <Row label={t("settings.apiMode", { mode: api.mode })} hint={api.mode === "mock" ? t("app.demoModeHint") : undefined}>
          <span className="font-mono text-xs text-gray-500">VITE_COORD_API</span>
        </Row>
      </section>

      <section className={`${cardCls} mb-4 px-4`} aria-labelledby="h-ws">
        <h2 id="h-ws" className="pt-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          {t("settings.workspace")}
        </h2>
        <Row label={t("settings.autoAdvance")}>
          <input type="checkbox" className="h-4 w-4 accent-brand" checked={settings.autoAdvance} onChange={(e) => update({ autoAdvance: e.target.checked })} />
        </Row>
        <Row label={t("settings.singleKey")}>
          <input type="checkbox" className="h-4 w-4 accent-brand" checked={settings.singleKeyShortcuts} onChange={(e) => update({ singleKeyShortcuts: e.target.checked })} />
        </Row>
        <Row label={t("settings.confidenceBands")}>
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              {t("settings.highFrom")}
              <input type="number" step="0.01" min="0" max="1" className={`${inputCls} w-20`} value={settings.thresholds.high} onChange={(e) => update({ thresholds: { ...settings.thresholds, high: num(e.target.value, settings.thresholds.high) } })} />
            </label>
            <label className="flex items-center gap-1">
              {t("settings.mediumFrom")}
              <input type="number" step="0.01" min="0" max="1" className={`${inputCls} w-20`} value={settings.thresholds.medium} onChange={(e) => update({ thresholds: { ...settings.thresholds, medium: num(e.target.value, settings.thresholds.medium) } })} />
            </label>
          </div>
        </Row>
        <Row label={t("settings.dwellGuard")}>
          <input type="number" step="0.5" min="0" className={`${inputCls} w-20`} value={settings.dwellGuardSec} onChange={(e) => update({ dwellGuardSec: num(e.target.value, settings.dwellGuardSec) })} />
        </Row>
        <Row label={t("settings.autoAcceptInherited")}>
          <input type="checkbox" className="h-4 w-4 accent-brand" checked={settings.autoAcceptInherited} onChange={(e) => update({ autoAcceptInherited: e.target.checked })} />
        </Row>
        <Row label={t("settings.baseline")}>
          <input type="number" step="5" min="0" className={`${inputCls} w-20`} value={settings.baselineSec} onChange={(e) => update({ baselineSec: num(e.target.value, settings.baselineSec) })} />
        </Row>
      </section>

      <section className={`${cardCls} mb-4 p-4`} aria-labelledby="h-legend">
        <h2 id="h-legend" className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          {t("settings.sourceLegend")}
        </h2>
        <p className="text-sm text-gray-700">{t("source.legend")}</p>
      </section>

      <section className={`${cardCls} p-4`} aria-labelledby="h-dev">
        <h2 id="h-dev" className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          {t("settings.devTools")}
        </h2>
        <Link to="/data-management" className="text-sm text-brand hover:underline">
          {t("settings.dataManagement")}
        </Link>
      </section>
    </div>
  );
}
