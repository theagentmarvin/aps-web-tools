/**
 * Vite plugin: APS Auth Middleware
 *
 * Handles secure token operations that require the client secret:
 * - POST /api/auth/callback  — OAuth2 authorization_code → token exchange
 * - POST /api/auth/refresh   — refresh_token → new access token
 *
 * The client secret NEVER reaches the browser.
 */
import type { Plugin, ViteDevServer } from "vite";
import { loadEnv } from "vite";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readBody(req: any): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function json(res: any, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function apsAuthPlugin(): Plugin {
  // Prefixes: VITE_ (client-safe) + APS_ (server-only secrets)
  const env = loadEnv("", process.cwd(), ["VITE_", "APS_"]);

  return {
    name: "aps-auth",
    configureServer(server: ViteDevServer) {
      const clientId = env.VITE_APS_CLIENT_ID;
      const secret = env.APS_CLIENT_SECRET;
      const callbackUrl = env.VITE_APS_CALLBACK_URL;

      console.log("[aps-auth] Plugin loaded.");
      console.log("[aps-auth] clientId:", clientId ? `${clientId.slice(0, 8)}...` : "MISSING");
      console.log("[aps-auth] secret:", secret ? `${secret.slice(0, 4)}...` : "MISSING");
      console.log("[aps-auth] callback:", callbackUrl || "MISSING");

      if (!clientId || !secret) {
        console.error("[aps-auth] ⚠️  Missing credentials — token exchange will fail.");
      }

      // ── Token exchange (authorization_code) ──────────────────────
      server.middlewares.use("/api/auth/callback", async (req, res) => {
        if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

        if (!clientId || !secret) {
          console.error("[aps-auth] Token exchange blocked: missing credentials.");
          return json(res, 500, { error: "server_misconfigured", detail: "Missing APS_CLIENT_SECRET in .env.local" });
        }

        const params = await readBody(req);
        const code = params.get("code");
        if (!code) return json(res, 400, { error: "missing_code" });

        console.log("[aps-auth] Exchanging code:", code.slice(0, 10) + "...");

        try {
          const tokenRes = await fetch(
            "https://developer.api.autodesk.com/authentication/v2/token",
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                client_id: clientId,
                client_secret: secret,
                redirect_uri: callbackUrl,
              }),
            }
          );

          console.log("[aps-auth] Autodesk response:", tokenRes.status, tokenRes.statusText);

          const data = await tokenRes.json();

          if (!tokenRes.ok) {
            console.error("[aps-auth] Token exchange failed:", JSON.stringify(data));
          } else {
            console.log("[aps-auth] ✅ Token exchange success.");
          }

          json(res, tokenRes.ok ? 200 : tokenRes.status, data);
        } catch (err) {
          console.error("[aps-auth] Network error:", err);
          json(res, 502, { error: "token_exchange_failed", detail: String(err) });
        }
      });

      // ── Token refresh ────────────────────────────────────────────
      server.middlewares.use("/api/auth/refresh", async (req, res) => {
        if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

        if (!clientId || !secret) {
          return json(res, 500, { error: "server_misconfigured" });
        }

        const params = await readBody(req);
        const refreshToken = params.get("refresh_token");
        if (!refreshToken) return json(res, 400, { error: "missing_refresh_token" });

        try {
          const tokenRes = await fetch(
            "https://developer.api.autodesk.com/authentication/v2/token",
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: clientId,
                client_secret: secret,
              }),
            }
          );
          const data = await tokenRes.json();
          json(res, tokenRes.ok ? 200 : tokenRes.status, data);
        } catch (err) {
          json(res, 502, { error: "refresh_failed", detail: String(err) });
        }
      });

      // ── S3 proxy (avoids CORS on presigned S3 URLs) ──────────────
      server.middlewares.use("/api/s3-proxy", async (req, res) => {
        if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

        const params = await readBody(req);
        const url = params.get("url");
        if (!url) return json(res, 400, { error: "missing_url" });

        try {
          const s3Res = await fetch(url);
          if (!s3Res.ok) {
            return json(res, s3Res.status, { error: `S3 fetch failed: ${s3Res.status}` });
          }
          // Stream the response back as JSON (clash data is always JSON)
          const data = await s3Res.json();
          json(res, 200, data);
        } catch (err) {
          json(res, 502, { error: "s3_proxy_failed", detail: String(err) });
        }
      });
    },
  };
}
