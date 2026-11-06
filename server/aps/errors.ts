/**
 * Typed APS errors with a coordinator-friendly Spanish message.
 *
 * research §3 (error body `{type,title,detail,errors}`), §1.1 (403 when the app
 * is not provisioned under ACC Account Admin → Custom Integrations), §7 (429 +
 * Retry-After), §8.10 (parse the body instead of slicing 200 chars).
 */

export type ApsErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "too_large"
  | "rate_limited"
  | "server_error"
  | "network"
  | "timeout"
  | "blocked_url"
  | "invalid_response"
  | "job_failed"
  | "auth_required"
  | "config";

export interface ApsErrorDetail {
  field?: string;
  title?: string;
  detail?: string;
  type?: string;
}

export interface ApsErrorInit {
  code: ApsErrorCode;
  status?: number;
  method?: string;
  /** Path WITHOUT query string (query strings can hold presigned credentials). */
  path?: string;
  apsType?: string;
  title?: string;
  detail?: string;
  errors?: ApsErrorDetail[];
  retryAfterMs?: number;
  cause?: unknown;
}

const MESSAGES_ES: Record<ApsErrorCode, string> = {
  bad_request: "Autodesk rechazó la solicitud por datos inválidos.",
  unauthorized: "La sesión de Autodesk expiró o no es válida. Inicie sesión nuevamente.",
  forbidden:
    "Acceso denegado por Autodesk. Verifique que la aplicación APS esté habilitada en ACC (Administración de la cuenta → Custom Integrations) y que su usuario tenga permisos sobre la carpeta del modelo.",
  not_found: "El recurso no existe en Autodesk o no es visible para su usuario.",
  conflict: "Autodesk informó un conflicto con el estado actual del recurso.",
  too_large: "La solicitud es demasiado grande para Autodesk; divídala en lotes más pequeños.",
  rate_limited: "Se alcanzó el límite de solicitudes de Autodesk. Espere unos minutos y vuelva a intentar.",
  server_error: "Autodesk respondió con un error interno. Intente nuevamente más tarde.",
  network: "No fue posible conectarse con Autodesk. Revise la conexión a internet o el proxy.",
  timeout: "La operación en Autodesk tardó demasiado y se canceló.",
  blocked_url: "Se bloqueó una URL de descarga que no pertenece a Autodesk/AWS (protección SSRF).",
  invalid_response: "Autodesk devolvió una respuesta con un formato inesperado.",
  job_failed: "El trabajo asíncrono de Autodesk terminó con error.",
  auth_required: "Debe iniciar sesión en Autodesk (npm run coordinator -- login).",
  config: "Falta configuración de APS (revise .env.local).",
};

export function codeForStatus(status: number): ApsErrorCode {
  if (status === 400 || status === 422) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "invalid_response";
}

export class ApsError extends Error {
  readonly code: ApsErrorCode;
  readonly status?: number;
  readonly method?: string;
  readonly path?: string;
  readonly apsType?: string;
  readonly title?: string;
  readonly detail?: string;
  readonly errors?: ApsErrorDetail[];
  readonly retryAfterMs?: number;
  /** Spanish, safe to show to a coordinator. */
  readonly messageEs: string;

  constructor(init: ApsErrorInit) {
    const es = MESSAGES_ES[init.code];
    const where = init.method && init.path ? ` ${init.method} ${init.path}` : "";
    const status = init.status !== undefined ? ` [HTTP ${init.status}]` : "";
    const extra = init.detail ?? init.title;
    super(`${es}${status}${where}${extra ? ` — ${extra}` : ""}`, { cause: init.cause });
    this.name = "ApsError";
    this.code = init.code;
    this.status = init.status;
    this.method = init.method;
    this.path = init.path;
    this.apsType = init.apsType;
    this.title = init.title;
    this.detail = init.detail;
    this.errors = init.errors;
    this.retryAfterMs = init.retryAfterMs;
    this.messageEs = es;
  }

  get retryable(): boolean {
    return this.code === "rate_limited" || this.code === "server_error" || this.code === "network";
  }
}

/** Strip the query string; presigned URLs carry credentials there (harness §8.1). */
export function safePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

/** Build an {@link ApsError} from a non-OK response, parsing the APS error body if present. */
export async function errorFromResponse(res: Response, method: string, url: string, retryAfterMs?: number): Promise<ApsError> {
  let body: Record<string, unknown> | undefined;
  try {
    const text = await res.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    body = undefined;
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v.slice(0, 500) : undefined);
  return new ApsError({
    code: codeForStatus(res.status),
    status: res.status,
    method,
    path: safePath(url),
    apsType: str(body?.type),
    title: str(body?.title) ?? str(body?.developerMessage) ?? str(body?.error),
    detail: str(body?.detail) ?? str(body?.error_description),
    errors: Array.isArray(body?.errors) ? (body.errors as ApsErrorDetail[]).slice(0, 20) : undefined,
    retryAfterMs,
  });
}
