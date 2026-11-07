import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
      "@core": path.resolve(__dirname, "./core"),
      "@server": path.resolve(__dirname, "./server"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "core/**/*.test.ts", "server/**/*.test.ts"],
    // Plain-file key protection in tests (DPAPI has its own dedicated test).
    env: { COORD_KEY_PROTECTION: "none" },
  },
});
