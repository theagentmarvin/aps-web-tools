/**
 * Coordinator session (server-side). In http mode the server owns the APS
 * login (PKCE on its loopback callback); the browser only asks for the status
 * and starts the login. In fixtures mode the server reports a demo session.
 * In mock mode the session is always open.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApi } from "./api";
import type { AuthStatus } from "./api/types";

interface CoordAuthValue {
  status: AuthStatus | undefined;
  error: Error | undefined;
  refresh: () => Promise<void>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<CoordAuthValue | null>(null);

export function CoordAuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [status, setStatus] = useState<AuthStatus>();
  const [error, setError] = useState<Error>();
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.getAuthStatus();
      setStatus(s);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While a server-side login waits for the browser callback, poll the status.
  useEffect(() => {
    if (!status?.loginInProgress) return;
    pollRef.current = window.setInterval(() => void refresh(), 2000);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [status?.loginInProgress, refresh]);

  const login = useCallback(async () => {
    const res = await api.login();
    if (res.authorizeUrl) window.open(res.authorizeUrl, "_blank", "noopener");
    await refresh();
  }, [api, refresh]);

  const logout = useCallback(async () => {
    await api.logout();
    await refresh();
  }, [api, refresh]);

  const value = useMemo(() => ({ status, error, refresh, login, logout }), [status, error, refresh, login, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCoordAuth(): CoordAuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCoordAuth must be used within CoordAuthProvider");
  return v;
}
