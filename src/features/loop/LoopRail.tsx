/**
 * Loop rail (C2): Propuesta → Tu decisión → Lote → ACC for one family (grupo) or ubicación, with the
 * state of each step by SHAPE (● hecho · ◉ actual · ○ pendiente · ✕ falló) + a next-step line, and the
 * learning track (corrections of its rule → suggestion → published). Server data only.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useT, type TKey } from "~/i18n";
import { useApi } from "~/lib/api";
import type { CoordinatorApi } from "~/lib/api";
import type { LoopBatchRef, Provenance, RuleSuggestion } from "~/lib/api/types";
import { ACTOR_CLASS, ACTOR_GLYPH, ActorMark, type Actor } from "./actors";

export type StepState = "done" | "current" | "pending" | "failed";
export interface RailModel {
  steps: [StepState, StepState, StepState, StepState];
  line: string;
  batchId?: string;
}

const STEP_SHAPE: Record<StepState, string> = { done: "●", current: "◉", pending: "○", failed: "✕" };
const STEP_ACTOR: Actor[] = ["engine", "human", "human", "acc"];
const STEP_KEY: TKey[] = ["loop.rail.step.proposal", "loop.rail.step.decision", "loop.rail.step.batch", "loop.rail.step.acc"];

/** Batch → ACC steps and line (shared by families and ubicaciones). */
function batchSteps(t: ReturnType<typeof useT>, batch: LoopBatchRef | undefined, pendingSend: number): Pick<RailModel, "line" | "batchId"> & { s3: StepState; s4: StepState } {
  if (!batch) return pendingSend > 0 ? { s3: "current", s4: "pending", line: t("loop.rail.toSend") } : { s3: "pending", s4: "pending", line: t("loop.rail.nothingToSend") };
  if (batch.failed > 0) return { s3: "done", s4: "failed", line: batch.message ? t("loop.rail.failed", { message: batch.message }) : t("loop.rail.failedNoMsg"), batchId: batch.id };
  if (batch.state === "applied" || batch.state === "partial" || batch.applied > 0)
    return {
      s3: "done",
      s4: batch.applied >= batch.items ? "done" : "current",
      line: batch.accIssueIds?.length ? t("loop.rail.appliedIssue", { issues: batch.accIssueIds.slice(0, 3).join(", "), applied: batch.applied, items: batch.items }) : t("loop.rail.applied", { applied: batch.applied, items: batch.items }),
      batchId: batch.id,
    };
  if (batch.state === "approved") return { s3: "done", s4: "current", line: t("loop.rail.approved", { id: batch.id }), batchId: batch.id };
  return { s3: "current", s4: "pending", line: t("loop.rail.inBatch", { id: batch.id }), batchId: batch.id };
}

export function familyRail(
  t: ReturnType<typeof useT>,
  f: { decision?: { status: string }; batch?: LoopBatchRef; pendingSend?: number },
  oneByOne: { done: number; total: number },
): RailModel {
  if (!f.decision) return { steps: ["done", "current", "pending", "pending"], line: t("loop.rail.undecided") };
  if (f.decision.status === "rejected") return { steps: ["done", "failed", "pending", "pending"], line: t("loop.rail.oneByOne", oneByOne) };
  const b = batchSteps(t, f.batch, f.pendingSend ?? 0);
  return { steps: ["done", "done", b.s3, b.s4], line: b.line, ...(b.batchId ? { batchId: b.batchId } : {}) };
}

export function groupRail(t: ReturnType<typeof useT>, g: { batch?: LoopBatchRef }, decided: boolean, sendable: boolean): RailModel {
  if (!decided) return { steps: ["done", "current", "pending", "pending"], line: t("loop.rail.undecidedGroup") };
  const b = batchSteps(t, g.batch, sendable ? 1 : 0);
  return { steps: ["done", "done", b.s3, b.s4], line: b.line, ...(b.batchId ? { batchId: b.batchId } : {}) };
}

// ── rule suggestions (learning track), fetched once per page load ───────────

let suggestionsCache: { api: CoordinatorApi; at: number; data: Promise<RuleSuggestion[]> } | null = null;
export function useRuleSuggestions(): RuleSuggestion[] | null {
  const api = useApi();
  const [data, setData] = useState<RuleSuggestion[] | null>(null);
  useEffect(() => {
    if (!suggestionsCache || suggestionsCache.api !== api || Date.now() - suggestionsCache.at > 60_000) suggestionsCache = { api, at: Date.now(), data: api.listRuleSuggestions().catch(() => []) };
    let live = true;
    void suggestionsCache.data.then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [api]);
  return data;
}

function LearningTrack({ provenance }: { provenance: Provenance | undefined }) {
  const t = useT();
  const suggestions = useRuleSuggestions();
  const rule = provenance?.rules.find((r) => !r.fallback);
  if (!rule) return null;
  const corrections = rule.accuracy.n - rule.accuracy.agree;
  const s = suggestions?.filter((x) => x.ruleIds?.includes(rule.id) && x.state !== "rejected").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  return (
    <Link to={`/reglas/${encodeURIComponent(rule.id)}`} title={t("loop.rail.learnTip", { id: rule.id })} className="mt-1 flex min-w-0 flex-wrap items-center gap-1 border-t border-dashed border-brand-muted/20 pt-1 text-[11px] text-gray-600 hover:text-brand">
      <span className="font-semibold">{t("loop.rail.learn")}</span>
      <span className="font-mono">{rule.id}</span>
      <ActorMark actor="human">{corrections > 0 ? t("loop.rail.corrections", { count: corrections }) : t("loop.rail.noCorrections")}</ActorMark>
      <span aria-hidden="true">→</span>
      <ActorMark actor="agent">{s ? t("loop.rail.suggestion", { state: t(`rules.stage.${s.state}` as TKey) }) : t("loop.rail.noSuggestion")}</ActorMark>
      <span aria-hidden="true">→</span>
      <ActorMark actor="engine">{s?.state === "published" ? t("loop.rail.published") : t("loop.rail.none")}</ActorMark>
    </Link>
  );
}

export function LoopRail({ model, provenance }: { model: RailModel; provenance?: Provenance }) {
  const t = useT();
  const label = model.steps.map((s, i) => `${t(STEP_KEY[i]!)}: ${t(`loop.rail.state.${s}` as TKey)}`).join(" · ");
  return (
    <div className="mt-2 rounded-md border border-brand-muted/20 bg-white px-2 py-1.5" role="group" aria-label={t("loop.rail.aria")}>
      <p className="sr-only">{label}</p>
      <ol aria-hidden="true" className="flex min-w-0 items-center text-[11px]">
        {model.steps.map((s, i) => {
          const actor = STEP_ACTOR[i]!;
          const tone = s === "pending" ? "text-gray-400" : s === "failed" ? "text-red-700" : ACTOR_CLASS[actor].split(" ")[0];
          return (
            <li key={i} className={`flex min-w-0 items-center ${i < 3 ? "flex-1" : ""}`}>
              <span className={`inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap ${tone} ${s === "current" ? "font-semibold" : ""}`}>
                <span className="text-[10px]">{i === 2 ? "■" : ACTOR_GLYPH[actor]}</span>
                <span>{STEP_SHAPE[s]}</span>
                <span>{t(STEP_KEY[i]!)}</span>
              </span>
              {i < 3 && <span className={`mx-1 h-px min-w-2 flex-1 ${model.steps[i + 1] !== "pending" ? "bg-gray-500" : "bg-gray-300"}`} />}
            </li>
          );
        })}
      </ol>
      <p className="mt-0.5 text-[11px] text-gray-700">
        {model.line}
        {model.batchId && (
          <>
            {" "}
            <Link to={`/aprobaciones/${encodeURIComponent(model.batchId)}`} className="text-brand hover:underline">
              {t("loop.rail.openBatch")}
            </Link>
          </>
        )}
      </p>
      <LearningTrack provenance={provenance} />
    </div>
  );
}
