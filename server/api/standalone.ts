/**
 * Standalone HTTP API: `npm run api` (port 3001, or COORD_API_PORT).
 * Binds to 127.0.0.1 only. In dev the same middleware is mounted into Vite
 * (vite.config.ts), so the UI uses same-origin `/api/coord/*` either way.
 */
import { createServer } from "node:http";
import { log } from "../util";
import { createCoordApi } from "./router";

const port = Number(process.env.COORD_API_PORT ?? 3001);
const api = createCoordApi();
const server = createServer((req, res) => api.middleware(req, res));
server.listen(port, "127.0.0.1", () => {
  log.info("api.listening", { url: `http://127.0.0.1:${port}/api/coord`, dataSource: api.coordinator.source.kind, level: api.coordinator.effectiveLevel });
});
