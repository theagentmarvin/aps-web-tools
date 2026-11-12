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
    // Hook and end-to-end tests spawn node processes; 5 s is too tight under parallel load.
    testTimeout: 20_000,
    // Hook/e2e tests spawn node processes; cap parallelism so a busy dev machine does not starve them.
    maxWorkers: 3,
    // Plain-file key protection in tests (DPAPI has its own dedicated test).
    env: { COORD_KEY_PROTECTION: "none" },
  },
});
