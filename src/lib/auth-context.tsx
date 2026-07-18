/**
 * APS session context — stores OAuth tokens in React state + sessionStorage.
 *
 * sessionStorage persistence: survives page reloads, cleared on tab close.
 * Production upgrade: HTTP-only cookie via BFF (no client-side token storage).
 */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";

const STORAGE_KEY = "aps-session";

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

interface AuthContextType {
  session: Session | null;
  login: () => void;
  logout: () => void;
  isAuthenticated: boolean;
  exchangeCode: (code: string) => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | null>(null);

// ── Helpers ─────────────────────────────────────────────────────────

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    // Discard expired sessions
    if (s.expiresAt <= Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null) {
  if (s) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

// ── Provider ────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(loadSession);

  // Persist to sessionStorage on change
  useEffect(() => {
    saveSession(session);
  }, [session]);

  const login = useCallback(() => {
    const clientId = import.meta.env.VITE_APS_CLIENT_ID as string;
    const callbackUrl = import.meta.env.VITE_APS_CALLBACK_URL as string;
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: callbackUrl,
      scope: "data:read data:write account:read",
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
      const err = await res.json();
      throw new Error(`Token exchange failed: ${err.error || res.status}`);
    }

    const data = await res.json();
    setSession({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    });
  }, []);

  const logout = useCallback(() => {
    setSession(null);
  }, []);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    if (!session) return null;

    // Refresh if within 60s of expiry
    if (session.expiresAt - Date.now() < 60_000) {
      try {
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ refresh_token: session.refreshToken }),
        });
        if (res.ok) {
          const data = await res.json();
          const newSession = {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: Date.now() + data.expires_in * 1000,
          };
          setSession(newSession);
          return newSession.accessToken;
        }
      } catch {
        setSession(null);
        return null;
      }
    }

    return session.accessToken;
  }, [session]);

  return (
    <AuthContext.Provider
      value={{
        session,
        login,
        logout,
        isAuthenticated: !!session,
        exchangeCode,
        getAccessToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
