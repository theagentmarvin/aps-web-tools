/**
 * Secrets that must NOT live in the repository: the approval HMAC key, the
 * audit-chain key, WebAuthn credentials and the APS token cache.
 *
 * Location (first match):
 *   1. COORD_SECURE_DIR
 *   2. <COORDINATOR_HOME>/secret          (tests / demos that set COORDINATOR_HOME)
 *   3. %APPDATA%\bim-coordinator          (Windows)
 *   4. $XDG_CONFIG_HOME|~/.config/bim-coordinator
 *
 * Protection of key material at rest (dependency-free):
 *   - Windows: DPAPI (CurrentUser scope) through `powershell.exe` and
 *     System.Security.Cryptography.ProtectedData. The file holds only the
 *     DPAPI blob; it is useless on another machine or for another Windows user.
 *   - elsewhere, or with COORD_KEY_PROTECTION=none: plain file, mode 0600.
 *
 * LIMITS (documented in docs/api.md and harness-design §8): DPAPI CurrentUser
 * protects against other OS users, offline disk copies and backups. It does NOT
 * protect against a process running as the same OS user, which can call DPAPI
 * itself. That is why the human-approval guarantee also requires a WebAuthn
 * user-verified signature (server/approval/webauthn.ts).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Protection = "dpapi" | "none";

interface KeyFile {
  v: 1;
  protection: Protection;
  data: string; // base64
}

/**
 * Resolve the secure directory. `homeOverride` = an explicitly chosen
 * `.coordinator` (COORDINATOR_HOME or a test temp dir); the default repo-local
 * `.coordinator` never holds secrets.
 */
export function secureDir(opts: { homeOverride?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env;
  if (env.COORD_SECURE_DIR) return resolve(env.COORD_SECURE_DIR);
  if (opts.homeOverride) return join(resolve(opts.homeOverride), "secret");
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "bim-coordinator");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "bim-coordinator");
}

export function defaultProtection(env: NodeJS.ProcessEnv = process.env): Protection {
  if (env.COORD_KEY_PROTECTION === "none") return "none";
  return process.platform === "win32" ? "dpapi" : "none";
}

function powershell(script: string, input: string): string {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (r.status !== 0) throw new Error(`DPAPI no disponible: ${(r.stderr || r.error?.message || "").toString().slice(0, 200)}`);
  return r.stdout.trim();
}

const PS_PREFIX = "Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); $b = [Convert]::FromBase64String($in);";

export function dpapiProtect(data: Buffer): Buffer {
  const out = powershell(`${PS_PREFIX} $p = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser'); [Convert]::ToBase64String($p)`, data.toString("base64"));
  return Buffer.from(out, "base64");
}

export function dpapiUnprotect(blob: Buffer): Buffer {
  const out = powershell(`${PS_PREFIX} $p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser'); [Convert]::ToBase64String($p)`, blob.toString("base64"));
  return Buffer.from(out, "base64");
}

const memo = new Map<string, Buffer>();

/** Read a 32-byte secret, creating it (O_EXCL) when missing. Cached per process. */
export async function loadOrCreateSecret(dir: string, name: string, protection: Protection = defaultProtection()): Promise<Buffer> {
  const path = join(dir, `${name}.json`);
  const hit = memo.get(path);
  if (hit) return hit;
  const existing = await readSecret(dir, name);
  if (existing) return existing;
  await mkdir(dir, { recursive: true });
  const key = randomBytes(32);
  const file: KeyFile = { v: 1, protection, data: (protection === "dpapi" ? dpapiProtect(key) : key).toString("base64") };
  try {
    const fh = await open(path, "wx", 0o600);
    await fh.writeFile(JSON.stringify(file));
    await fh.close();
    await chmod(path, 0o600).catch(() => undefined);
    memo.set(path, key);
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return (await readSecret(dir, name))!;
    throw err;
  }
}

/** Read-only: undefined when the secret does not exist. */
export async function readSecret(dir: string, name: string): Promise<Buffer | undefined> {
  const path = join(dir, `${name}.json`);
  const hit = memo.get(path);
  if (hit) return hit;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const f = JSON.parse(text) as KeyFile;
  const raw = Buffer.from(f.data, "base64");
  const key = f.protection === "dpapi" ? dpapiUnprotect(raw) : raw;
  memo.set(path, key);
  return key;
}

/** Test helper: forget cached secrets. */
export function clearSecretCache(): void {
  memo.clear();
}
