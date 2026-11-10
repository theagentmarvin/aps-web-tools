/**
 * Small popover menu (same look as the workspace "⋯" menu): a trigger button
 * and a role="menu" panel that closes on outside click and Esc.
 * `children` receives `close` so items can dismiss the menu.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

export const menuItemCls = "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-brand-surface disabled:cursor-not-allowed disabled:opacity-50";

export function MenuButton({
  label,
  title,
  className,
  panelClassName = "w-64",
  align = "right",
  children,
}: {
  label: ReactNode;
  /** Accessible name / tooltip (required when `label` is an icon). */
  title: string;
  className: string;
  panelClassName?: string;
  align?: "left" | "right";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={title} title={title} onClick={() => setOpen((o) => !o)} className={className}>
        {label}
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full z-40 mt-1 rounded-lg border border-brand-muted/20 bg-white py-1 shadow-lg ${panelClassName}`}
          onKeyDown={(e) => e.key === "Escape" && close()}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}
