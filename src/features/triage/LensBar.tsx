/**
 * Lens row above the tree (docs/PLAN-core-features-simplified.md §2):
 *   [ Qué cambió ] [ Incidencias ] [ Reunión ] [ Todo ]
 * A lens = saved filter + sort + which panel section opens first, in the URL
 * (?lente=). M1 builds "Todo" and "Qué cambió"; Incidencias (M3) and Reunión
 * (M4) are visible but disabled. Keyboard: Tab into the row, ←/→ move, Enter/Space select.
 */
import { useRef, type KeyboardEvent } from "react";
import { useI18n, useT } from "~/i18n";
import { useTriageContext } from "./actions";
import { LENSES, type LensId, type ListQuery } from "./filters";
import { useTriage } from "./store";

const ENABLED: Record<LensId, boolean> = { cambios: true, incidencias: true, reunion: false, todo: true };

export function LensBar({ query, onChange }: { query: ListQuery; onChange: (q: ListQuery) => void }) {
  const t = useT();
  const { fmt } = useI18n();
  const { store } = useTriageContext();
  const counts = useTriage(store, (s) => s.lensCounts);
  const hasPrevious = useTriage(store, () => store.hasPrevious());
  const active = useTriage(store, () => store.effectiveLens());
  const prevVersion = useTriage(store, () => store.baseVersion());
  const baseReason = useTriage(store, (s) => s.payload?.changeSummary?.baseReason);
  const questions = useTriage(store, (s) => s.openQuestionByGroup.size);
  const cs = useTriage(store, (s) => s.payload?.changeSummary?.clashes);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const issues = useTriage(store, (s) => s.issueChecks.size);
  const enabled = (l: LensId) => ENABLED[l] && (l !== "cambios" || hasPrevious) && (l !== "incidencias" || issues > 0);
  const select = (l: LensId) => enabled(l) && onChange({ ...query, lens: l });

  function onKey(e: KeyboardEvent, i: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    e.stopPropagation();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    for (let k = 1; k <= LENSES.length; k++) {
      const j = (i + dir * k + LENSES.length) % LENSES.length;
      if (enabled(LENSES[j])) {
        refs.current[j]?.focus();
        break;
      }
    }
  }

  return (
    <div role="tablist" aria-label={t("lens.label")} className="flex flex-shrink-0 items-center gap-1 border-b border-brand-muted/10 px-2 py-1">
      {LENSES.map((l, i) => {
        const on = active === l;
        const off = !enabled(l);
        const count = l === "cambios" ? counts.cambios : l === "todo" ? counts.todo : l === "incidencias" ? issues : null;
        const tip = !ENABLED[l] ? t("lens.soon") : l === "incidencias" ? (issues ? t("lens.incidenciasTip") : t("lens.noIssues")) : l === "cambios" ? (hasPrevious ? [t(baseReason === "last_reviewed" ? "lens.baseLastReviewed" : "lens.basePrevious", { version: prevVersion ?? "—" }), questions ? t("lens.questionsCount", { count: questions }) : "", cs ? t("lens.cambiosClashes", { new: cs.new, changed: cs.changed, reappeared: cs.reappeared }) : ""].filter(Boolean).join("\n") : t("lens.noPrevious")) : t("lens.todoTip");
        return (
          <button
            key={l}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            aria-disabled={off}
            tabIndex={on ? 0 : -1}
            title={tip}
            onClick={() => select(l)}
            onKeyDown={(e) => onKey(e, i)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${
              on ? "border-brand bg-brand text-white" : off ? "cursor-not-allowed border-gray-200 text-gray-300" : "border-brand-muted/30 text-gray-700 hover:border-brand hover:text-brand"
            }`}
          >
            {t(`lens.${l}`)}
            {count !== null && !off && <span className={`ml-1 ${on ? "text-white/80" : "text-gray-500"}`}>{fmt.number(count)}</span>}
          </button>
        );
      })}
    </div>
  );
}
