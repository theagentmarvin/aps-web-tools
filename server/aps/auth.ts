/**
 * APS 3-legged OAuth for the CLI / MCP server: authorization code + PKCE
 * (S256), loopback callback on a fixed port, disk token cache, auto refresh.
 *
 * research §1.2 (endpoints, lifetimes: access 60 min, refresh 15 days, code
 * 5 min; refresh tokens rotate → persist atomically, serialise refreshes
 * across processes), §1.3 (Traditional Web App + PKCE, send client_secret with
 * code_verifier; fixed registered redirect `http://localhost:<port>/callback`),
 * §8.11 (legacy had no PKCE, no state check, did not persist rotated tokens).
 *
 * Secrets: never logged, never returned. The coordinator always passes the
 * token path from server/secure/aps-paths.ts (`<secure dir>/aps-token.json`,
 * outside the repo); DEFAULT_TOKEN_PATH is only the fallback for direct use of
 * this module without that config. File mode 0600 best effort.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm, stat, writeFile, chmod } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { loadEnv } from "./config";
import { ApsError } from "./errors";
import { APS_BASE_URL, realSleep, silentLogger, type FetchFn, type Logger, type TokenProvider } from "./http";

export const APS_SCOPES = ["data:read", "data:write", "data:create"] as const;
export const DEFAULT_CALLBACK_PORT = 8765;
/** Fallback only; the coordinator uses server/secure/aps-paths.ts apsTokenPath(). */
export const DEFAULT_TOKEN_PATH = ".coordinator/auth/token.json";

const AUTHORIZE_PATH = "/authentication/v2/authorize";
const TOKEN_PATH = "/authentication/v2/token";
/** Refresh when less than this remains on the access token. */
const EXPIRY_SKEW_MS = 5 * 60_000;

export interface AuthConfig {
  clientId: string;
  /** Present for a Traditional Web App (recommended, research §1.3). */
  clientSecret?: string;
  port: number;
  redirectUri: string;
  scopes: string[];
  /** Absolute path of the token cache. */
  tokenPath: string;
}

/** Build the config from `.env.local` / `.env` / process.env. Throws `config` when the client id is missing. */
export function resolveAuthConfig(cwd: string = process.cwd(), env?: Record<string, string>): AuthConfig {
  const e = env ?? loadEnv(cwd);
  const clientId = e.VITE_APS_CLIENT_ID || e.APS_CLIENT_ID;
  if (!clientId) throw new ApsError({ code: "config", detail: "VITE_APS_CLIENT_ID no está definido en .env.local" });
  const port = Number(e.APS_CALLBACK_PORT || DEFAULT_CALLBACK_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ApsError({ code: "config", detail: "APS_CALLBACK_PORT debe ser un puerto entre 1024 y 65535" });
  }
  return {
    clientId,
    clientSecret: e.APS_CLIENT_SECRET || undefined,
    port,
    // research §1.3: register exactly this URL in the APS app.
    redirectUri: `http://localhost:${port}/callback`,
    scopes: [...APS_SCOPES],
    tokenPath: resolve(cwd, e.APS_TOKEN_PATH || DEFAULT_TOKEN_PATH),
  };
}

// ── PKCE ───────────────────────────────────────────────────────────────────

export function base64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636: 43-char verifier from 32 random bytes, challenge = base64url(sha256(verifier)). */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function buildAuthorizeUrl(
  cfg: AuthConfig,
  p: { state: string; challenge: string; prompt?: "login" },
  baseUrl: string = APS_BASE_URL,
): string {
  const u = new URL(`${baseUrl}${AUTHORIZE_PATH}`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", cfg.scopes.join(" "));
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (p.prompt) u.searchParams.set("prompt", p.prompt);
  return u.toString();
}

// ── Token set and store ───────────────────────────────────────────────────

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  scope?: string;
  obtainedAt: number;
}

/** Atomic JSON token cache with a cross-process lock file (research §1.2). */
export class TokenStore {
  constructor(readonly path: string) {}

  async read(): Promise<TokenSet | undefined> {
    try {
      const t = JSON.parse(await readFile(this.path, "utf8")) as TokenSet;
      return typeof t.accessToken === "string" && typeof t.expiresAt === "number" ? t : undefined;
    } catch {
      return undefined;
    }
  }

  async write(t: TokenSet): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(t), { mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600).catch(() => undefined); // best effort (no-op semantics on Windows)
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }

  /** Run `fn` holding `<path>.lock` (stale after 30 s). */
  async withLock<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void> = realSleep, timeoutMs = 20_000): Promise<T> {
    const lock = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const start = Date.now();
    for (;;) {
      try {
        const fh = await open(lock, "wx", 0o600);
        await fh.close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const age = await stat(lock).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
        if (age > 30_000) await rm(lock, { force: true });
        else if (Date.now() - start > timeoutMs) throw new ApsError({ code: "timeout", detail: "bloqueo del token ocupado" });
        else await sleep(100);
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  }
}

// ── Token endpoint ────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

/** POST /authentication/v2/token. Never includes the token or secret in errors. */
export async function requestToken(
  cfg: AuthConfig,
  params: Record<string, string>,
  fetchFn: FetchFn,
  baseUrl: string = APS_BASE_URL,
  now: number = Date.now(),
): Promise<TokenSet> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (cfg.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", cfg.clientId);
  }
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}${TOKEN_PATH}`, { method: "POST", headers, body: body.toString() });
  } catch (cause) {
    throw new ApsError({ code: "network", method: "POST", path: TOKEN_PATH, cause });
  }
  const text = await res.text();
  let json: Partial<TokenResponse> & { error?: string; error_description?: string } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || !json.access_token) {
    throw new ApsError({
      code: res.status === 400 || res.status === 401 ? "auth_required" : res.status >= 500 ? "server_error" : "unauthorized",
      status: res.status,
      method: "POST",
      path: TOKEN_PATH,
      title: typeof json.error === "string" ? json.error : undefined,
      detail: typeof json.error_description === "string" ? json.error_description.slice(0, 200) : undefined,
    });
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: now + (json.expires_in ?? 3599) * 1000,
    scope: json.scope,
    obtainedAt: now,
  };
}

// ── Loopback callback ─────────────────────────────────────────────────────

const PAGE = (title: string, body: string): string =>
  `<!doctype html><html lang="es"><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;padding:2rem;color:#222"><h1 style="color:#A32428">${title}</h1><p>${body}</p></body></html>`;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Start the loopback server on 127.0.0.1:<port> and resolve with the `code`
 * once `/callback` is hit with a matching `state`.
 */
export function waitForAuthCode(
  port: number,
  expectedState: string,
  timeoutMs = 5 * 60_000,
  /** Web login: send the browser back to this app URL (adds `login=ok|error`) instead of a "close this window" page. */
  redirectTo?: string,
): { code: Promise<string>; ready: Promise<void>; close: () => void } {
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  let readyResolve!: () => void;
  let readyReject!: (e: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  const close = (): void => {
    if (timer) clearTimeout(timer);
    server?.close();
    server?.closeAllConnections?.();
  };
  const code = new Promise<string>((resolveCode, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const send = (status: number, title: string, msg: string): void => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(PAGE(title, msg));
      };
      const backToApp = (result: "ok" | "error"): boolean => {
        if (!redirectTo) return false;
        const u = new URL(redirectTo);
        u.searchParams.set("login", result);
        res.writeHead(302, { Location: u.toString(), "Cache-Control": "no-store" }).end();
        return true;
      };
      const err = url.searchParams.get("error");
      const state = url.searchParams.get("state") ?? "";
      const c = url.searchParams.get("code");
      if (err) {
        if (!backToApp("error")) send(400, "Inicio de sesión cancelado", "Autodesk devolvió un error. Puede cerrar esta ventana.");
        close();
        reject(new ApsError({ code: "auth_required", title: err.slice(0, 100) }));
      } else if (!safeEqual(state, expectedState)) {
        // Do not close: a stray request must not abort a genuine login.
        send(400, "Solicitud inválida", "El parámetro state no coincide.");
      } else if (!c) {
        send(400, "Solicitud inválida", "Falta el código de autorización.");
      } else {
        if (!backToApp("ok")) send(200, "Sesión iniciada", "Ya puede cerrar esta ventana y volver a la terminal.");
        close();
        resolveCode(c);
      }
    });
    server.on("error", (e) => {
      readyReject(e);
      reject(
        new ApsError({ code: "config", detail: `no se pudo abrir el puerto ${port} (APS_CALLBACK_PORT)`, cause: e }),
      );
    });
    server.listen(port, "127.0.0.1", () => readyResolve());
    timer = setTimeout(() => {
      close();
      reject(new ApsError({ code: "timeout", detail: "no se recibió el callback de Autodesk a tiempo" }));
    }, timeoutMs);
  });
  ready.catch(() => undefined);
  return { code, ready, close };
}

/** Open the system browser without going through a shell (no URL escaping issues). */
export function openSystemBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

// ── Facade ────────────────────────────────────────────────────────────────

export interface ApsAuthOptions {
  config?: AuthConfig;
  fetch?: FetchFn;
  log?: Logger;
  now?: () => number;
  baseUrl?: string;
  openBrowser?: (url: string) => void;
}

export interface AuthStatus {
  loggedIn: boolean;
  expiresAt?: number;
  scopes?: string[];
  canRefresh: boolean;
}

/** Token provider for {@link ApsCtx}: cached token, refresh with mutex, interactive login. */
export class ApsAuth implements TokenProvider {
  readonly config: AuthConfig;
  private readonly store: TokenStore;
  private readonly fetchFn: FetchFn;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly openBrowser: (url: string) => void;
  private memory?: TokenSet;
  private inflight?: Promise<string>;

  constructor(opts: ApsAuthOptions = {}) {
    this.config = opts.config ?? resolveAuthConfig();
    this.store = new TokenStore(this.config.tokenPath);
    this.fetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.baseUrl = opts.baseUrl ?? APS_BASE_URL;
    this.openBrowser = opts.openBrowser ?? openSystemBrowser;
  }

  private fresh(t: TokenSet | undefined): t is TokenSet {
    return !!t && t.expiresAt - EXPIRY_SKEW_MS > this.now();
  }

  /** Valid access token; refreshes (once, serialised in-process and across processes) when needed. */
  async getAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<string> {
    if (!opts.forceRefresh && this.fresh(this.memory)) return this.memory.accessToken;
    this.inflight ??= this.refreshLocked(!!opts.forceRefresh).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async refreshLocked(force: boolean): Promise<string> {
    const stale = this.memory?.accessToken;
    return this.store.withLock(async () => {
      const disk = await this.store.read();
      // Another process may have refreshed already.
      if (this.fresh(disk) && (!force || disk.accessToken !== stale)) {
        this.memory = disk;
        return disk.accessToken;
      }
      if (!disk?.refreshToken) throw new ApsError({ code: "auth_required" });
      this.log.info("aps.auth.refresh");
      let next: TokenSet;
      try {
        next = await requestToken(
          this.config,
          { grant_type: "refresh_token", refresh_token: disk.refreshToken, scope: this.config.scopes.join(" ") },
          this.fetchFn,
          this.baseUrl,
          this.now(),
        );
      } catch (err) {
        if (err instanceof ApsError && err.code === "auth_required") await this.store.clear();
        throw err;
      }
      // Rotation: keep the old refresh token only if APS did not send a new one.
      next.refreshToken ??= disk.refreshToken;
      await this.store.write(next);
      this.memory = next;
      return next.accessToken;
    });
  }

  /**
   * Browser login via loopback. Prints nothing secret; the authorize URL holds
   * only public parameters (client id, state, PKCE challenge).
   */
  async loginInteractive(opts: { prompt?: "login"; timeoutMs?: number; onUrl?: (url: string) => void; redirectTo?: string } = {}): Promise<AuthStatus> {
    const { verifier, challenge } = createPkcePair();
    const state = base64url(randomBytes(16));
    const waiter = waitForAuthCode(this.config.port, state, opts.timeoutMs, opts.redirectTo);
    try {
      await waiter.ready;
      const url = buildAuthorizeUrl(this.config, { state, challenge, prompt: opts.prompt }, this.baseUrl);
      opts.onUrl?.(url);
      this.openBrowser(url);
      const code = await waiter.code;
      const tokens = await requestToken(
        this.config,
        { grant_type: "authorization_code", code, redirect_uri: this.config.redirectUri, code_verifier: verifier },
        this.fetchFn,
        this.baseUrl,
        this.now(),
      );
      await this.store.withLock(() => this.store.write(tokens));
      this.memory = tokens;
      this.log.info("aps.auth.login_ok");
      return this.status();
    } finally {
      waiter.close();
    }
  }

  async logout(): Promise<void> {
    this.memory = undefined;
    await this.store.withLock(() => this.store.clear());
  }

  /** Safe status for UIs/tools: never includes tokens. */
  async status(): Promise<AuthStatus> {
    const t = this.memory ?? (await this.store.read());
    return {
      loggedIn: !!t && (t.expiresAt > this.now() || !!t.refreshToken),
      expiresAt: t?.expiresAt,
      scopes: t?.scope?.split(" "),
      canRefresh: !!t?.refreshToken,
    };
  }
}
