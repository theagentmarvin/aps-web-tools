import { useT, type TKey } from "~/i18n";
import { Spinner } from "~/lib/components/icons";
import type { IngestProgress } from "./useIngest";

/** Phase + bar + Spanish message from the server. */
export function IngestProgressBar({ p }: { p: IngestProgress }) {
  const t = useT();
  if (p.phase === "failed")
    return (
      <p role="alert" className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
        {t("ingest.failed", { error: p.error ?? p.message })}
      </p>
    );
  const pct = Math.round(Math.max(0, Math.min(1, p.progress)) * 100);
  return (
    <div className="space-y-1" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-gray-700">
        {p.phase !== "done" && <Spinner />}
        <span className="font-medium">{t(`ingest.phase.${p.phase}` as TKey)}</span>
        <span className="tabular-nums text-gray-500">{pct} %</span>
        <span className="truncate text-gray-500" lang="es">
          {p.message}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-orange-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="h-full rounded-full bg-orange-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
