import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { apsAuthPlugin } from "./src/lib/server/aps-auth-plugin";

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
  plugins: [react(), tailwindcss(), apsAuthPlugin(), coordinatorApiPlugin()],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
      "@core": path.resolve(__dirname, "./core"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api/aps": {
        target: "https://developer.api.autodesk.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/aps/, ""),
      },
    },
  },
});
