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
  /** Starts the server-side login. Returns the Autodesk authorize URL (if any) so the UI can offer a link when the popup is blocked. Throws on server errors. */
  login: () => Promise<string | undefined>;
  logout: () => Promise<void>;
  /** Set when the browser just came back from the Autodesk sign-in (`?login=ok|error`). */
  returning: "ok" | "error" | undefined;
}

function readReturning(): "ok" | "error" | undefined {
  const v = new URLSearchParams(window.location.search).get("login");
  return v === "ok" || v === "error" ? v : undefined;
}

function clearReturningParam(): void {
  const u = new URL(window.location.href);
  if (!u.searchParams.has("login")) return;
  u.searchParams.delete("login");
  window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
}

const Ctx = createContext<CoordAuthValue | null>(null);

export function CoordAuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [status, setStatus] = useState<AuthStatus>();
  const [error, setError] = useState<Error>();
  const [returning] = useState(readReturning);
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

  // While the server finishes the login (token exchange after the callback), poll the status.
  useEffect(() => {
    if (!status?.loginInProgress) return;
    pollRef.current = window.setInterval(() => void refresh(), returning === "ok" ? 700 : 2000);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [status?.loginInProgress, refresh, returning]);

  // Back from Autodesk: drop `?login=` once the outcome is known.
  useEffect(() => {
    if (returning && status && (status.loggedIn || !status.loginInProgress)) clearReturningParam();
  }, [returning, status]);

  const login = useCallback(async () => {
    // Same-tab flow: Autodesk sign-in, then the server's callback redirects back to this page.
    const here = new URL(window.location.href);
    here.searchParams.delete("login");
    const res = await api.login(here.pathname + here.search + here.hash);
    if (res.authorizeUrl) window.location.assign(res.authorizeUrl);
    else await refresh();
    return res.authorizeUrl;
  }, [api, refresh]);

  const logout = useCallback(async () => {
    await api.logout();
    await refresh();
  }, [api, refresh]);

  const value = useMemo(() => ({ status, error, refresh, login, logout, returning }), [status, error, refresh, login, logout, returning]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCoordAuth(): CoordAuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCoordAuth must be used within CoordAuthProvider");
  return v;
}
