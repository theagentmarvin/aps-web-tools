import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "~/lib/auth-context";

/**
 * OAuth2 callback handler.
 *
 * Autodesk redirects here with ?code=... after user authorizes.
 * We exchange the code for tokens via the Vite dev server proxy
 * (which injects the client secret server-side), then redirect
 * to Data Management.
 */
export function Callback() {
  const navigate = useNavigate();
  const { exchangeCode } = useAuth();
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;
    doneRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");

    if (error) {
      console.error("OAuth error:", error);
      navigate("/?error=auth_denied", { replace: true });
      return;
    }

    if (!code) {
      navigate("/?error=no_code", { replace: true });
      return;
    }

    exchangeCode(code)
      .then(() => {
        navigate("/data-management", { replace: true });
      })
      .catch((err) => {
        console.error("Token exchange failed:", err);
        navigate("/?error=token_exchange_failed", { replace: true });
      });
  }, []);

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center">
        <div className="animate-spin text-3xl mb-4">⏳</div>
        <p className="text-gray-400">Signing in to Autodesk…</p>
      </div>
    </div>
  );
}
