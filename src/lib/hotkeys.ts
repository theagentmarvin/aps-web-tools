/**
 * Single hotkey registry (spec §3.4). Bindings are registered per scope; the
 * `?` overlay is generated from the registry so docs never drift from code.
 *
 * Key notation (from KeyboardEvent.key):
 *   "j", "J" (shift+j), "ArrowDown", "Enter", "Escape", "?", "/", "\\", "[", "]", "="
 *   "Space", "Shift+Space", "Ctrl+a", "Ctrl+z", "Ctrl+Shift+z", "Ctrl+Enter"
 *   chords: "g g", "g a" (second key within 800 ms)
 * Shortcuts are ignored while focus is in an editable element (WCAG 2.1.4),
 * except Escape, which blurs the field. They are suspended while a modal is open.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { TKey } from "~/i18n";

export type HotkeyGroup = "navigation" | "decisions" | "selection" | "viewer" | "global";

export interface HotkeyDef {
  keys: string[];
  labelKey: TKey;
  group: HotkeyGroup;
  /** Hide from the overlay (aliases). */
  hidden?: boolean;
}

export interface HotkeyBinding extends HotkeyDef {
  run: (e: KeyboardEvent) => void;
  /** Allow while a modal is open (default false). */
  inModal?: boolean;
}

// ── Modal stack ────────────────────────────────────────────────────

let modalDepth = 0;
export function pushModal() {
  modalDepth++;
}
export function popModal() {
  modalDepth = Math.max(0, modalDepth - 1);
}
export function isModalOpen() {
  return modalDepth > 0;
}

// ── Registry (for the overlay) ─────────────────────────────────────

const registry = new Map<string, HotkeyDef[]>();
const listeners = new Set<() => void>();
let snapshot: HotkeyDef[] = [];

function emit() {
  snapshot = [...registry.values()].flat().filter((d) => !d.hidden);
  for (const l of listeners) l();
}

export function useHotkeyDocs(): HotkeyDef[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
}

// ── Key normalisation ──────────────────────────────────────────────

export function comboOf(e: KeyboardEvent): string {
  const ctrl = e.ctrlKey || e.metaKey;
  let key = e.key === " " ? "Space" : e.key;
  const parts: string[] = [];
  if (ctrl) parts.push("Ctrl");
  // Shift is implicit in printable characters ("J", "?"), explicit otherwise.
  if (e.shiftKey && (ctrl || key.length > 1)) parts.push("Shift");
  if (ctrl && key.length === 1) key = key.toLowerCase();
  parts.push(key);
  return parts.join("+");
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range"].includes(type);
  }
  return false;
}

// ── Hook ───────────────────────────────────────────────────────────

interface Options {
  enabled?: boolean;
  /** When false, single-character shortcuts need Alt (WCAG 2.1.4 fallback). */
  singleKey?: boolean;
  onEscapeFromInput?: () => void;
}

export function useHotkeys(scope: string, bindings: HotkeyBinding[], opts: Options = {}) {
  const ref = useRef(bindings);
  ref.current = bindings;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const enabled = opts.enabled ?? true;

  // Register docs for the overlay (only key sets matter, so compare by JSON).
  const docsKey = JSON.stringify(bindings.map((b) => [b.keys, b.labelKey, b.group, b.hidden]));
  useEffect(() => {
    if (!enabled) return;
    registry.set(scope, ref.current.map(({ keys, labelKey, group, hidden }) => ({ keys, labelKey, group, hidden })));
    emit();
    return () => {
      registry.delete(scope);
      emit();
    };
  }, [scope, docsKey, enabled]);

  useEffect(() => {
    if (!enabled) return;
    let pendingPrefix: string | null = null;
    let pendingAt = 0;

    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      if (isEditable(e.target)) {
        if (e.key === "Escape") {
          (e.target as HTMLElement).blur();
          optsRef.current.onEscapeFromInput?.();
          e.preventDefault();
        }
        return;
      }
      let combo = comboOf(e);
      const single = optsRef.current.singleKey ?? true;
      if (e.altKey) {
        if (single) return;
        combo = combo.replace(/^Alt\+/, "");
      } else if (!single && combo.length === 1) {
        return;
      }
      const modal = isModalOpen();
      const list = ref.current.filter((b) => !modal || b.inModal);

      if (pendingPrefix && Date.now() - pendingAt < 800) {
        const chord = `${pendingPrefix} ${combo}`;
        pendingPrefix = null;
        const hit = list.find((b) => b.keys.includes(chord));
        if (hit) {
          e.preventDefault();
          hit.run(e);
          return;
        }
      }
      pendingPrefix = null;

      const hit = list.find((b) => b.keys.includes(combo));
      if (hit) {
        e.preventDefault();
        hit.run(e);
        return;
      }
      if (list.some((b) => b.keys.some((k) => k.startsWith(`${combo} `)))) {
        pendingPrefix = combo;
        pendingAt = Date.now();
        e.preventDefault();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** Human-readable key label for the overlay and tooltips. */
export function displayKey(k: string): string {
  return k
    .replace("ArrowDown", "↓")
    .replace("ArrowUp", "↑")
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace("Escape", "Esc")
    .replace("Space", "␣");
}
