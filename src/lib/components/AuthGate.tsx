/**
 * Login wall for coordinator routes. Uses the server session
 * (GET /api/coord/auth/status, POST /api/coord/auth/login): the server runs
 * the PKCE flow, so the browser never sees the APS secret or token.
 * Mock mode and the server's fixtures mode report an open demo session.
 */
import { useState, type ReactNode } from "react";
import { useT } from "~/i18n";
import { useCoordAuth } from "~/lib/coord-auth";
import { IconLock, Spinner } from "./icons";
import { ErrorState, Skeleton } from "./ui";

export function AuthGate({ children }: { children: ReactNode }) {
  const { status, error, refresh } = useCoordAuth();
  if (error && !status) return <ErrorState error={error} onRetry={() => void refresh()} />;
  if (!status) return <Skeleton className="m-6 h-40" />;
  if (status.loggedIn) return <>{children}</>;
  return <SignInCard />;
}

export function SignInCard({ title, body }: { title?: string; body?: string }) {
  const t = useT();
  const { status, login } = useCoordAuth();
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [authorizeUrl, setAuthorizeUrl] = useState<string>();
  const [loginError, setLoginError] = useState<string>();
  async function signIn() {
    setBusy(true);
    setLoginError(undefined);
    try {
      setAuthorizeUrl(await login());
      setStarted(true);
    } catch (e) {
      setStarted(false);
      setLoginError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const waiting = started || status?.loginInProgress;
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-brand-muted/20 bg-white p-8 text-center shadow-sm">
        <IconLock size={28} className="mx-auto mb-3 text-brand" />
        {title && <h1 className="mb-2 text-xl font-bold text-brand">{title}</h1>}
        <p className="mb-6 text-sm text-gray-600">{body ?? t("auth.required")}</p>
        <button type="button" onClick={signIn} disabled={busy} className="rounded-lg bg-brand px-6 py-2 font-medium text-white transition-colors hover:bg-brand-light disabled:opacity-60">
          {t("auth.signIn")}
        </button>
        {waiting && !loginError && (
          <p role="status" className="mt-4 flex items-center justify-center gap-2 text-xs text-gray-500">
            <Spinner /> {t("auth.loginStarted")}
          </p>
        )}
        {authorizeUrl && !loginError && (
          <p className="mt-2 text-xs text-gray-500">
            {t("auth.popupBlocked")}{" "}
            <a href={authorizeUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-brand underline">
              {t("auth.openLogin")}
            </a>
          </p>
        )}
        {loginError && (
          <div role="alert" className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-left text-xs text-red-700">
            <p className="font-medium">{t("auth.loginFailed")}</p>
            <p className="mt-1">{loginError}</p>
            {/no está configurado|not configured|client id/i.test(loginError) && <p className="mt-1 text-red-600">{t("auth.loginFailedHint")}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
