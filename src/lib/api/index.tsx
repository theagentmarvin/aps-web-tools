/**
 * API selection + React access.
 *
 * VITE_COORD_API=mock|http picks the implementation. Default: mock in dev
 * (until server/api lands), http in production builds. The mock module is
 * loaded with a dynamic import so it is split out of the main bundle.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type DependencyList, type ReactNode } from "react";
import type { ApiMode, CoordinatorApi } from "./coordinator-api";
import { HttpCoordinatorApi } from "./http";

export type { CoordinatorApi, ApiMode } from "./coordinator-api";
export { ApiError } from "./coordinator-api";

export function configuredMode(): ApiMode {
  const raw = import.meta.env.VITE_COORD_API;
  if (raw === "mock" || raw === "http") return raw;
  return import.meta.env.DEV ? "mock" : "http";
}

async function createApi(mode: ApiMode): Promise<CoordinatorApi> {
  if (mode === "mock") {
    const { MockCoordinatorApi } = await import("./mock");
    return new MockCoordinatorApi();
  }
  return new HttpCoordinatorApi();
}

const ApiContext = createContext<CoordinatorApi | null>(null);

export function ApiProvider({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const [api, setApi] = useState<CoordinatorApi | null>(null);
  useEffect(() => {
    let alive = true;
    void createApi(configuredMode()).then((a) => alive && setApi(a));
    return () => {
      alive = false;
    };
  }, []);
  if (!api) return <>{fallback}</>;
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): CoordinatorApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used within ApiProvider");
  return api;
}

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
  setData: (updater: T | ((prev: T | undefined) => T)) => void;
}

/** Run an async loader when deps change; ignores stale responses. */
export function useAsync<T>(loader: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setDataState] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);
    loaderRef.current().then(
      (d) => {
        if (!alive) return;
        setDataState(d);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((u: T | ((prev: T | undefined) => T)) => {
    setDataState((prev) => (typeof u === "function" ? (u as (p: T | undefined) => T)(prev) : u));
  }, []);
  return { data, error, loading, reload, setData };
}
