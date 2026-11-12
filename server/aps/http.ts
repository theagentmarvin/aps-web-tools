/**
 * Shared APS fetch wrapper: base URL, bearer token, `x-ads-region`, 401 →
 * refresh once, retry with backoff on 429/5xx honouring `Retry-After`, typed
 * errors, and pagination helpers.
 *
 * research §9 ("one apsRequest()"), §3 (status codes), §7 (rate limits,
 * Retry-After in seconds), §2/§3 (`page.continuationToken`), §5 (Issues
 * limit/offset pagination), §8.5 and §8.10 (legacy gaps fixed here).
 *
 * Never logs tokens, headers or query strings.
 */
import { ApsError, errorFromResponse, safePath } from "./errors";

export const APS_BASE_URL = "https://developer.api.autodesk.com";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {} };

/** Supplies 3-legged access tokens (see ./auth.ts). */
export interface TokenProvider {
  getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string>;
}

export interface RetryPolicy {
  /** Retries after the first attempt (so attempts = maxRetries + 1). */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Upper bound for a server-supplied Retry-After. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 4, baseDelayMs: 500, maxDelayMs: 30_000, maxRetryAfterMs: 120_000 };

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApsCtx {
  token: TokenProvider;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetch?: FetchFn;
  region?: "US" | "EMEA";
  baseUrl?: string;
  log?: Logger;
  retry?: Partial<RetryPolicy>;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0,1) (tests). */
  random?: () => number;
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Parse `Retry-After` (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined when absent or unparsable.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Exponential backoff with full jitter: random(0.5..1) × base × 2^attempt, capped. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.round(exp * (0.5 + random() * 0.5));
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export interface RetryDeps {
  fetch: FetchFn;
  policy: RetryPolicy;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  log: Logger;
}

/**
 * fetch with retry on network errors, 429 and 5xx. Returns the final Response
 * (which may still be a non-OK status; callers turn it into an ApsError).
 * `init.body` must be replayable (string / Uint8Array), which every caller here uses.
 */
export async function fetchWithRetry(url: string, init: RequestInit, deps: RetryDeps): Promise<Response> {
  const method = init.method ?? "GET";
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(url, init);
    } catch (cause) {
      if (attempt >= deps.policy.maxRetries) {
        throw new ApsError({ code: "network", method, path: safePath(url), cause });
      }
      const delay = backoffDelay(attempt, deps.policy, deps.random);
      deps.log.warn("aps.retry.network", { path: safePath(url), attempt, delayMs: delay });
      await deps.sleep(delay);
      continue;
    }
    if (!isRetryableStatus(res.status) || attempt >= deps.policy.maxRetries) return res;
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
    const delay =
      retryAfter !== undefined ? Math.min(retryAfter, deps.policy.maxRetryAfterMs) : backoffDelay(attempt, deps.policy, deps.random);
    deps.log.warn("aps.retry.status", { path: safePath(url), status: res.status, attempt, delayMs: delay });
    await res.body?.cancel().catch(() => undefined);
    await deps.sleep(delay);
  }
}

export function retryDeps(ctx: ApsCtx): RetryDeps {
  return {
    fetch: ctx.fetch ?? ((input, init) => fetch(input, init)),
    policy: { ...DEFAULT_RETRY, ...ctx.retry },
    sleep: ctx.sleep ?? realSleep,
    random: ctx.random ?? Math.random,
    log: ctx.log ?? silentLogger,
  };
}

export type QueryValue = string | number | boolean | undefined | null | readonly (string | number | boolean)[];

/** Build `base + path + ?query`. Array values repeat the key (e.g. `status[]=a&status[]=b` if the key says so). */
export function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path.startsWith("http") ? path : `${baseUrl}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export interface ApsRequestOptions {
  query?: Record<string, QueryValue>;
  /** JSON-serialised unless it is a string / Uint8Array. */
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
  /** Extra non-OK statuses to return instead of throwing. */
  acceptStatus?: number[];
}

/** Low-level: perform an authenticated APS call and return the raw Response (OK or accepted). */
export async function apsFetch(
  ctx: ApsCtx,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: ApsRequestOptions = {},
): Promise<Response> {
  const deps = retryDeps(ctx);
  const url = buildUrl(ctx.baseUrl ?? APS_BASE_URL, path, opts.query);
  let body: string | Uint8Array | undefined;
  let contentType = opts.contentType;
  if (opts.body !== undefined) {
    if (typeof opts.body === "string" || opts.body instanceof Uint8Array) body = opts.body;
    else {
      body = JSON.stringify(opts.body);
      contentType ??= "application/json";
    }
  }

  for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
    const token = await ctx.token.getAccessToken(authAttempt > 0 ? { forceRefresh: true } : undefined);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...opts.headers };
    if (contentType) headers["Content-Type"] = contentType;
    if (ctx.region) headers["x-ads-region"] = ctx.region;
    const res = await fetchWithRetry(url, { method, headers, body: body as RequestInit["body"] }, deps);
    if (res.ok || opts.acceptStatus?.includes(res.status)) return res;
    if (res.status === 401 && authAttempt === 0) {
      deps.log.info("aps.auth.refresh_on_401", { path: safePath(url) });
      await res.body?.cancel().catch(() => undefined);
      continue;
    }
    throw await errorFromResponse(res, method, url, parseRetryAfter(res.headers.get("retry-after")));
  }
  /* c8 ignore next */
  throw new ApsError({ code: "unauthorized", method, path: safePath(url) });
}

/** Authenticated APS call returning parsed JSON (or undefined for 204 / empty bodies). */
export async function apsRequest<T>(
  ctx: ApsCtx,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: ApsRequestOptions = {},
): Promise<T> {
  const res = await apsFetch(ctx, method, path, opts);
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new ApsError({ code: "invalid_response", status: res.status, method, path: safePath(res.url || path), cause });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Iterate MC list endpoints that return `{ page: { continuationToken? }, <itemsKey>: T[] }`
 * (research §2, §3; max 20 items/page for model sets, views and versions).
 */
export async function* paginateContinuation<T>(
  ctx: ApsCtx,
  path: string,
  itemsKey: string,
  query: Record<string, QueryValue> = {},
  maxPages = 1000,
): AsyncGenerator<T> {
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const data = await apsRequest<Record<string, unknown>>(ctx, "GET", path, {
      query: { ...query, continuationToken: token },
    });
    const items = data?.[itemsKey];
    if (Array.isArray(items)) for (const it of items) yield it as T;
    const next = (data?.page as { continuationToken?: string } | undefined)?.continuationToken;
    if (!next || seen.has(next)) return;
    seen.add(next);
    token = next;
  }
  throw new ApsError({ code: "invalid_response", path, detail: `pagination exceeded ${maxPages} pages` });
}

/**
 * Iterate ACC endpoints that return `{ pagination: { limit, offset, totalResults }, results: T[] }`
 * (research §5).
 */
export async function* paginateOffset<T>(
  ctx: ApsCtx,
  path: string,
  query: Record<string, QueryValue> = {},
  limit = 100,
): AsyncGenerator<T> {
  let offset = 0;
  for (;;) {
    const data = await apsRequest<{ pagination?: { totalResults?: number }; results?: T[] }>(ctx, "GET", path, {
      query: { ...query, limit, offset },
    });
    const results = data?.results ?? [];
    for (const r of results) yield r;
    offset += results.length;
    const total = data?.pagination?.totalResults;
    if (results.length === 0 || (total !== undefined ? offset >= total : results.length < limit)) return;
  }
}

/** Drain an async iterable into an array. */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** Strip the Data Management `b.` prefix (research §1.4). */
export function toContainerId(projectId: string): string {
  return projectId.startsWith("b.") ? projectId.slice(2) : projectId;
}

/** Encode one path segment. */
export function seg(v: string | number): string {
  return encodeURIComponent(String(v));
}
