/**
 * Origin badge (C1): the first thing read on a proposal is WHO proposed it and how accurate it has been.
 * «⚙ Regla EST-004 · acierto 92 % · n=24  +2 ▾» · «⚙ Sin regla (DEF-999) · revisión humana» ·
 * «✦ Agente IA · confianza 0,74» · «↺ Heredada de v41 · decidida por …» · «● Tu decisión · v2».
 * Numbers come from the server (`provenance`, same accuracy as Reglas); nothing is computed here.
 */
import { useId, useState } from "react";
import { Link } from "react-router";
import { useI18n, useT } from "~/i18n";
import type { Provenance, ProvenanceRule } from "~/lib/api/types";
import { ActorMark } from "./actors";

const MIN_N = 5;

export function pct(rate: number): number {
  return Math.round(rate * 100);
}

export function ruleBadgeText(t: ReturnType<typeof useT>, r: ProvenanceRule): { text: string; low: boolean } {
  if (r.fallback) return { text: t("loop.badge.fallback"), low: false };
  if (r.accuracy.rate === null) return { text: t("loop.badge.ruleNoData", { id: r.id, n: r.accuracy.n }), low: false };
  const low = r.accuracy.rate < 0.7;
  return { text: t(low ? "loop.badge.ruleLow" : "loop.badge.rule", { id: r.id, rate: pct(r.accuracy.rate), n: r.accuracy.n }), low };
}

export function ruleTip(t: ReturnType<typeof useT>, r: ProvenanceRule): string {
  if (r.fallback) return t("loop.badge.fallbackTip");
  const lines = [`${r.id} · ${r.nameEs}`];
  if (r.accuracy.rate === null) lines.push(t("loop.badge.noDataTip", { min: MIN_N }));
  else {
    lines.push(t("loop.badge.ruleTip", { n: r.accuracy.n, agree: r.accuracy.agree }));
    if (r.accuracy.rate < 0.7) lines.push(t("loop.badge.lowTip"));
  }
  if (r.accuracy.topCorrection) lines.push(t("loop.badge.ruleTipTop", { top: r.accuracy.topCorrection }));
  return lines.join("\n");
}

export function agentConfidence(t: ReturnType<typeof useT>, lang: string, a: NonNullable<Provenance["agent"]>): string {
  if (a.confidence !== null) return t("loop.badge.agent", { conf: a.confidence.toLocaleString(lang === "en" ? "en-US" : "es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) });
  if (a.confidenceBand) return t("loop.badge.agent", { conf: t(`loop.badge.band.${a.confidenceBand}` as Parameters<typeof t>[0]) });
  return t("loop.badge.agentNoConf");
}

/** The engine-rule chip (with the +N disclosure of the other rules of the family / ubicación). */
function RuleChips({ rules }: { rules: ProvenanceRule[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const top = rules[0];
  if (!top) return null;
  const { text, low } = ruleBadgeText(t, top);
  const rest = rules.slice(1);
  return (
    <>
      <ActorMark actor="engine" title={ruleTip(t, top)} dashed={low}>
        {top.fallback ? text : <Link to={`/reglas/${encodeURIComponent(top.id)}`} className="hover:underline">{text}</Link>}
      </ActorMark>
      {rest.length > 0 && (
        <button type="button" aria-expanded={open} aria-controls={listId} title={t("loop.badge.moreLabel")} onClick={() => setOpen(!open)} className="rounded px-1 text-[11px] text-gray-600 hover:bg-gray-100">
          {t("loop.badge.more", { count: rest.length })}
        </button>
      )}
      {open && rest.length > 0 && (
        <ul id={listId} aria-label={t("loop.badge.moreLabel")} className="basis-full space-y-0.5 pl-1 text-[11px] text-gray-600">
          {rules.map((r) => (
            <li key={r.id} title={ruleTip(t, r)}>
              <Link to={`/reglas/${encodeURIComponent(r.id)}`} className="font-mono hover:text-brand hover:underline">
                {t("loop.badge.ruleRow", { id: r.id, groups: r.groups, rate: r.accuracy.rate === null ? t("loop.badge.noData") : t("loop.badge.rate", { rate: pct(r.accuracy.rate) }) })}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The badge row. `decidedVersion`: the family decision version (human source). `showRuleWithAgent`:
 * also show the rule chip next to the agent badge (the «≠ regla» marks on each row carry the values).
 */
export function OriginBadge({ provenance, className = "" }: { provenance: Provenance | undefined; className?: string }) {
  const t = useT();
  const { lang } = useI18n();
  if (!provenance) return null;
  const p = provenance;
  let main: React.ReactNode = null;
  if (p.source === "agent" && p.agent) main = <ActorMark actor="agent" title={t("loop.badge.agentTip")}>{agentConfidence(t, lang, p.agent)}</ActorMark>;
  else if (p.source === "inherited" && p.inheritedFrom)
    main = (
      <ActorMark actor="human" glyph="↺" title={t("loop.badge.inheritedTip", { version: p.inheritedFrom.version })}>
        {p.inheritedFrom.decidedBy ? t("loop.badge.inherited", { version: p.inheritedFrom.version, who: p.inheritedFrom.decidedBy }) : t("loop.badge.inheritedNoWho", { version: p.inheritedFrom.version })}
      </ActorMark>
    );
  else if (p.source === "human" && p.human)
    main = <ActorMark actor="human" title={t("loop.badge.humanTip", { user: p.human.decidedBy })}>{p.human.version ? t("loop.badge.human", { version: p.human.version }) : t("loop.badge.humanNoVersion")}</ActorMark>;
  return (
    <div role="group" aria-label={t("loop.badge.sourceAria")} className={`flex min-w-0 flex-wrap items-center gap-1 ${className}`}>
      {main}
      <RuleChips rules={p.rules} />
    </div>
  );
}

/** «≠ regla: Conflicto» next to a row whose agent value differs from the rule (shape + word, not colour only). */
export function NeqMark({ value }: { value: string }) {
  const t = useT();
  return <span className="ml-1 whitespace-nowrap rounded border border-dashed border-actor-engine-bd bg-actor-engine-bg px-1 text-[11px] text-actor-engine">{t("loop.badge.neq", { value })}</span>;
}
