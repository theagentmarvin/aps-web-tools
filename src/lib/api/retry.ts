/**
 * Retry with exponential backoff for the initial data load (G23).
 *
 * In dev the API server and Vite start and reload independently: the first request after a
 * reload can hit a server that is not listening yet (fetch fails, or the Vite proxy answers
 * 502/503/504 or an empty 500). Those are retried a few times before the UI shows
 * "El servidor local no responde"; real errors (4xx, server errors with a code) are not.
 */
import { ApiError } from "./coordinator-api";

/** A failure worth retrying: no answer from the local server (or only the dev proxy answered). */
export function isTransient(err: unknown): boolean {
  if (err instanceof ApiError) {
    if (err.code === "network") return true;
    if (err.status === 502 || err.status === 503 || err.status === 504) return true;
    // The Vite proxy answers an empty 500 when the backend is down; a real server error has a code.
    return err.status === 500 && !err.serverCode;
  }
  // Dynamic import of a chunk while Vite reloads ("Failed to fetch dynamically imported module").
  return err instanceof TypeError;
}

export interface RetryOptions {
  /** Retries after the first attempt (default 5: ≈ 0.4 + 0.8 + 1.6 + 3.2 + 4 s). */
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  shouldRetry?: (err: unknown) => boolean;
  /** Called before each wait (attempt = 1 for the first retry). */
  onRetry?: (attempt: number, err: unknown) => void;
  /** Stop waiting (component unmounted). */
  signal?: { aborted: boolean };
  sleep?: (ms: number) => Promise<void>;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 5;
  const base = opts.baseMs ?? 400;
  const max = opts.maxMs ?? 4000;
  const should = opts.shouldRetry ?? isTransient;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !should(err) || opts.signal?.aborted) throw err;
      opts.onRetry?.(attempt + 1, err);
      await sleep(Math.min(max, base * 2 ** attempt));
      if (opts.signal?.aborted) throw err;
    }
  }
}
