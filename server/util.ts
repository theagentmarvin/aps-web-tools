/** Small server-side helpers shared by store, approval, service, MCP and HTTP. */
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "./aps/write-guard";

export { canonicalJson };

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** sha256 of the canonical JSON (sorted keys) of a value. */
export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function nowIso(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

/** YYYYMMDD in UTC. */
export function ymd(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
}

export function uuid(): string {
  return randomUUID();
}

/** Deterministic RFC-4122-shaped id from a hash (stable client ids for ACC bodies). */
export function uuidFromHash(hex: string): string {
  const h = hex.padEnd(32, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Strip the `b.` prefix (MC container id = DM project id without `b.`). */
export function bareProjectId(projectId: string): string {
  return projectId.startsWith("b.") ? projectId.slice(2) : projectId;
}

/** `T-` + first 8 hex chars of sha1(project|modelSet|testId). */
export function testKeyOf(projectId: string, modelSetId: string, testId: string): string {
  return `T-${createHash("sha1").update(`${bareProjectId(projectId)}|${modelSetId}|${testId}`).digest("hex").slice(0, 8)}`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Opaque offset cursor. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const m = /^o:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  return m ? Number(m[1]) : 0;
}

export function paginate<T>(rows: readonly T[], limit: number, cursor?: string): { items: T[]; total: number; nextCursor?: string } {
  const offset = decodeCursor(cursor);
  const items = rows.slice(offset, offset + limit);
  const next = offset + items.length;
  return { items, total: rows.length, nextCursor: next < rows.length ? encodeCursor(next) : undefined };
}

/** Error with a stable code, mapped to MCP envelopes and HTTP statuses. */
export type CoordErrorCode =
  | "not_authenticated"
  | "token_expired"
  | "forbidden"
  | "not_found"
  | "not_ingested"
  | "not_classified"
  | "stale_cache"
  | "properties_pending"
  | "validation_error"
  | "autonomy_level_forbids"
  | "approval_missing"
  | "approval_invalid"
  | "invalid_state"
  | "conflict"
  | "aps_error"
  | "rate_limited"
  | "internal";

export class CoordError extends Error {
  constructor(
    readonly code: CoordErrorCode,
    message: string,
    readonly hint?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CoordError";
  }
}

export function httpStatusFor(code: CoordErrorCode): number {
  switch (code) {
    case "not_authenticated":
    case "token_expired":
      return 401;
    case "forbidden":
    case "autonomy_level_forbids":
    case "approval_missing":
    case "approval_invalid":
      return 403;
    case "not_found":
    case "not_ingested":
    case "not_classified":
      return 404;
    case "validation_error":
      return 400;
    case "invalid_state":
    case "conflict":
    case "stale_cache":
      return 409;
    case "rate_limited":
      return 429;
    case "properties_pending":
      return 202;
    default:
      return 500;
  }
}

/** Log to stderr only (stdout is the MCP protocol channel). */
export const log = {
  info(msg: string, meta?: Record<string, unknown>): void {
    process.stderr.write(`[coord] ${msg}${meta ? " " + JSON.stringify(meta) : ""}\n`);
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    process.stderr.write(`[coord] WARN ${msg}${meta ? " " + JSON.stringify(meta) : ""}\n`);
  },
};
