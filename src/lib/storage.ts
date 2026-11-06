/**
 * Safe Web Storage helpers. Every access is wrapped in try/catch: storage can
 * throw (private mode, blocked site data) and the app must keep working.
 */
type Area = "local" | "session";

function area(which: Area): Storage | null {
  try {
    return which === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readString(key: string, which: Area = "local"): string | null {
  try {
    return area(which)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string | null, which: Area = "local"): void {
  try {
    const s = area(which);
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* storage unavailable: ignore */
  }
}

export function readJson<T>(key: string, fallback: T, which: Area = "local"): T {
  const raw = readString(key, which);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown, which: Area = "local"): void {
  writeString(key, value === undefined ? null : JSON.stringify(value), which);
}
