/**
 * Chips and badges for the triage UI (spec §3.3, §4.1–4.3, §7.2).
 * Color is never the only carrier: every badge has text or an aria-label.
 */
import { Link } from "react-router";
import { useI18n, useT } from "~/i18n";
import { band } from "~/lib/api/decision-utils";
import type { AccStatus, ConfidenceBandName, DecisionState, Delta, FieldSource, Nature, Priority, Severity, Validity } from "~/lib/api/types";
import { DECISION_KEY, DELTA_KEY, NATURE_KEY, PRIORITY_SHORT_KEY, SEVERITY_KEY, STATUS_KEY, VALIDITY_KEY, VALIDITY_TIP } from "~/lib/labels";
import { useSettings } from "~/lib/settings";
import { IconAlert, IconCheck, IconCircle, IconInherited, IconPause, IconPencil, IconX, SideASwatch, SideBSwatch } from "./icons";

const PRIORITY_CLS: Record<Priority, string> = {
  1: "bg-brand text-white",
  2: "bg-brand/10 text-brand border border-brand-light/30",
  3: "bg-amber-50 text-amber-800 border border-amber-200",
  4: "bg-gray-100 text-gray-600 border border-gray-200",
};

export function PriorityChip({ value, edited }: { value: Priority; edited?: boolean }) {
  const t = useT();
  return (
    <span className={`inline-flex items-center gap-0.5 rounded px-1.5 text-[10px] font-semibold leading-4 ${PRIORITY_CLS[value]}`}>
      {t(PRIORITY_SHORT_KEY[value])}
      {edited && <IconPencil size={9} label={t("list.edited")} />}
    </span>
  );
}

const BAND_CLS: Record<ConfidenceBandName, string> = {
  alta: "text-green-800 bg-green-50 border-green-200",
  media: "text-amber-800 bg-amber-50 border-amber-200",
  baja: "text-red-800 bg-red-50 border-red-200",
};
const BAND_DOTS: Record<ConfidenceBandName, string> = { alta: "●●●", media: "●●○", baja: "●○○" };
const BAND_KEY = { alta: "confidence.high", media: "confidence.medium", baja: "confidence.low" } as const;

export function useBand(value: number): ConfidenceBandName {
  const { settings } = useSettings();
  return band(value, settings.thresholds);
}

export function ConfidenceDots({ value }: { value: number }) {
  const t = useT();
  const { fmt } = useI18n();
  const b = useBand(value);
  const label = `${t("confidence.label")}: ${t(BAND_KEY[b])} (${fmt.number(value, 2)})`;
  return (
    <span title={label} aria-label={label} role="img" className={`font-mono text-[10px] leading-4 tracking-tighter ${b === "alta" ? "text-green-700" : b === "media" ? "text-amber-700" : "text-red-700"}`}>
      {BAND_DOTS[b]}
    </span>
  );
}

export function ConfidenceBadge({ value, calibration }: { value: number; calibration?: string }) {
  const t = useT();
  const { fmt } = useI18n();
  const b = useBand(value);
  const title = [t("confidence.value", { value: fmt.number(value, 2) }), calibration].filter(Boolean).join(" · ");
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 text-[10px] font-medium leading-4 ${BAND_CLS[b]}`}>
      <span aria-hidden className="font-mono tracking-tighter">{BAND_DOTS[b]}</span>
      {t(BAND_KEY[b])}
    </span>
  );
}

export function SourceBadge({ source, ruleIds = [], onRuleClick }: { source: FieldSource; ruleIds?: string[]; onRuleClick?: (id: string) => void }) {
  const t = useT();
  const ruleCls = "bg-gray-100 text-gray-700 border-gray-200 font-mono";
  const llmCls = "bg-brand/10 text-brand border-brand-light/30";
  const base = "inline-flex items-center rounded border px-1.5 text-[10px] leading-4 whitespace-nowrap";
  const rule = (id: string) =>
    onRuleClick ? (
      <button key={id} type="button" onClick={() => onRuleClick(id)} className={`${base} ${ruleCls} hover:border-gray-400`}>
        {t("source.rule", { id })}
      </button>
    ) : (
      <Link key={id} to={`/reglas/${id}`} className={`${base} ${ruleCls} hover:border-gray-400`}>
        {t("source.rule", { id })}
      </Link>
    );
  if (source === "manual") return <span className={`${base} border-gray-200 text-gray-600`}>{t("source.manual")}</span>;
  if (source === "llm") return <span className={`${base} ${llmCls}`}>{t("source.llm")}</span>;
  if (source === "rule+llm")
    return (
      <span className="inline-flex gap-0.5">
        {ruleIds.length ? rule(ruleIds[0]) : <span className={`${base} ${ruleCls}`}>{t("source.ruleGeneric")}</span>}
        <span className={`${base} ${llmCls}`}>+ {t("source.llm")}</span>
      </span>
    );
  return <span className="inline-flex flex-wrap gap-0.5">{ruleIds.length ? ruleIds.slice(0, 2).map(rule) : <span className={`${base} ${ruleCls}`}>{t("source.ruleGeneric")}</span>}</span>;
}

const DELTA_CLS: Record<Delta, string> = {
  new: "bg-slate-100 text-slate-700",
  reappeared: "bg-amber-100 text-amber-800",
  modified: "bg-sky-50 text-sky-800",
  persisting: "bg-gray-100 text-gray-600",
  resolved: "bg-green-50 text-green-800",
};

export function DeltaBadge({ delta }: { delta: Delta }) {
  const t = useT();
  if (delta === "persisting") return null;
  return <span className={`rounded px-1.5 text-[10px] font-medium uppercase leading-4 tracking-wide ${DELTA_CLS[delta]}`}>{t(DELTA_KEY[delta])}</span>;
}

const VALIDITY_CLS: Record<Validity, string> = {
  real: "text-brand font-medium",
  false_positive: "text-gray-500",
  tolerated: "text-gray-600",
  needs_info: "text-amber-800",
};

export function ValidityBadge({ value }: { value: Validity }) {
  const t = useT();
  return (
    <span title={t(VALIDITY_TIP[value])} className={`inline-flex items-center gap-1 ${VALIDITY_CLS[value]}`}>
      {value === "needs_info" && <IconAlert size={12} />}
      {t(VALIDITY_KEY[value])}
    </span>
  );
}

const STATUS_CLS: Record<AccStatus, string> = {
  active: "text-yellow-700 bg-yellow-50 border-yellow-200",
  reviewed: "text-brand bg-brand/10 border-brand-light/30",
  resolved: "text-green-700 bg-green-50 border-green-200",
  closed: "text-gray-500 bg-gray-100 border-gray-200",
};

export function StatusBadge({ status }: { status: AccStatus }) {
  const t = useT();
  return <span className={`whitespace-nowrap rounded border px-1.5 text-[10px] uppercase leading-4 ${STATUS_CLS[status]}`}>{t(STATUS_KEY[status])}</span>;
}

export function DisciplinePairChip({ a, b }: { a: string; b: string }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-gray-700" aria-label={`${t("a11y.sideA")} ${a} × ${t("a11y.sideB")} ${b}`}>
      <SideASwatch />
      <span className="text-clash-a-ink">{a}</span>
      <span aria-hidden className="text-gray-400">×</span>
      <SideBSwatch />
      <span className="text-clash-b-ink">{b}</span>
    </span>
  );
}

export function DecisionStateIcon({ state, title }: { state: DecisionState; title?: string }) {
  const t = useT();
  const label = title ?? t(DECISION_KEY[state]);
  const cls = "shrink-0";
  switch (state) {
    case "accepted":
      return <IconCheck label={label} className={`${cls} text-green-700`} />;
    case "corrected":
      return <IconPencil label={label} className={`${cls} text-amber-700`} />;
    case "rejected":
      return <IconX label={label} className={`${cls} text-red-700`} />;
    case "postponed":
      return <IconPause label={label} className={`${cls} text-gray-500`} />;
    case "inherited":
      return <IconInherited label={label} className={`${cls} text-gray-500`} />;
    default:
      return <IconCircle label={label} className={`${cls} text-gray-400`} />;
  }
}

export function SpotCheckChip() {
  const t = useT();
  return (
    <span title={t("guard.spotCheckTooltip")} className="rounded border border-violet-200 bg-violet-50 px-1.5 text-[10px] leading-4 text-violet-800">
      {t("guard.spotCheck")}
    </span>
  );
}

export function ReasonChip({ code }: { code: string }) {
  return <span className="rounded border border-amber-200 bg-amber-50 px-1 font-mono text-[10px] leading-4 text-amber-800">{code}</span>;
}

export function NatureBadge({ value }: { value: Nature }) {
  const t = useT();
  if (value === "hard") return null;
  return <span className="rounded border border-slate-200 bg-slate-50 px-1.5 text-[10px] leading-4 text-slate-700">{t(NATURE_KEY[value])}</span>;
}

export function SeverityLabel({ value }: { value: Severity }) {
  const t = useT();
  return <span className={value === "critical" ? "font-medium text-brand" : value === "none" ? "text-gray-500" : ""}>{t(SEVERITY_KEY[value])}</span>;
}

/** Untrusted-text marker for flagged agent content (spec §4.2, server sanitize). */
export function FlaggedChip() {
  const t = useT();
  return (
    <span title={t("detail.flagged")} className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-1.5 text-[10px] leading-4 text-red-800">
      <IconAlert size={10} />
      {t("detail.flaggedShort")}
    </span>
  );
}
