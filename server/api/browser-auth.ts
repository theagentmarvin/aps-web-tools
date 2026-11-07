/**
 * Browser (viewer) APS session, server side. Used by src/lib/server/aps-auth-plugin.ts.
 *
 * - POST /api/auth/callback {code}: exchanges the code with the client secret,
 *   keeps the REFRESH token on the server (secure dir, never sent to the
 *   browser), immediately downscopes with a refresh to `browserScope`
 *   (default "data:read viewables:read": no write scopes), and returns only
 *   `{access_token, token_type, expires_in, scope}`.
 * - POST /api/auth/refresh: ignores any client-supplied refresh_token and
 *   refreshes the server-held one (same downscoped scope).
 *
 * APS documents that a refresh may request "the same scopes or a subset"
 * (docs/research/aps-model-coordination-api.md §1.2, O:token). UNVERIFIED on
 * a real tenant: whether the rotated refresh token keeps only the subset. The
 * browser session token file is separate from the coordinator's own token
 * cache, so a downscoped refresh token never affects server-side writes.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_BROWSER_SCOPE = "data:read viewables:read";
const TOKEN_URL = "https://developer.api.autodesk.com/authentication/v2/token";

interface StoredSession {
  refreshToken: string;
  scope?: string;
  obtainedAt: number;
}

export interface BrowserAuthOptions {
  clientId?: string;
  clientSecret?: string;
  callbackUrl?: string;
  /** File holding the server-side refresh token (secure dir). */
  tokenFile: string;
  browserScope?: string;
  fetch?: typeof fetch;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += b.length;
    if (size > 16_384) break;
    chunks.push(b);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function save(file: string, s: StoredSession): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
  await rename(tmp, file);
}

async function load(file: string): Promise<StoredSession | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as StoredSession;
  } catch {
    return undefined;
  }
}

/** Only these fields ever reach the browser. */
function browserView(data: { access_token?: string; token_type?: string; expires_in?: number; scope?: string }) {
  return { access_token: data.access_token, token_type: data.token_type ?? "Bearer", expires_in: data.expires_in, ...(data.scope ? { scope: data.scope } : {}) };
}

export function createBrowserAuthHandlers(opts: BrowserAuthOptions) {
  const f = opts.fetch ?? fetch;
  const scope = opts.browserScope ?? DEFAULT_BROWSER_SCOPE;

  async function tokenCall(params: Record<string, string>) {
    const res = await f(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: opts.clientId!, client_secret: opts.clientSecret! }),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; token_type?: string; expires_in?: number; scope?: string; error?: string };
    return { ok: res.ok, status: res.status, data };
  }

  /** Refresh with the server-held token, downscoped; persist the rotated refresh token. */
  async function downscopedRefresh(refreshToken: string) {
    const r = await tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken, scope });
    if (r.ok && r.data.refresh_token) await save(opts.tokenFile, { refreshToken: r.data.refresh_token, scope: r.data.scope ?? scope, obtainedAt: Date.now() });
    return r;
  }

  return {
    async callback(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
      if (!opts.clientId || !opts.clientSecret) return json(res, 500, { error: "server_misconfigured" });
      const code = (await readForm(req)).get("code");
      if (!code) return json(res, 400, { error: "missing_code" });
      try {
        const ex = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: opts.callbackUrl ?? "" });
        if (!ex.ok || !ex.data.refresh_token) return json(res, ex.ok ? 502 : ex.status, { error: ex.data.error ?? "token_exchange_failed" });
        const down = await downscopedRefresh(ex.data.refresh_token);
        if (!down.ok) {
          // Never hand a write-scoped token to the browser.
          await rm(opts.tokenFile, { force: true });
          return json(res, 502, { error: "downscope_failed" });
        }
        return json(res, 200, browserView(down.data));
      } catch {
        return json(res, 502, { error: "token_exchange_failed" });
      }
    },

    async refresh(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
      if (!opts.clientId || !opts.clientSecret) return json(res, 500, { error: "server_misconfigured" });
      await readForm(req); // any client refresh_token is ignored
      const s = await load(opts.tokenFile);
      if (!s) return json(res, 401, { error: "login_required" });
      try {
        const r = await downscopedRefresh(s.refreshToken);
        if (!r.ok) {
          if (r.status === 400 || r.status === 401) await rm(opts.tokenFile, { force: true });
          return json(res, r.status === 400 || r.status === 401 ? 401 : 502, { error: "refresh_failed" });
        }
        return json(res, 200, browserView(r.data));
      } catch {
        return json(res, 502, { error: "refresh_failed" });
      }
    },
  };
}
