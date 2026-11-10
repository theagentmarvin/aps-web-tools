/**
 * /reglas — rules (read-only), rule-change suggestions, corrections log,
 * calibration (spec §6.3). Query: tab.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { Calibration, CorrectionRow, RuleSuggestion, RuleSummary } from "~/lib/api/types";
import { ChartCard } from "~/lib/components/charts";
import { PageHeader } from "~/lib/components/PageHeader";
import { copyText } from "~/lib/components/shell-widgets";
import { useToast } from "~/lib/components/Toast";
import { Banner, Button, EmptyState, ErrorState, SkeletonRows, cardCls } from "~/lib/components/ui";
import { downloadBlob } from "~/lib/csv";
import { BRAND, SERIES_2 } from "~/lib/charts/theme";
import { FIELD_KEY } from "~/lib/labels";
import { useCoordAuth } from "~/lib/coord-auth";
import { passkeyMessage } from "~/lib/passkey-messages";
import { publishRuleWithPasskey } from "~/lib/webauthn";
import { FeedbackLog } from "~/features/rules/FeedbackLog";

const TABS = ["reglas", "sugerencias", "feedback", "correcciones", "calibracion"] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY: Record<Tab, TKey> = { reglas: "rules.tabs.rules", sugerencias: "rules.tabs.suggestions", feedback: "parity.feedback.tab", correcciones: "rules.tabs.corrections", calibracion: "rules.tabs.calibration" };

export function RulesPage() {
  const t = useT();
  const [sp, setSp] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(sp.get("tab") ?? "") ? (sp.get("tab") as Tab) : "reglas";
  return (
    <div>
      <PageHeader title={t("rules.title")} />
      <div role="tablist" className="mb-4 flex gap-1 border-b border-brand-muted/20">
        {TABS.map((tb) => (
          <button key={tb} type="button" role="tab" aria-selected={tab === tb} onClick={() => setSp({ tab: tb }, { replace: true })} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === tb ? "border-brand text-brand" : "border-transparent text-gray-600 hover:text-brand"}`}>
            {t(TAB_KEY[tb])}
          </button>
        ))}
      </div>
      {tab === "reglas" && <RulesTable />}
      {tab === "sugerencias" && <Suggestions />}
      {tab === "feedback" && <FeedbackLog />}
      {tab === "correcciones" && <Corrections />}
      {tab === "calibracion" && <CalibrationView />}
    </div>
  );
}

export const RULE_STATE_CLS = { active: "text-green-700", draft: "text-amber-800", disabled: "text-gray-500" } as const;

function RulesTable() {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const { data, error, loading, reload } = useAsync(() => api.listRules(), [api]);
  const [sortAsc, setSortAsc] = useState(true);
  const list = useMemo(() => [...(data ?? [])].sort((a, b) => ((a.acceptance ?? 2) - (b.acceptance ?? 2)) * (sortAsc ? 1 : -1)), [data, sortAsc]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading) return <SkeletonRows count={6} height="h-8" />;
  const effectKey = (e: RuleSummary["effect"]): TKey => (e === "grouping" ? "detail.field.group" : FIELD_KEY[e]);
  return (
    <>
      <Banner tone="info" className="mb-3 rounded">
        {t("rules.readOnlyNote")}
      </Banner>
      <div className={`${cardCls} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-brand-muted/20 text-left text-xs text-gray-500">
              <th className="px-3 py-2 font-medium">{t("rules.columns.id")}</th>
              <th className="px-3 py-2 font-medium">{t("rules.columns.name")}</th>
              <th className="px-3 py-2 font-medium">{t("rules.outcome")}</th>
              <th className="px-3 py-2 font-medium">{t("rules.columns.effect")}</th>
              <th className="px-3 py-2 font-medium">{t("rules.columns.state")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("rules.columns.hits")}</th>
              <th className="px-3 py-2 text-right font-medium">
                <button type="button" onClick={() => setSortAsc((v) => !v)} className="hover:text-brand" aria-sort={sortAsc ? "ascending" : "descending"}>
                  {t("rules.columns.acceptance")} {sortAsc ? "↑" : "↓"}
                </button>
              </th>
              <th className="px-3 py-2 text-right font-medium">{t("rules.columns.corrections")}</th>
              <th className="px-3 py-2 font-medium">{t("rules.columns.updated")}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className="border-b border-brand-muted/10 last:border-0 hover:bg-gray-50">
                <td className="px-3 py-2 font-mono text-xs">
                  <Link to={`/reglas/${r.id}`} className="text-brand hover:underline">
                    {r.id}
                  </Link>
                </td>
                <td className="px-3 py-2" title={r.nameEs && r.nameEs !== r.name ? r.name : undefined} lang="es">
                  {r.nameEs ?? r.name}
                </td>
                <td className="px-3 py-2 text-xs text-gray-600" title={r.scope}>
                  {r.outcomeEs ?? r.scope}
                </td>
                <td className="px-3 py-2 text-xs">{t(effectKey(r.effect))}</td>
                <td className={`px-3 py-2 text-xs ${RULE_STATE_CLS[r.state]}`}>{t(`rules.state.${r.state}`)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt.number(r.hits7d)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${r.acceptance !== null && r.acceptance < 0.7 ? "text-red-700" : ""}`}>{r.acceptance === null ? "—" : fmt.pct(r.acceptance)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.corrections}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{fmt.date(r.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function PatchView({ patch }: { patch: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded border border-brand-muted/20 bg-white font-mono text-xs">
      {patch.split("\n").map((l, i) => (
        <div key={i} className={`px-2 ${l.startsWith("+") && !l.startsWith("+++") ? "bg-green-50 text-green-800" : l.startsWith("-") && !l.startsWith("---") ? "bg-red-50 text-red-700" : "text-gray-600"}`}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

/** Before → after numbers measured on a real test, so a rule is never approved blind. */
function EvidenceTable({ evidence }: { evidence: NonNullable<RuleSuggestion["evidence"]> }) {
  const t = useT();
  const { fmt } = useI18n();
  const m = evidence.metrics;
  const validities = ["real", "false_positive", "tolerated", "needs_info"] as const;
  const vKey: Record<(typeof validities)[number], TKey> = { real: "validity.valid", false_positive: "validity.falsePositive", tolerated: "validity.tolerable", needs_info: "validity.needsInfo" };
  const arrow = (a: number, b: number) => (
    <>
      {fmt.number(a)} → <strong className={b < a ? "text-green-700" : b > a ? "text-amber-700" : ""}>{fmt.number(b)}</strong>
    </>
  );
  const rows: Array<[string, ReactNode]> = [
    [t("rules.evidence.changed"), `${fmt.number(m.changedUnique)} (${fmt.number(m.changedMc)} ACC)`],
    ...validities
      .filter((v) => (m.validityBefore[v] ?? 0) !== (m.validityAfter[v] ?? 0))
      .map((v) => [t(vKey[v]), arrow(m.validityBefore[v] ?? 0, m.validityAfter[v] ?? 0)] as [string, ReactNode]),
    [t("rules.evidence.groups"), arrow(m.groupsBefore, m.groupsAfter)],
    [t("rules.evidence.needsReview"), arrow(m.needsReviewBefore, m.needsReviewAfter)],
    [t("rules.evidence.unsafe"), <strong key="u" className={m.unsafeClosures ? "text-red-700" : "text-green-700"}>{fmt.number(m.unsafeClosures)}</strong>],
    [t("rules.evidence.scenarios"), `${m.scenariosPassed}/${m.scenariosTotal}`],
  ];
  return (
    <section aria-label={t("rules.evidence.title")} className="rounded border border-brand-muted/20 bg-brand-surface/40 p-3">
      <h3 className="mb-2 text-xs font-medium text-gray-600">{t("rules.evidence.title", { test: evidence.testKey })}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-gray-700">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-gray-500">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {evidence.summary && <p className="mt-2 whitespace-pre-line text-xs text-gray-600" lang="es">{evidence.summary}</p>}
    </section>
  );
}

const STAGE_CLS: Record<RuleSuggestion["state"], string> = {
  pending: "bg-gray-100 text-gray-700",
  approved: "bg-amber-100 text-amber-900",
  published: "bg-green-100 text-green-800",
  reverted: "bg-gray-100 text-gray-600",
  rejected: "bg-gray-100 text-gray-500",
};

function Suggestions() {
  const api = useApi();
  const { data, error, loading, reload, setData } = useAsync(() => api.listRuleSuggestions(), [api]);
  const t = useT();
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading) return <SkeletonRows count={2} height="h-40" />;
  if (!data?.length) return <EmptyState title={t("rules.noSuggestions")} />;
  const replace = (s: RuleSuggestion) => setData((prev) => (prev ?? []).map((x) => (x.id === s.id ? s : x)));
  return (
    <div className="space-y-4">
      {data.map((s) => (
        <SuggestionCard key={s.id} s={s} onChange={replace} />
      ))}
    </div>
  );
}

/**
 * One suggestion (G15): plain-language effect first, the stage chain
 * propuesta → aprobada (pendiente de publicar) → publicada, the human actions
 * of each stage, and the YAML / evaluation under "Ver detalle técnico".
 */
function SuggestionCard({ s, onChange }: { s: RuleSuggestion; onChange: (s: RuleSuggestion) => void }) {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const toast = useToast();
  const { status: authStatus } = useCoordAuth();
  const demo = api.mode === "mock" || authStatus?.dataSource !== "live";
  const [confirm, setConfirm] = useState<"publish" | "revert" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function decide(d: "approve" | "reject") {
    onChange(await api.decideRuleSuggestion(s.id, d));
    toast.show(d === "approve" ? t("rules.approved") : t("rules.rejected"));
  }
  async function run(op: "publish" | "revert") {
    setBusy(true);
    setErr(null);
    try {
      const res = demo ? await api.publishRuleSuggestion(s.id, op, { demo: true }) : await publishRuleWithPasskey(api, s.id, op);
      onChange(res);
      setConfirm(null);
      toast.show(op === "publish" ? t("rules.publishedToast") : t("rules.revertedToast"));
    } catch (e) {
      setErr(passkeyMessage(t, e));
    } finally {
      setBusy(false);
    }
  }
  const pub = s.publication;
  return (
    <article className={`${cardCls} space-y-3 p-4`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-gray-500">
            {s.evidence && !s.feedbackCount ? t("rules.evidenceOnlyHeader") : t("rules.suggestionHeader", { count: s.feedbackCount ?? s.count, reason: s.reasonCode, pair: s.pair })}
          </p>
          <h2 className="font-medium text-gray-900">{s.title}</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_CLS[s.state]}`}>{t(`rules.stage.${s.state}`)}</span>
          <span className="font-mono text-xs text-gray-400" title={fmt.dateTime(s.createdAt)}>
            {s.id}
          </span>
        </div>
      </header>
      {(s.effect?.length || s.impact) && (
        <section aria-label={t("rules.effectTitle")} className="rounded border border-brand-muted/20 bg-brand-surface/40 p-3 text-sm text-gray-800" lang="es">
          <h3 className="mb-1 text-xs font-medium text-gray-600">{t("rules.effectTitle")}</h3>
          {s.effect?.length ? (
            <ul className="list-disc space-y-0.5 pl-5">
              {s.effect.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
          {s.impact && (
            <p className="mt-1 font-medium">
              {s.impact.clashes
                ? t("rules.impact", { families: fmt.number(s.impact.families), groups: fmt.number(s.impact.groups), clashes: fmt.number(s.impact.clashes), version: s.impact.version })
                : t("rules.impactNone", { version: s.impact.version })}
            </p>
          )}
        </section>
      )}
      <p className="text-sm text-gray-700" lang="es">
        {s.summary}
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-brand hover:underline">{t("rules.technicalDetail")}</summary>
        <div className="mt-2 space-y-3">
          {s.evidence && <EvidenceTable evidence={s.evidence} />}
          <div>
            <h3 className="mb-1 text-xs text-gray-500">{t("rules.proposedChange")}</h3>
            <PatchView patch={s.patch} />
          </div>
          <p className="text-xs text-gray-600">
            {t("rules.affected", { count: s.affected })}
            {s.evaluation && ` · ${t("rules.evaluation", { from: fmt.number(s.evaluation.baselineMacroF1, 2), to: fmt.number(s.evaluation.candidateMacroF1, 2), unsafe: fmt.pct(s.evaluation.unsafeClosureRate) })}`}
          </p>
        </div>
      </details>
      {pub && (
        <p className="text-xs text-gray-600">
          {t("rules.publishedBy", { by: pub.by, at: fmt.dateTime(pub.at) })} · <span className="font-mono">{pub.files.join(", ")}</span>
          {pub.reverted && ` · ${t("rules.revertedBy", { by: pub.reverted.by, at: fmt.dateTime(pub.reverted.at) })}`}
        </p>
      )}
      {s.state === "approved" && <p className="text-xs text-amber-900">{t("rules.approvedNote")}</p>}
      {confirm && (
        <div role="alertdialog" aria-labelledby={`rc-${s.id}`} className="rounded border border-amber-300 bg-amber-50 p-2 text-xs">
          <p id={`rc-${s.id}`} className="font-medium text-amber-900">
            {t(confirm === "publish" ? "rules.confirmPublish" : "rules.confirmRevert", { title: s.title })}
          </p>
          {confirm === "publish" && <p className="mt-0.5 text-amber-900/80">{t("rules.publishHint")}</p>}
          {demo && <p className="mt-0.5 text-amber-900/80">{t("rules.demoProof")}</p>}
          <div className="mt-1.5 flex gap-1.5">
            <Button variant="primary" disabled={busy} onClick={() => void run(confirm)}>
              {busy ? t("rules.publishing") : t(confirm === "publish" ? "rules.publish" : "rules.revert")}
            </Button>
            <Button disabled={busy} onClick={() => setConfirm(null)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
      {err && (
        <p role="alert" className="text-xs text-red-700">
          {err}
        </p>
      )}
      <footer className="flex flex-wrap gap-2">
        {s.state === "pending" && (
          <>
            <Button variant="primary" onClick={() => void decide("approve")}>
              {t("rules.approveRule")}
            </Button>
            <Button onClick={() => void decide("reject")}>{t("rules.rejectRule")}</Button>
          </>
        )}
        {(s.state === "approved" || s.state === "reverted") && !confirm && (
          <Button variant="primary" onClick={() => setConfirm("publish")}>
            {s.state === "reverted" ? t("rules.publishAgain") : t("rules.publish")}
          </Button>
        )}
        {s.state === "published" && !confirm && <Button onClick={() => setConfirm("revert")}>{t("rules.revert")}</Button>}
        <Button
          onClick={async () => {
            const ok = await copyText(`Revisa y ajusta esta propuesta de regla (${s.id}): ${s.title}\n\n${s.patch}`);
            toast.show(ok ? t("common.copied") : t("common.unknownError"));
          }}
        >
          {t("rules.copyForClaude")}
        </Button>
      </footer>
    </article>
  );
}

function Corrections() {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const { data, error, loading, reload } = useAsync(() => api.listCorrections({ limit: 1000 }), [api]);
  const parentRef = useRef<HTMLDivElement>(null);
  const items = data?.items ?? [];
  const v = useVirtualizer({ count: items.length, getScrollElement: () => parentRef.current, estimateSize: () => 36, overscan: 10 });
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading) return <SkeletonRows count={6} height="h-8" />;
  function exportEval() {
    const jsonl = items.map((c: CorrectionRow) => JSON.stringify({ target: c.targetId, field: c.field, expected: c.humanValue, got: c.aiValue, reason: c.reasonCode, note: c.note ?? null, rules: c.ruleIds })).join("\n");
    downloadBlob("correcciones-eval.jsonl", new Blob([jsonl], { type: "application/x-ndjson" }));
  }
  const grid = "grid grid-cols-[110px_90px_90px_100px_1fr_1fr_60px_1fr_90px_60px] items-center gap-2 px-3";
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button onClick={exportEval}>{t("rules.exportEval")}</Button>
      </div>
      <div className={`${cardCls} text-xs`}>
        <div className={`${grid} border-b border-brand-muted/20 py-2 font-medium text-gray-500`}>
          <span>{t("audit.columns.date")}</span>
          <span>{t("audit.filters.user")}</span>
          <span>{t("audit.columns.object")}</span>
          <span>{t("rules.columns.effect")}</span>
          <span>{t("rules.aiValue")}</span>
          <span>{t("rules.humanValue")}</span>
          <span>{t("rules.reason")}</span>
          <span>{t("reasons.note")}</span>
          <span>{t("nav.rules")}</span>
          <span>{t("confidence.label")}</span>
        </div>
        <div ref={parentRef} className="max-h-[60vh] overflow-y-auto">
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((vi) => {
              const c = items[vi.index];
              return (
                <div key={vi.key} style={{ position: "absolute", top: 0, left: 0, right: 0, height: vi.size, transform: `translateY(${vi.start}px)` }} className={`${grid} border-b border-brand-muted/10`}>
                  <span className="text-gray-500">{fmt.dateTime(c.at)}</span>
                  <span className="truncate">{c.userName}</span>
                  <span className="truncate font-mono">{c.targetLabel}</span>
                  <span className="truncate">{c.field === "reject" ? t("actions.reject") : t(FIELD_KEY[c.field])}</span>
                  <span className="truncate text-gray-400 line-through">{c.aiValue}</span>
                  <span className="truncate font-medium">{c.humanValue}</span>
                  <span className="font-mono">{c.reasonCode ?? "—"}</span>
                  <span className="truncate" title={c.note}>
                    {c.note ?? ""}
                  </span>
                  <span className="truncate font-mono">{c.ruleIds.join(", ")}</span>
                  <span className="tabular-nums">{c.confidence !== undefined ? fmt.number(c.confidence, 2) : "—"}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function CalibrationView() {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const { data, error, loading, reload } = useAsync<Calibration>(() => api.getCalibration(), [api]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <SkeletonRows count={3} height="h-16" />;
  const bandLabel = (b: string) => t(b === "alta" ? "confidence.high" : b === "media" ? "confidence.medium" : "confidence.low");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard
        title={t("reports.chart.calibration")}
        filename="calibracion"
        labels={data.bands.map((b) => bandLabel(b.band))}
        series={[
          { label: t("rules.calibrationProposals"), data: data.bands.map((b) => b.proposals), color: SERIES_2 },
          { label: t("rules.calibrationAccepted"), data: data.bands.map((b) => b.acceptedUnchanged), color: BRAND },
        ]}
      />
      <section className={`${cardCls} p-4 text-sm`}>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1">{t("rules.columns.effect")}</th>
              <th>{t("source.label")}</th>
              <th>{t("rules.calibrationBand")}</th>
              <th className="text-right">{t("rules.calibrationProposals")}</th>
              <th className="text-right">{t("rules.calibrationAccepted")}</th>
            </tr>
          </thead>
          <tbody>
            {data.byField.flatMap((f) =>
              f.bands.map((b) => (
                <tr key={`${f.field}-${f.source}-${b.band}`} className="border-t border-brand-muted/10">
                  <td className="py-1">{t(FIELD_KEY[f.field])}</td>
                  <td>{f.source === "rule" ? t("source.ruleGeneric") : t("source.llm")}</td>
                  <td>{bandLabel(b.band)}</td>
                  <td className="text-right tabular-nums">{fmt.number(b.proposals)}</td>
                  <td className="text-right tabular-nums">{b.proposals < data.minDecisions ? "—" : fmt.pct(b.acceptedUnchanged / b.proposals)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-gray-600">{t("rules.spotCheckRate", { pct: fmt.pct(data.spotCheck.reviewed ? data.spotCheck.corrected / data.spotCheck.reviewed : 0) })}</p>
      </section>
    </div>
  );
}
