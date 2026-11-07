/**
 * Vite plugin: APS Auth Middleware (browser / viewer session).
 *
 * - POST /api/auth/callback  — authorization_code → server-side exchange. The
 *   refresh token stays on the server (secure dir, outside the repo); the
 *   browser receives only a short-lived, downscoped access token.
 * - POST /api/auth/refresh   — refreshes the SERVER-HELD token; any
 *   client-supplied refresh_token is ignored.
 *
 * The client secret and refresh tokens NEVER reach the browser, and nothing
 * about the secret is logged. Host / Origin checks for /api/auth run first in
 * vite.config.ts (anti DNS rebinding). Logic: server/api/browser-auth.ts.
 */
import { join } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { loadEnv } from "vite";
import { createBrowserAuthHandlers } from "../../../server/api/browser-auth";
import { secureDir } from "../../../server/secure/keystore";

export function apsAuthPlugin(): Plugin {
  // Prefixes: VITE_ (client-safe) + APS_ (server-only secrets)
  const env = loadEnv("", process.cwd(), ["VITE_", "APS_"]);

  return {
    name: "aps-auth",
    configureServer(server: ViteDevServer) {
      const clientId = env.VITE_APS_CLIENT_ID;
      const secret = env.APS_CLIENT_SECRET;
      const callbackUrl = env.VITE_APS_CALLBACK_URL;

      console.log("[aps-auth] Plugin loaded.", clientId && secret ? "Credentials configured." : "Credentials MISSING: token exchange will fail.");

      const handlers = createBrowserAuthHandlers({
        clientId,
        clientSecret: secret,
        callbackUrl,
        tokenFile: join(secureDir({ homeOverride: process.env.COORDINATOR_HOME }), "browser-session.json"),
        browserScope: env.APS_BROWSER_SCOPE || undefined,
      });

      server.middlewares.use("/api/auth/callback", (req, res) => void handlers.callback(req, res));
      server.middlewares.use("/api/auth/refresh", (req, res) => void handlers.refresh(req, res));
    },
  };
}
