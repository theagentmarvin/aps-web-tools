/**
 * Reglas › Feedback (docs/ai/agent-human-parity.md #62): corrections recorded
 * through the web UI and by the agent (record_feedback), with an origin column.
 * The rules curator (/curar-reglas) reads exactly these records. No user names
 * (rule 7): only the origin. The statement is free text: rendered as text.
 */
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { FeedbackRow, FeedbackSource, Validity } from "~/lib/api/types";
import { EmptyState, ErrorState, SkeletonRows, cardCls } from "~/lib/components/ui";
import { VALIDITY_KEY } from "~/lib/labels";

const SOURCES: FeedbackSource[] = ["ui", "agent", "decision"];
const SOURCE_CLS: Record<FeedbackSource, string> = {
  ui: "border-brand-muted/30 bg-white text-gray-700",
  agent: "border-violet-200 bg-violet-50 text-violet-800",
  decision: "border-brand-muted/30 bg-gray-50 text-gray-600",
};

export function FeedbackLog() {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const [source, setSource] = useState<FeedbackSource | "all">("all");
  const q = useAsync(() => api.listFeedback({ source: source === "all" ? undefined : [source], limit: 500 }), [api, source]);
  // «Respaldada por N correcciones · Ver» of a rule suggestion: only those records.
  const [sp, setSp] = useSearchParams();
  const only = new Set((sp.get("ids") ?? "").split(",").filter(Boolean));
  const rows = (q.data?.items ?? []).filter((r) => !only.size || only.has(r.feedbackId));
  const validity = (v?: string) => (v && v in VALIDITY_KEY ? t(VALIDITY_KEY[v as Validity]) : v || "—");
  const chip = (on: boolean) => `rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-brand-light/40 bg-brand/5 text-brand" : "border-brand-muted/30 text-gray-600 hover:text-brand"}`;
  const th = "px-3 py-2 font-medium";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-xs text-gray-600">
          {t("parity.feedback.intro")}
          {only.size > 0 && (
            <>
              {" "}
              <button type="button" className="text-brand hover:underline" onClick={() => { sp.delete("ids"); setSp(sp, { replace: true }); }}>
                {t("loop.rules.showAll", { count: only.size })}
              </button>
            </>
          )}
        </p>
        <div role="group" aria-label={t("parity.feedback.col.source")} className="flex gap-1">
          {(["all", ...SOURCES] as const).map((s) => (
            <button key={s} type="button" aria-pressed={source === s} className={chip(source === s)} onClick={() => setSource(s)}>
              {t(`parity.feedback.source.${s}` as TKey)}
            </button>
          ))}
        </div>
      </div>
      {q.error ? (
        <ErrorState error={q.error} onRetry={q.reload} />
      ) : q.loading ? (
        <SkeletonRows count={5} height="h-8" />
      ) : !q.data?.items.length ? (
        <EmptyState title={t("parity.feedback.empty")} />
      ) : (
        <div className={`${cardCls} max-h-[60vh] overflow-auto`}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-brand-muted/20 text-left text-gray-500">
                <th className={th}>{t("parity.feedback.col.date")}</th>
                <th className={th}>{t("parity.feedback.col.source")}</th>
                <th className={th}>{t("parity.feedback.col.target")}</th>
                <th className={th}>{t("parity.feedback.col.pair")}</th>
                <th className={th}>{t("parity.feedback.col.change")}</th>
                <th className={th}>{t("parity.feedback.col.statement")}</th>
                <th className={th}>{t("parity.feedback.col.scope")}</th>
                <th className={th}>{t("parity.feedback.col.curated")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: FeedbackRow) => (
                <tr key={r.feedbackId} className="border-b border-brand-muted/10 align-top last:border-0">
                  <td className="whitespace-nowrap px-3 py-1.5 text-gray-500">{fmt.dateTime(r.at)}</td>
                  <td className="px-3 py-1.5">
                    <span className={`whitespace-nowrap rounded-full border px-2 leading-5 ${SOURCE_CLS[r.source]}`}>{t(`parity.feedback.source.${r.source}` as TKey)}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono">{r.groupId ?? r.proposalId ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono">{r.disciplinePair ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    {r.correctedValidity && r.correctedValidity !== r.engineValidity ? (
                      <>
                        <span className="text-gray-400 line-through">{validity(r.engineValidity)}</span> → <span className="font-medium">{validity(r.correctedValidity)}</span>
                      </>
                    ) : (
                      t(`parity.feedback.verdict.${r.verdict}` as TKey)
                    )}
                  </td>
                  <td className="min-w-[16rem] break-words px-3 py-1.5 text-gray-800">{r.statement}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-gray-600" title={t(`parity.feedback.general.${r.generalizable}` as TKey)}>
                    {t(`parity.feedback.scope.${r.scope}` as TKey)}
                    {r.generalizable === "yes" ? " ★" : ""}
                  </td>
                  <td className="px-3 py-1.5">{r.curated ? t("parity.feedback.curatedYes") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.data.total > q.data.items.length && <p className="px-3 py-2 text-[11px] text-gray-500">{t("parity.feedback.more", { shown: q.data.items.length, total: q.data.total })}</p>}
        </div>
      )}
    </div>
  );
}
