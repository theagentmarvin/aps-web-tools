/**
 * Consequences of a decision button (C3), shown as a popover on HOVER and keyboard FOCUS — never as an
 * always-visible block (product decision 2026-11-11: compact panel, details on hover/focus).
 * Three lines: Ahora · Después · Reglas. Each button's `aria-describedby` points to its own description
 * (kept in the DOM, hidden when not active) so screen readers read it on focus. Escape closes it.
 */
import { useId, useState, type ReactNode } from "react";
import { useT } from "~/i18n";

export interface Consequence {
  title: string;
  now: ReactNode;
  after: ReactNode;
  rules: ReactNode;
}

export function useConsequences<K extends string>() {
  const base = useId();
  const [active, setActive] = useState<K | null>(null);
  const idOf = (k: K) => `${base}-cons-${k}`;
  const bind = (k: K) => ({
    "aria-describedby": idOf(k),
    onMouseEnter: () => setActive(k),
    onMouseLeave: () => setActive((a) => (a === k ? null : a)),
    onFocus: () => setActive(k),
    onBlur: () => setActive((a) => (a === k ? null : a)),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
    },
  });
  return { active, idOf, bind };
}

/** The popover: render inside a `relative` container right after the buttons. */
export function ConsequencePopover<K extends string>({ items, active, idOf }: { items: Record<K, Consequence>; active: K | null; idOf: (k: K) => string }) {
  const t = useT();
  return (
    <>
      {(Object.keys(items) as K[]).map((k) => {
        const c = items[k];
        return (
          <div
            key={k}
            id={idOf(k)}
            role="tooltip"
            hidden={active !== k}
            className="absolute left-0 right-0 top-full z-30 mt-1 rounded-md border border-brand-muted/30 bg-white px-2.5 py-2 text-xs shadow-lg"
          >
            <p className="mb-0.5 text-[11px] text-gray-500">{c.title}</p>
            <dl className="space-y-0.5">
              {(
                [
                  ["now", c.now],
                  ["after", c.after],
                  ["rules", c.rules],
                ] as const
              ).map(([key, v]) => (
                <div key={key} className="grid grid-cols-[64px_minmax(0,1fr)] gap-1.5">
                  <dt className="pt-px text-[10px] font-semibold uppercase tracking-wide text-gray-500">{t(`loop.cons.${key}`)}</dt>
                  <dd className="min-w-0 text-gray-800">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-1 text-[10px] text-gray-500">{t("loop.cons.footer")}</p>
          </div>
        );
      })}
    </>
  );
}
