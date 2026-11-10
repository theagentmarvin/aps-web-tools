/**
 * Rule suggestions (agent or coordinator, one flow): plain-language effect, stage chain
 * propuesta → aprobada (pendiente de publicar) → publicada, passkey publish / revert.
 * Shared by Reglas (pending block) and Historial (all).
 */
import { useState, type ReactNode } from "react";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { RuleSuggestion } from "~/lib/api/types";
import { copyText } from "~/lib/components/shell-widgets";
import { useToast } from "~/lib/components/Toast";
import { Button, EmptyState, ErrorState, SkeletonRows, cardCls } from "~/lib/components/ui";
import { useCoordAuth } from "~/lib/coord-auth";
import { passkeyMessage } from "~/lib/passkey-messages";
import { publishRuleWithPasskey } from "~/lib/webauthn";

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

export function Suggestions({ filter, emptyKey, version = 0 }: { filter?: (s: RuleSuggestion) => boolean; emptyKey?: TKey; version?: number } = {}) {
  const api = useApi();
  const { data: all, error, loading, reload, setData } = useAsync(() => api.listRuleSuggestions(), [api, version]);
  const data = filter ? all?.filter(filter) : all;
  const t = useT();
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading) return <SkeletonRows count={2} height="h-40" />;
  if (!data?.length) return <EmptyState title={t(emptyKey ?? "rules.noSuggestions")} />;
  const replace = (s: RuleSuggestion) => setData((prev) => (prev ?? []).map((x) => (x.id === s.id ? s : x)));
  return (
    <div className="space-y-4">
      {[...data].reverse().map((s) => (
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
export function SuggestionCard({ s, onChange }: { s: RuleSuggestion; onChange: (s: RuleSuggestion) => void }) {
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
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
            <span className={`rounded-full border px-2 leading-5 ${s.origin === "coordinador" ? "border-brand-muted/30 bg-white text-gray-700" : "border-violet-200 bg-violet-50 text-violet-800"}`}>{t(`rules.board.origin.${s.origin ?? "agente"}` as TKey)}</span>
            {s.changeKind && <span className="font-medium text-gray-600">{t(`rules.board.kind.${s.changeKind}` as TKey)}</span>}
            {s.origin !== "coordinador" && (s.feedbackCount || s.evidence) ? <span>· {s.evidence && !s.feedbackCount ? t("rules.evidenceOnlyHeader") : t("rules.suggestionHeader", { count: s.feedbackCount ?? s.count, reason: s.reasonCode, pair: s.pair })}</span> : null}
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
