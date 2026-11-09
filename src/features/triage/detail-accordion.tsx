/** Collapsible detail-pane sections whose open state is remembered per user (localStorage), and the calibration tooltip text. */
import { useCallback, useState, type ReactNode } from "react";
import { useI18n, useT } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import { band } from "~/lib/api/decision-utils";
import type { Calibration } from "~/lib/api/types";
import { IconChevronDown } from "~/lib/components/icons";
import { readJson, writeJson } from "~/lib/storage";

// ── Persisted accordion state ──────────────────────────────────────

export type SectionId = "elements" | "clashes" | "reasoning" | "changes" | "properties" | "issue" | "history" | "instances" | "issuePreview" | "signature" | "families" | "verification";
const SECTIONS_KEY = "coord.detail.sections";

export function useSectionPrefs() {
  const [prefs, setPrefs] = useState<Partial<Record<SectionId, boolean>>>(() => readJson(SECTIONS_KEY, {}));
  const set = useCallback((id: SectionId, open: boolean) => {
    setPrefs((p) => {
      const next = { ...p, [id]: open };
      writeJson(SECTIONS_KEY, next);
      return next;
    });
  }, []);
  return { prefs, set };
}

export function Section({ id, title, open, onToggle, children }: { id: SectionId; title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="border-t border-brand-muted/20" aria-labelledby={`dsec-${id}-h`}>
      <h3 id={`dsec-${id}-h`} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`dsec-${id}`}
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-50"
        >
          <span className="truncate">{title}</span>
          <IconChevronDown size={14} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </h3>
      {open && (
        <div id={`dsec-${id}`} className="min-w-0 px-4 pb-3">
          {children}
        </div>
      )}
    </section>
  );
}

export function useCalibrationText() {
  const api = useApi();
  const t = useT();
  const { fmt } = useI18n();
  const { data } = useAsync<Calibration>(() => api.getCalibration(), [api]);
  return (c: number): string | undefined => {
    if (!data) return undefined;
    const b = data.bands.find((x) => x.band === band(c, data.thresholds));
    if (!b || b.proposals < data.minDecisions) return t("confidence.uncalibrated", { min: data.minDecisions });
    return t("confidence.calibrated", { count: b.proposals, pct: fmt.pct(b.acceptedUnchanged / b.proposals) });
  };
}
