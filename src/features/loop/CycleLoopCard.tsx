/**
 * Cycle dashboard (C5) on the project page, under «Qué sigue»: «Ciclo vNN · cómo va el circuito».
 * Who proposed (motor / agente IA), what the coordinator decided, the batch, ACC, what the rules learned,
 * engine accuracy per version and the agent's accepted-unchanged rate (only here, to avoid over-trust
 * per proposal). Every number from GET /projects/:id/cycle-loop. Progress bar and sparkline carry text.
 */
import { Link } from "react-router";
import { useT } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { CycleLoop } from "~/lib/api/types";
import { cardCls } from "~/lib/components/ui";
import { ActorMark } from "./actors";
import { pct } from "./OriginBadge";

function Col({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-brand-muted/20 px-2.5 py-2">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
      <div className="space-y-0.5 text-sm">{children}</div>
    </div>
  );
}
const Num = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <p className="flex items-center gap-1.5">
    <b className="min-w-7 text-right text-base tabular-nums">{n}</b>
    {children}
  </p>
);

export function CycleLoopView({ data: c }: { data: CycleLoop }) {
  const t = useT();
  const d = c.decisions;
  const done = d.accepted + d.corrected;
  const w = (n: number) => (d.total ? `${(n / d.total) * 100}%` : "0%");
  const series = c.accuracyByVersion.filter((x) => x.rate !== null);
  const agentRate = c.agent.decided ? Math.round((c.agent.acceptedUnchanged / c.agent.decided) * 100) : 0;
  return (
    <section aria-labelledby="cycle-loop-title" className={`${cardCls} mb-4 p-4`}>
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <h2 id="cycle-loop-title" className="mr-auto text-base font-semibold text-gray-900">
          {t("loop.cycle.title", { version: c.version })}
        </h2>
        {c.batch && (
          <Link to={`/aprobaciones/${encodeURIComponent(c.batch.id)}`} className="text-sm text-brand hover:underline">
            {t("loop.cycle.seeBatch", { id: c.batch.id })}
          </Link>
        )}
      </div>
      <p className="mb-3 text-xs text-gray-600">{t("loop.cycle.lead")}</p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Col title={t("loop.cycle.proposals")}>
          <Num n={c.proposals.engine}>
            <ActorMark actor="engine">{t("loop.cycle.engine")}</ActorMark>
          </Num>
          <Num n={c.proposals.agent}>
            <ActorMark actor="agent">{t("loop.cycle.agent")}</ActorMark>
          </Num>
        </Col>
        <Col title={t("loop.cycle.decisions")}>
          <Num n={d.accepted}>{t("loop.cycle.accepted")}</Num>
          <Num n={d.corrected}>{t("loop.cycle.corrected")}</Num>
          <Num n={d.pending}>{t("loop.cycle.pending")}</Num>
          {d.oneByOne > 0 && <Num n={d.oneByOne}>{t("loop.cycle.oneByOne")}</Num>}
        </Col>
        <Col title={t("loop.cycle.batch")}>
          {c.batch ? (
            <>
              <Num n={c.batch.items}>{t("loop.cycle.inBatch", { id: c.batch.id })}</Num>
              <p className="text-xs text-gray-600">{c.batch.approved ? t("loop.cycle.approvedYes") : t("loop.cycle.approvedNo")}</p>
            </>
          ) : (
            <p className="text-xs text-gray-600">{t("loop.cycle.noBatch")}</p>
          )}
        </Col>
        <Col title={t("loop.cycle.acc")}>
          <Num n={c.acc.applied}>
            <ActorMark actor="acc">{t("loop.cycle.applied")}</ActorMark>
          </Num>
          <p className={`text-xs ${c.acc.failed ? "text-red-700" : "text-gray-600"}`}>{c.acc.failed ? `✕ ${t("loop.cycle.failed", { count: c.acc.failed })}` : t("loop.cycle.failed", { count: 0 })}</p>
        </Col>
      </div>
      <div className="mt-3 flex h-3.5 overflow-hidden rounded border border-brand-muted/20" role="img" aria-label={t("loop.cycle.progressAria", { done, total: d.total, accepted: d.accepted, corrected: d.corrected, pending: d.pending + d.oneByOne })}>
        <i className="block h-full bg-brand" style={{ width: w(d.accepted) }} />
        <i className="block h-full bg-brand-lighter" style={{ width: w(d.corrected), backgroundImage: "repeating-linear-gradient(45deg,transparent 0 4px,rgba(255,255,255,.6) 4px 6px)" }} />
        <i className="block h-full bg-gray-100" style={{ width: w(d.pending + d.oneByOne) }} />
      </div>
      <p className="mt-0.5 text-xs text-gray-600">
        {t("loop.cycle.progress", { done, total: d.total })} · <span className="text-brand">■</span> {d.accepted} {t("loop.cycle.accepted")} · ▨ {d.corrected} {t("loop.cycle.corrected")} · □ {d.pending + d.oneByOne} {t("loop.cycle.pending")}
      </p>
      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          <dt className="w-40 font-semibold text-gray-700">{t("loop.cycle.learning")}</dt>
          <dd className="flex flex-wrap items-center gap-1">
            <ActorMark actor="human">{t("loop.cycle.corrections", { count: c.learning.corrections })}</ActorMark>
            <span aria-hidden="true">→</span>
            <ActorMark actor="agent">{t("loop.cycle.suggestions", { count: c.learning.suggestions })}</ActorMark>
            <span aria-hidden="true">→</span>
            <ActorMark actor="engine">{t("loop.cycle.published", { count: c.learning.published })}</ActorMark>
          </dd>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <dt className="w-40 font-semibold text-gray-700">{t("loop.cycle.accuracy")}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {series.length ? (
              <>
                <span>{series.map((x) => t("loop.cycle.accuracyRow", { version: x.version, rate: t("loop.badge.rate", { rate: pct(x.rate!) }) })).join(" · ")}</span>
                <span aria-hidden="true" className="inline-flex h-5 items-end gap-0.5">
                  {series.map((x) => (
                    <i key={x.version} className="block w-2 rounded-t-sm bg-actor-engine" style={{ height: `${Math.max(3, x.rate! * 20)}px` }} />
                  ))}
                </span>
                <span className="text-xs text-gray-500">(n={series.reduce((n, x) => n + x.n, 0)})</span>
              </>
            ) : (
              <span className="text-gray-500">{t("loop.cycle.noAccuracy")}</span>
            )}
          </dd>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <dt className="w-40 font-semibold text-gray-700">{t("loop.cycle.agentAccuracy")}</dt>
          <dd>{c.agent.decided ? t("loop.cycle.agentRow", { unchanged: c.agent.acceptedUnchanged, decided: c.agent.decided, rate: agentRate }) : <span className="text-gray-500">{t("loop.cycle.agentNone")}</span>}</dd>
        </div>
      </dl>
    </section>
  );
}

export function CycleLoopCard({ projectId }: { projectId: string }) {
  const api = useApi();
  const q = useAsync(() => api.getCycleLoop(projectId), [api, projectId]);
  // Not analysed yet / failed: the card simply does not show (Qué sigue already says what to do).
  if (!q.data) return null;
  return <CycleLoopView data={q.data} />;
}
