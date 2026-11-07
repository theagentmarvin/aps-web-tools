/**
 * Anti DNS-rebinding and origin checks shared by the coordinator API router
 * and the Vite dev plugins (/api/coord, /api/auth, /api/aps).
 *
 * - Host must be EXACTLY one of localhost:<port>, 127.0.0.1:<port>,
 *   [::1]:<port>, where <port> is the port the socket was accepted on.
 *   X-Forwarded-* headers are ignored (the server is never behind a proxy).
 * - Mutations require an exact Origin match: `http://<Host>`.
 * - Fetch metadata: when `Sec-Fetch-Site` is present it must be same-origin.
 *
 * These checks stop browsers on other sites (including DNS-rebinding pages).
 * They do NOT stop a local non-browser client (curl, node, an agent's shell),
 * which can forge any header; the human-presence guarantee for approvals is
 * the WebAuthn user-verified signature, not these checks.
 */
import type { IncomingMessage } from "node:http";

export function allowedHosts(port: number | undefined): string[] {
  if (!port) return [];
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
}

export function hostAllowed(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? "").toLowerCase();
  return !!host && allowedHosts(req.socket?.localPort).includes(host);
}

/** Exact Origin match for mutations (Referer is not accepted). */
export function originMatches(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  return typeof origin === "string" && typeof host === "string" && origin === `http://${host}`;
}

/** If the browser sent fetch metadata, it must say same-origin. */
export function fetchSiteOk(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin";
}
