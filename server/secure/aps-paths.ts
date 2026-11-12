/**
 * THE single place that decides where APS tokens live. Every reader and
 * writer (CLI login/logout, MCP server, HTTP API, browser session plugin)
 * goes through these functions, so they always agree.
 *
 *   coordinator token (3LO, data:* + user-profile:read)     <secure dir>/aps-token.json
 *   browser session refresh token (downscoped)                 <secure dir>/browser-session.json
 *
 * The secure directory is resolved by ./keystore.ts secureDir() (outside the
 * repo; `<COORDINATOR_HOME>/secret` when COORDINATOR_HOME is set).
 */
import { join } from "node:path";
import { resolveAuthConfig, type AuthConfig } from "../aps/auth";
import { loadEnv } from "../aps/config";
import { secureDir } from "./keystore";

export interface SecureLocation {
  /** Explicit `.coordinator` home (tests, demo). Default: COORDINATOR_HOME env. */
  homeOverride?: string;
  env?: NodeJS.ProcessEnv;
}

function dirOf(loc: SecureLocation = {}): string {
  const env = loc.env ?? process.env;
  return secureDir({ homeOverride: loc.homeOverride ?? env.COORDINATOR_HOME, env });
}

export function apsTokenPath(loc: SecureLocation = {}): string {
  return join(dirOf(loc), "aps-token.json");
}

export function browserSessionPath(loc: SecureLocation = {}): string {
  return join(dirOf(loc), "browser-session.json");
}

/** APS auth config for the coordinator token, always pointing at {@link apsTokenPath}. Throws `config` without a client id. */
export function coordinatorAuthConfig(root: string, loc: SecureLocation = {}): AuthConfig {
  return resolveAuthConfig(root, { ...loadEnv(root), APS_TOKEN_PATH: apsTokenPath(loc) });
}
