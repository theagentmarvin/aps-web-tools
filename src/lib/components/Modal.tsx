/**
 * Accessible modal: focus trap, Esc to close, focus restored on close.
 * While any modal is open, list-scope hotkeys are suspended (see hotkeys.ts).
 */
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { pushModal, popModal } from "~/lib/hotkeys";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  /** Optional key handler on the dialog (digits, Enter…). */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  initialFocus?: React.RefObject<HTMLElement | null>;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, footer, width = "w-[420px]", onKeyDown, initialFocus }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    pushModal();
    const el = initialFocus?.current ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE) ?? ref.current;
    el?.focus();
    return () => {
      popModal();
      previous?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeRef.current();
      return;
    }
    if (e.key === "Tab" && ref.current) {
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    onKeyDown?.(e);
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={handleKey}
        className={`max-h-[90vh] max-w-full overflow-y-auto rounded-lg border border-brand-muted/20 bg-white shadow-xl ${width}`}
      >
        <h2 className="border-b border-brand-muted/20 px-4 py-3 text-sm font-semibold text-gray-900">{title}</h2>
        <div className="px-4 py-3 text-sm text-gray-800">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-brand-muted/20 px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
