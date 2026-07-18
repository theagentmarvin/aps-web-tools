import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { apsAuthPlugin } from "./src/lib/server/aps-auth-plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), apsAuthPlugin()],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
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
