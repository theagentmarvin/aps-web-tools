/**
 * Small shared UI primitives (states, banners, key hints, buttons).
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useT } from "~/i18n";
import { ApiError } from "~/lib/api";
import { IconAlert, IconInfo } from "./icons";

export const btnPrimary =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-light disabled:cursor-not-allowed disabled:opacity-50 transition-colors";
export const btnSecondary =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-brand-muted/30 bg-white px-3 py-1.5 text-sm text-gray-700 hover:border-brand-light/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-50 transition-colors";
export const btnDanger =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 transition-colors";
export const inputCls =
  "rounded border border-brand-muted/30 bg-white px-2 py-1 text-sm focus:border-brand-light focus:outline-none focus:ring-2 focus:ring-brand/30";
export const cardCls = "rounded-lg border border-brand-muted/20 bg-white";

export function Button({ variant = "secondary", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  const base = variant === "primary" ? btnPrimary : variant === "danger" ? btnDanger : btnSecondary;
  return <button type="button" className={`${base} ${className}`} {...rest} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-gray-300 px-1 font-mono text-[10px] leading-4 text-gray-500">{children}</kbd>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-brand-surface ${className}`} />;
}

export function SkeletonRows({ count = 12, height = "h-14" }: { count?: number; height?: string }) {
  return (
    <div className="space-y-2 p-3" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={height} />
      ))}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="p-8 text-center text-gray-500">
      <p className="font-medium text-gray-700">{title}</p>
      {body && <div className="mt-2 text-sm">{body}</div>}
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  let message = t("errors.load");
  if (error instanceof ApiError) {
    if (error.code === "network") message = t("errors.server");
    else if (error.code === "forbidden") message = t("errors.forbidden");
    else message = `${t("errors.load")} ${error.message}`;
  } else if (error instanceof Error) message = `${t("errors.load")} ${error.message}`;
  return (
    <div role="alert" className="m-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      <p className="flex items-center gap-2">
        <IconAlert />
        {message}
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-3 rounded border border-red-200 bg-white px-3 py-1 text-xs hover:bg-red-100">
          {t("common.retry")}
        </button>
      )}
    </div>
  );
}

const BANNER_TONES = {
  warning: "bg-amber-50 border-amber-200 text-amber-800",
  info: "bg-brand-surface border-brand-light/30 text-brand",
  error: "bg-red-50 border-red-200 text-red-700",
};

export function Banner({ tone = "info", children, actions, className = "" }: { tone?: keyof typeof BANNER_TONES; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex flex-wrap items-center gap-3 border px-4 py-2 text-sm ${BANNER_TONES[tone]} ${className}`}>
      {tone === "info" ? <IconInfo /> : <IconAlert />}
      <div className="min-w-0 flex-1">{children}</div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pb-2 pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{children}</h3>
      {right}
    </div>
  );
}

export function ProgressBar({ done, total, className = "" }: { done: number; total: number; className?: string }) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className={`h-1.5 overflow-hidden rounded-full bg-brand-surface ${className}`} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
    </div>
  );
}
