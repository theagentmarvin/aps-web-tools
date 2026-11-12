/**
 * Coordinator UI settings (Ajustes). Per-browser conveniences stored in
 * localStorage["coord.settings"]; project-level config (autonomy) is read-only.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { readJson, writeJson } from "./storage";

export interface Settings {
  autoAdvance: boolean;
  /** Confidence bands: Alta ≥ high, Media ≥ medium, else Baja. */
  thresholds: { high: number; medium: number };
  /** Seconds a risky target must be focused in a ready viewer before `a` accepts directly. */
  dwellGuardSec: number;
  autoAcceptInherited: boolean;
  /** Manual-review baseline in seconds per clash (time-saved KPI). */
  baselineSec: number;
  /** WCAG 2.1.4: allow turning off single-key shortcuts. */
  singleKeyShortcuts: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autoAdvance: true,
  thresholds: { high: 0.85, medium: 0.6 },
  dwellGuardSec: 1.5,
  autoAcceptInherited: false,
  baselineSec: 45,
  singleKeyShortcuts: true,
};

const KEY = "coord.settings";

interface SettingsValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(KEY, {}) }));
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      writeJson(KEY, next);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ settings, update }), [settings, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
