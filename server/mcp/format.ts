/**
 * Response shaping for MCP tools: one compact JSON envelope per call, capped
 * at ~maxResponseTokens (≈4 chars/token). When over the cap the largest array
 * (table rows first) is cut and `truncated` + `hint` are set.
 */
import { CoordError } from "../util";
import type { Envelope } from "./contracts";

export const CHARS_PER_TOKEN = 4;

export function okEnvelope<T>(data: T, extra: Partial<Envelope<T>> = {}): Envelope<T> {
  return { ok: true, data, ...extra };
}

const HINTS: Record<string, string> = {
  not_ingested: "Llama a ingest_clash_test (o set_active_context con un testKey en caché).",
  not_classified: "Llama a run_classification.",
  not_authenticated: "Pide al coordinador iniciar sesión: `npm run coordinator -- login` o la UI web.",
  autonomy_level_forbids: "El nivel de autonomía no lo permite; informa al coordinador.",
  approval_missing: "Un humano debe aprobar el lote en la UI web (/aprobaciones) o con la CLI interactiva.",
  approval_invalid: "La aprobación no es válida; pide al coordinador revisar y aprobar de nuevo.",
  validation_error: "Corrige los argumentos indicados.",
  rate_limited: "Espera y reintenta más tarde.",
};

export function errorEnvelope(err: unknown): Envelope<never> {
  if (err instanceof CoordError) {
    return { ok: false, error: { code: err.code, message: err.message, retryable: err.retryable }, ...(err.hint || HINTS[err.code] ? { hint: err.hint ?? HINTS[err.code] } : {}) };
  }
  const e = err as { code?: string; status?: number; message?: string; name?: string };
  if (e?.name === "ApsError") {
    const code = e.code === "auth_required" || e.status === 401 ? "not_authenticated" : e.status === 429 ? "rate_limited" : e.status === 403 ? "forbidden" : e.status === 404 ? "not_found" : "aps_error";
    return { ok: false, error: { code, message: String(e.message ?? "Error APS"), retryable: code === "rate_limited" || (e.status ?? 0) >= 500 }, ...(HINTS[code] ? { hint: HINTS[code] } : {}) };
  }
  if (e?.name === "ZodError") return { ok: false, error: { code: "validation_error", message: String(e.message).slice(0, 800), retryable: false }, hint: HINTS.validation_error };
  return { ok: false, error: { code: "internal", message: String(e?.message ?? err).slice(0, 500), retryable: false } };
}

/** Path to the largest array inside `data` (rows preferred). */
function largestArray(obj: unknown, path: (string | number)[] = []): { path: (string | number)[]; len: number } | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  let best: { path: (string | number)[]; len: number } | undefined;
  if (Array.isArray(obj)) {
    if (obj.length > 1) best = { path, len: JSON.stringify(obj).length };
    return best;
  }
  for (const [k, v] of Object.entries(obj)) {
    const cand = Array.isArray(v) && v.length > 1 ? { path: [...path, k], len: JSON.stringify(v).length } : largestArray(v, [...path, k]);
    if (cand && (!best || cand.len > best.len)) best = cand;
  }
  return best;
}

function getAt(obj: unknown, path: (string | number)[]): unknown {
  return path.reduce<unknown>((o, k) => (o as Record<string | number, unknown>)?.[k], obj);
}

/** Serialise compactly and enforce the cap. */
export function capResponse(env: Envelope<unknown>, maxTokens: number): string {
  const max = maxTokens * CHARS_PER_TOKEN;
  let text = JSON.stringify(env);
  if (text.length <= max) return text;
  const copy = JSON.parse(text) as Envelope<unknown>;
  for (let i = 0; i < 40 && text.length > max; i++) {
    const target = largestArray(copy.data);
    if (!target) break;
    const arr = getAt(copy.data, target.path) as unknown[];
    const keep = Math.max(1, Math.floor(arr.length * Math.min(0.9, max / text.length)));
    arr.length = keep;
    copy.truncated = true;
    copy.hint = "Respuesta recortada al límite de ~6.000 tokens: usa filtros más estrechos, un limit menor o la página siguiente.";
    const parent = target.path.length >= 1 ? getAt(copy.data, target.path.slice(0, -1)) : undefined;
    if (parent && typeof parent === "object" && "total" in (parent as object) && target.path[target.path.length - 1] === "rows") {
      (parent as { nextCursor?: string }).nextCursor = undefined;
    }
    text = JSON.stringify(copy);
  }
  if (text.length > max) text = JSON.stringify({ ok: env.ok, truncated: true, hint: "Respuesta demasiado grande; usa filtros.", data: undefined });
  return text;
}
