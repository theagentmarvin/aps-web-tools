/**
 * Toasts (spec §7.2): bottom-center, auto-dismiss, optional action.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

interface ToastItem {
  id: number;
  message: string;
  action?: { label: string; onClick: () => void };
  tone?: "default" | "error";
}

interface ToastApi {
  show: (message: string, opts?: { action?: ToastItem["action"]; tone?: ToastItem["tone"]; durationMs?: number }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const show = useCallback<ToastApi["show"]>((message, opts) => {
    const id = ++seq.current;
    setItems((prev) => [...prev.slice(-2), { id, message, action: opts?.action, tone: opts?.tone }]);
    window.setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), opts?.durationMs ?? 4000);
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-12 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex items-center gap-3 rounded-lg px-4 py-2 text-sm text-white shadow-lg ${t.tone === "error" ? "bg-red-700" : "bg-gray-900"}`}
          >
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="font-medium text-brand-surface underline underline-offset-2 hover:text-white"
                onClick={() => {
                  t.action?.onClick();
                  setItems((prev) => prev.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
