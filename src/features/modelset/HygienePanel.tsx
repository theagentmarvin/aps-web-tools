/**
 * "Higiene" tab of the model set page: the same deterministic hygiene stats
 * the agent reads with get_model_hygiene_stats (GET /tests/:testId/hygiene).
 * Read-only. Findings first (what to report to each model author), then the
 * per-document table, collapsed. Model names are third-party text: rendered as text.
 */
import { useState } from "react";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { HygieneCheck, TestHygiene } from "~/lib/api/types";
import { Banner, EmptyState, ErrorState, Skeleton, cardCls } from "~/lib/components/ui";

const CHECKS: HygieneCheck[] = [
  "duplicate_elements",
  "self_clashes_same_document",
  "missing_level",
  "missing_system",
  "generic_or_placeholder_types",
  "unassigned_discipline_documents",
  "insulation_hosted_clashes",
  "linked_model_misplacement",
  "category_mismatch_by_name",
];
export const checkKey = (c: HygieneCheck) => `parity.hygiene.check.${CHECKS.includes(c) ? c : "other"}` as TKey;

export function HygienePanel({ testKey, version }: { testKey?: string; version?: number }) {
  const t = useT();
  const api = useApi();
  const q = useAsync<TestHygiene | null>(() => (testKey ? api.getTestHygiene(testKey) : Promise.resolve(null)), [api, testKey]);
  if (!testKey) return <EmptyState title={t("parity.hygiene.needsAnalysis")} />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (q.loading || !q.data) return <Skeleton className="h-48" />;
  return <HygieneView data={q.data} version={version} />;
}

function HygieneView({ data, version }: { data: TestHygiene; version?: number }) {
  const t = useT();
  const { fmt } = useI18n();
  const [docsOpen, setDocsOpen] = useState(false);
  const byCheck = new Map<HygieneCheck, number>();
  for (const f of data.findings) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + f.count);
  const th = "px-3 py-2 font-medium";
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600">{t("parity.hygiene.intro", { version: version ?? "" })}</p>
      {!data.findings.length ? (
        <Banner tone="info" className="rounded">{t("parity.hygiene.clean")}</Banner>
      ) : (
        <>
          <ul className="flex flex-wrap gap-1.5" aria-label={t("parity.hygiene.summary")}>
            {[...byCheck.entries()].map(([c, n]) => (
              <li key={c} className="rounded-full border border-brand-muted/30 bg-white px-2 py-0.5 text-xs text-gray-700">
                {t(checkKey(c))} <span className="font-semibold tabular-nums">{fmt.number(n)}</span>
              </li>
            ))}
          </ul>
          <div className={`${cardCls} overflow-x-auto`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-brand-muted/20 text-left text-xs text-gray-500">
                  <th className={th}>{t("parity.hygiene.col.check")}</th>
                  <th className={th}>{t("parity.hygiene.col.doc")}</th>
                  <th className={`${th} text-right`}>{t("parity.hygiene.col.elements")}</th>
                  <th className={`${th} text-right`}>{t("parity.hygiene.col.clashes")}</th>
                  <th className={th}>{t("parity.hygiene.col.examples")}</th>
                </tr>
              </thead>
              <tbody>
                {data.findings.slice(0, 100).map((f, i) => (
                  <tr key={`${f.check}-${i}`} className="border-b border-brand-muted/10 last:border-0">
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs">{t(checkKey(f.check))}</td>
                    <td className="max-w-[22rem] truncate px-3 py-1.5 text-xs text-gray-700" title={f.doc}>{f.doc}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmt.number(f.count)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{f.clashesAffected ? fmt.number(f.clashesAffected) : "—"}</td>
                    <td className="max-w-[16rem] truncate px-3 py-1.5 font-mono text-[11px] text-gray-500" title={f.examples.join("\n")}>{f.examples.join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <details open={docsOpen} onToggle={(e) => setDocsOpen((e.target as HTMLDetailsElement).open)} className={`${cardCls} px-3 py-2`}>
        <summary className="cursor-pointer text-sm text-gray-700">{t("parity.hygiene.byDocument", { count: data.byDocument.length })}</summary>
        {docsOpen && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-brand-muted/20 text-left text-gray-500">
                  <th className="py-1 pr-3 font-medium">{t("parity.hygiene.col.doc")}</th>
                  <th className="py-1 pr-3 font-medium">{t("parity.hygiene.col.discipline")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t("parity.hygiene.col.inClashes")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t("parity.hygiene.check.self_clashes_same_document")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t("parity.hygiene.check.duplicate_elements")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t("parity.hygiene.check.missing_level")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t("parity.hygiene.check.missing_system")}</th>
                  <th className="py-1 text-right font-medium">{t("parity.hygiene.check.generic_or_placeholder_types")}</th>
                </tr>
              </thead>
              <tbody>
                {data.byDocument.map((d, i) => (
                  <tr key={i} className="border-b border-brand-muted/10 last:border-0">
                    <td className="max-w-[22rem] truncate py-1 pr-3" title={d.doc}>{d.doc}</td>
                    <td className="py-1 pr-3 font-mono">{d.discipline}</td>
                    {[d.elementsInClashes, d.selfClashes, d.duplicates, d.missingLevel, d.missingSystem, d.genericTypes].map((n, k) => (
                      <td key={k} className={`py-1 pr-3 text-right tabular-nums ${k > 0 && n > 0 ? "text-amber-800" : ""}`}>{fmt.number(n)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
      <p className="text-[11px] text-gray-500">{t("parity.hygiene.agentHint")}</p>
    </div>
  );
}
