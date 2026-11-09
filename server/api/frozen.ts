/**
 * Response objects that never change once built (memoized projections). The router caches their
 * serialized and compressed bytes by object identity; anything not marked here is serialized
 * on every response (e.g. an ingest job object that keeps changing).
 */
const frozen = new WeakSet<object>();

export function markFrozen<T extends object>(o: T): T {
  frozen.add(o);
  return o;
}

export function isFrozen(o: unknown): boolean {
  return !!o && typeof o === "object" && frozen.has(o);
}
