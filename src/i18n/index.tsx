/**
 * Minimal home-made i18n (docs/ux/coordinator-ux-spec.md §8.1).
 *
 * - Nested dictionaries (es.json / en.json), dotted-key lookup.
 * - `{name}` interpolation; plurals via `_one` / `_other` suffixes resolved
 *   with Intl.PluralRules when params include `count`.
 * - Missing key in `en` falls back to `es`; missing in both renders the key and
 *   warns in dev.
 * - The language choice is stored in localStorage["coord.lang"] (default es).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import es from "./es.json";
import en from "./en.json";
import { readString, writeString } from "~/lib/storage";
import type { TKey } from "./keys";

export type { TKey } from "./keys";
export type Lang = "es" | "en";
export type TParams = Record<string, string | number | undefined>;
export type TFunction = (key: TKey, params?: TParams) => string;

type Dict = { [k: string]: string | Dict };
const DICTS: Record<Lang, Dict> = { es: es as Dict, en: en as Dict };
const LOCALES: Record<Lang, string> = { es: "es-CL", en: "en-US" };
const STORAGE_KEY = "coord.lang";

function lookup(dict: Dict, key: string): string | undefined {
  let cur: string | Dict | undefined = dict;
  for (const part of key.split(".")) {
    if (cur === undefined || typeof cur === "string") return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

function resolve(lang: Lang, key: string, params?: TParams): string | undefined {
  const count = params?.count;
  if (typeof count === "number") {
    const rule = new Intl.PluralRules(LOCALES[lang]).select(count);
    const plural = lookup(DICTS[lang], `${key}_${rule}`) ?? lookup(DICTS[lang], `${key}_other`);
    if (plural !== undefined) return plural;
  }
  return lookup(DICTS[lang], key);
}

export function translate(lang: Lang, key: string, params?: TParams): string {
  const template = resolve(lang, key, params) ?? (lang !== "es" ? resolve("es", key, params) : undefined);
  if (template === undefined) {
    if (import.meta.env.DEV) console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  if (!params) return template;
  const nf = new Intl.NumberFormat(LOCALES[lang]);
  return template.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name];
    if (v === undefined) return m;
    return typeof v === "number" ? nf.format(v) : v;
  });
}

// ── Formatting helpers ─────────────────────────────────────────────

export interface Formatters {
  locale: string;
  number(n: number, digits?: number): string;
  /** Distance in mm; negative = penetration, rendered with a true minus sign. */
  mm(n: number): string;
  pct(ratio: number): string;
  date(iso: string): string;
  dateTime(iso: string): string;
  time(iso: string): string;
  relative(iso: string): string;
}

const p2 = (n: number) => String(n).padStart(2, "0");

function makeFormatters(lang: Lang): Formatters {
  const locale = LOCALES[lang];
  const nf0 = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const pf = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const safe = (iso: string, f: (d: Date) => string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : f(d);
  };
  return {
    locale,
    number: (n, digits) =>
      digits === undefined
        ? nf0.format(n)
        : new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n),
    mm: (n) => `${n < 0 ? "−" : ""}${nf0.format(Math.abs(n))} mm`,
    pct: (r) => pf.format(r),
    // Fixed dd-mm-yyyy / dd-mm hh:mm (24 h), as in the spec mockups.
    date: (iso) => safe(iso, (d) => `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()}`),
    dateTime: (iso) => safe(iso, (d) => `${p2(d.getDate())}-${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`),
    time: (iso) => safe(iso, (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`),
    relative: (iso) =>
      safe(iso, (d) => {
        const sec = Math.round((d.getTime() - Date.now()) / 1000);
        const abs = Math.abs(sec);
        if (abs < 60) return rtf.format(sec, "second");
        if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
        if (abs < 86400) return rtf.format(Math.round(sec / 3600), "hour");
        return rtf.format(Math.round(sec / 86400), "day");
      }),
  };
}

// ── Context ────────────────────────────────────────────────────────

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TFunction;
  fmt: Formatters;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLang(): Lang {
  const stored = readString(STORAGE_KEY);
  return stored === "en" || stored === "es" ? stored : "es";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    writeString(STORAGE_KEY, l);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      setLang,
      t: (key, params) => translate(lang, key, params),
      fmt: makeFormatters(lang),
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

/** Translation function for the active language. */
export function useT(): TFunction {
  return useI18n().t;
}
