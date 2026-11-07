/**
 * Guards for the Vite dev server (vite.config.ts) and the standalone API.
 * Pure functions so they can be unit tested.
 */
import type { IncomingMessage } from "node:http";
import { fetchSiteOk, hostAllowed, originMatches } from "./host-guard";

const GUARDED = ["/api/coord", "/api/auth", "/api/aps"];

/** Returns a refusal reason, or undefined when the request may continue. */
export function guardLocalRequest(req: IncomingMessage): string | undefined {
  const url = req.url ?? "/";
  if (!GUARDED.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`))) return undefined;
  if (!hostAllowed(req)) return "Host no permitido";
  const method = (req.method ?? "GET").toUpperCase();
  if (url.startsWith("/api/auth") && method !== "GET" && !originMatches(req)) return "Origen no permitido";
  if (!fetchSiteOk(req)) return "Sec-Fetch-Site distinto de same-origin";
  return undefined;
}

/**
 * APS paths the browser may read through /api/aps (GET only). Writes to ACC
 * never go through this proxy: they go through server/approval only.
 */
export const APS_PROXY_ALLOWED_PREFIXES: readonly string[] = [
  "/project/v1/",
  "/data/v1/",
  "/modelderivative/v2/designdata/",
  "/modelderivative/v2/regions/eu/designdata/",
  "/derivativeservice/v2/",
  "/bim360/modelset/v3/",
  "/construction/index/v2/",
];

export function apsProxyAllowed(method: string | undefined, url: string | undefined): boolean {
  if ((method ?? "GET").toUpperCase() !== "GET") return false;
  const path = (url ?? "").replace(/^\/api\/aps/, "").split("?")[0] ?? "";
  if (path.includes("..") || path.includes("%2e") || path.includes("%2E") || path.includes("//")) return false;
  return APS_PROXY_ALLOWED_PREFIXES.some((p) => path.startsWith(p));
}
