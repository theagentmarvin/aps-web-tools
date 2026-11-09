import "./server/net/system-ca"; // first: trust the OS certificate store (corporate HTTPS inspection)
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { apsAuthPlugin } from "./src/lib/server/aps-auth-plugin";
import { apsProxyAllowed, guardLocalRequest } from "./server/api/dev-guards";

/**
 * Anti DNS-rebinding guard, registered FIRST: exact Host allowlist
 * (localhost / 127.0.0.1 / [::1] on the dev port) for /api/coord, /api/auth
 * and /api/aps; exact Origin for mutations on /api/auth. X-Forwarded-* ignored.
 */
function localGuardPlugin(): Plugin {
  return {
    name: "coordinator-local-guard",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const reason = guardLocalRequest(req);
        if (!reason) return next();
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "forbidden", message: reason } }));
      });
    },
  };
}

/**
 * Mounts the coordinator HTTP API (`/api/coord/*`, server/api/router.ts) into
 * the Vite dev server. Loaded lazily so `vite build` never touches the store.
 * Data source: COORD_DATA_SOURCE=fixtures for offline demos, else live ACC.
 */
function coordinatorApiPlugin(): Plugin {
  return {
    name: "coordinator-api",
    apply: "serve",
    async configureServer(server) {
      const { createCoordApi } = await import("./server/api/router");
      let api: ReturnType<typeof createCoordApi> | undefined;
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/coord")) return next();
        api ??= createCoordApi({ root: __dirname });
        api.middleware(req, res, next);
      });
    },
  };
}

export default defineConfig({
  plugins: [localGuardPlugin(), react(), tailwindcss(), apsAuthPlugin(), coordinatorApiPlugin()],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
      "@core": path.resolve(__dirname, "./core"),
    },
  },
  server: {
    port: 3000,
    // Fixed port: the APS callback, the WebAuthn origin and the Host allowlist all assume 3000.
    strictPort: true,
    proxy: {
      // Read-only, allowlisted APS proxy for the viewer / data browser (GET only).
      "/api/aps": {
        target: "https://developer.api.autodesk.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/aps/, ""),
        bypass: (req: IncomingMessage) => (apsProxyAllowed(req.method, req.url) ? undefined : false),
      },
    },
  },
});
