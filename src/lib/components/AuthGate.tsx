/**
 * Login wall for coordinator routes. Stores the current URL in
 * sessionStorage["coord.returnTo"] before redirecting to Autodesk.
 * In mock mode the gate is open (demo data needs no APS session).
 */
import type { ReactNode } from "react";
import { useT } from "~/i18n";
import { useApi } from "~/lib/api";
import { useAuth } from "~/lib/auth-context";
import { writeString } from "~/lib/storage";
import { IconLock } from "./icons";

export const RETURN_TO_KEY = "coord.returnTo";

export function AuthGate({ children }: { children: ReactNode }) {
  const api = useApi();
  const { isAuthenticated } = useAuth();
  if (api.mode === "mock" || isAuthenticated) return <>{children}</>;
  return <SignInCard />;
}

export function SignInCard({ title, body }: { title?: string; body?: string }) {
  const t = useT();
  const { login } = useAuth();
  function signIn() {
    writeString(RETURN_TO_KEY, window.location.pathname + window.location.search, "session");
    login();
  }
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-brand-muted/20 bg-white p-8 text-center shadow-sm">
        <IconLock size={28} className="mx-auto mb-3 text-brand" />
        {title && <h1 className="mb-2 text-xl font-bold text-brand">{title}</h1>}
        <p className="mb-6 text-sm text-gray-600">{body ?? t("auth.required")}</p>
        <button type="button" onClick={signIn} className="rounded-lg bg-brand px-6 py-2 font-medium text-white transition-colors hover:bg-brand-light">
          {t("auth.signIn")}
        </button>
      </div>
    </div>
  );
}
