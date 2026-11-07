/**
 * Browser APS session (viewer / data browser) — ACCESS TOKEN ONLY.
 *
 * The refresh token never reaches the browser: the server exchanges the code
 * and keeps the refresh token (server/api/browser-auth.ts). The browser holds
 * only a short-lived, downscoped access token (`data:read viewables:read`) and
 * asks the server for a new one with POST /api/auth/refresh (empty body).
 *
 * sessionStorage keeps the access token across reloads in the same tab.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

const STORAGE_KEY = "aps-session";
/** Scopes requested at login; the server downscopes to this read-only set anyway. */
const LOGIN_SCOPE = "data:read viewables:read";

export interface Session {
  accessToken: string;
  expiresAt: number; // epoch ms
  scope?: string;
}

interface AuthContextType {
  session: Session | null;
  login: () => void;
  logout: () => void;
  isAuthenticated: boolean;
  exchangeCode: (code: string) => Promise<void>;
  /** Valid access token, refreshed through the server when close to expiry; null when a browser login is needed. */
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | null>(null);

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
}

function toSession(d: TokenResponse): Session {
  return { accessToken: d.access_token, expiresAt: Date.now() + d.expires_in * 1000, scope: d.scope };
}

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session> & { refreshToken?: unknown };
    if (!s.accessToken || !s.expiresAt || s.expiresAt <= Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    // Drop anything else an older build may have stored (e.g. a refresh token).
    return { accessToken: s.accessToken, expiresAt: s.expiresAt, scope: s.scope };
  } catch {
    return null;
  }
}

function saveSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** POST /api/auth/refresh: the server refreshes ITS refresh token and returns a downscoped access token. */
export async function requestViewerToken(): Promise<Session | null> {
  try {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    return toSession((await res.json()) as TokenResponse);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(loadSession);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const inflight = useRef<Promise<Session | null> | null>(null);

  useEffect(() => {
    saveSession(session);
  }, [session]);

  const login = useCallback(() => {
    const params = new URLSearchParams({
      client_id: import.meta.env.VITE_APS_CLIENT_ID ?? "",
      response_type: "code",
      redirect_uri: import.meta.env.VITE_APS_CALLBACK_URL ?? "",
      scope: LOGIN_SCOPE,
    });
    window.location.href = `https://developer.api.autodesk.com/authentication/v2/authorize?${params}`;
  }, []);

  const exchangeCode = useCallback(async (code: string) => {
    const res = await fetch("/api/auth/callback", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`Token exchange failed: ${err.error || res.status}`);
    }
    setSession(toSession((await res.json()) as TokenResponse));
  }, []);

  const logout = useCallback(() => {
    setSession(null);
  }, []);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const s = sessionRef.current;
    if (s && s.expiresAt - Date.now() > 60_000) return s.accessToken;
    // Expired, close to expiry, or none yet: ask the server (it may hold a session from an earlier login).
    inflight.current ??= requestViewerToken().finally(() => {
      inflight.current = null;
    });
    const fresh = await inflight.current;
    setSession(fresh);
    sessionRef.current = fresh;
    return fresh?.accessToken ?? null;
  }, []);

  return (
    <AuthContext.Provider value={{ session, login, logout, isAuthenticated: !!session, exchangeCode, getAccessToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
