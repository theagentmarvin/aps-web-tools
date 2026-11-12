/**
 * Standalone HTTP API: `npm run api` (port 3001, or COORD_API_PORT).
 * Binds to 127.0.0.1 only. In dev the same middleware is mounted into Vite
 * (vite.config.ts), so the UI uses same-origin `/api/coord/*` either way.
 */
import "../net/system-ca"; // first: trust the OS certificate store (corporate HTTPS inspection)
import { createServer } from "node:http";
import { log } from "../util";
import { createCoordApi } from "./router";
import { prepareDataHome } from "../store/migrate";

const port = Number(process.env.COORD_API_PORT ?? 3001);
// Data home outside the repo: one-time verified copy of <repo>/.coordinator (never throws).
await prepareDataHome({ root: process.cwd() });
const api = createCoordApi({ backupSchedule: true });
const server = createServer((req, res) => api.middleware(req, res));
server.listen(port, "127.0.0.1", () => {
  log.info("api.listening", { url: `http://127.0.0.1:${port}/api/coord`, dataSource: api.coordinator.source.kind, level: api.coordinator.effectiveLevel });
});
