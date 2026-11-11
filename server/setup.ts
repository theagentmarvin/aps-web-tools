/**
 * `npm run coordinator -- setup` / `npm run setup`: the single HUMAN install step.
 *
 * Interactive (TTY only; refused when the CLAUDECODE env var exists, even if empty):
 *   a) writes `.mcp.json` and `coordinator.config.json` from server/templates/
 *      when missing; when present and different, shows a diff and asks y/N;
 *   b) if `harness-staging/` exists (mirrors the `.claude/` layout), shows a
 *      per-file unified diff against `.claude/`, asks the user to type INSTALAR,
 *      copies the files (previous versions backed up in the data home's `backups/`)
 *      and writes a `harness.installed` audit event with hashes. The copy/verify core
 *      (`harnessPlan`, `installHarnessFiles`) is shared with the human-only web route
 *      `POST /api/coord/harness/install` (server/harness-install.ts, passkey required);
 *      there is no MCP tool for it;
 *   c) runs the hook test suite (`npx vitest run tests/hooks.test.ts`);
 *   d) checks `.env.local` has the APS variables (never prints values) and
 *      prints the remaining manual steps.
 * `--check`: non-interactive and read-only; reports the install status and
 * FAILS if `.coordinator/harness-dev` exists.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseDotenv } from "./aps/config";

export interface SetupIO {
  out(s: string): void;
  err(s: string): void;
  ask(question: string): Promise<string>;
}

export const TEMPLATE_FILES: ReadonlyArray<{ template: string; target: string }> = [
  { template: "server/templates/mcp.json", target: ".mcp.json" },
  { template: "server/templates/coordinator.config.json", target: "coordinator.config.json" },
];

export const REQUIRED_ENV = ["VITE_APS_CLIENT_ID", "APS_CLIENT_SECRET", "VITE_APS_CALLBACK_URL"] as const;

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const norm = (s: string) => s.replace(/\r\n/g, "\n");

/** Minimal unified diff (LCS on lines, 2 lines of context). */
export function unifiedDiff(a: string, b: string, nameA: string, nameB: string, context = 2): string {
  const A = norm(a).split("\n");
  const B = norm(b).split("\n");
  if (A.length * B.length > 4_000_000) return `--- ${nameA}\n+++ ${nameB}\n(archivo demasiado grande para mostrar el diff: ${A.length} → ${B.length} líneas)\n`;
  const n = A.length;
  const m = B.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = A[i] === B[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Array<{ t: " " | "-" | "+"; s: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) ops.push({ t: " ", s: A[i++]! }), j++;
    else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) ops.push({ t: "+", s: B[j++]! });
    else ops.push({ t: "-", s: A[i++]! });
  }
  const keep = ops.map((o, k) => o.t !== " " || ops.slice(Math.max(0, k - context), k + context + 1).some((x) => x.t !== " "));
  const lines = [`--- ${nameA}`, `+++ ${nameB}`];
  let gap = false;
  ops.forEach((o, k) => {
    if (keep[k]) {
      if (gap) lines.push("@@");
      gap = false;
      lines.push(`${o.t}${o.s}`);
    } else gap = true;
  });
  return lines.join("\n") + "\n";
}

/**
 * `harness-staging/` mirrors the REPO ROOT (e.g. `harness-staging/.claude/hooks/x.mjs`,
 * `harness-staging/CLAUDE.md`). Only `.claude/**` and `CLAUDE.md` may be installed;
 * anything else in staging is refused (returns null).
 */
export function stagedTarget(root: string, rel: string): string | null {
  if (rel.split("/").some((seg) => seg === ".." || seg === "")) return null;
  if (rel === "CLAUDE.md" || rel.startsWith(".claude/")) return join(root, ...rel.split("/"));
  return null;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

export interface InstallStatus {
  templates: Array<{ target: string; state: "missing" | "identical" | "differs" }>;
  staging: Array<{ file: string; state: "new" | "identical" | "differs" | "refused" }> | null;
  env: { file: boolean; missing: string[] };
  harnessDev: boolean;
  ok: boolean;
}

/** Read-only status (used by --check and at the end of setup). */
export function installStatus(root: string, home = join(root, ".coordinator")): InstallStatus {
  const templates = TEMPLATE_FILES.map(({ template, target }) => {
    const t = join(root, target);
    if (!existsSync(t)) return { target, state: "missing" as const };
    return { target, state: norm(readFileSync(t, "utf8")) === norm(readFileSync(join(root, template), "utf8")) ? ("identical" as const) : ("differs" as const) };
  });
  const stagingDir = join(root, "harness-staging");
  const staging = existsSync(stagingDir)
    ? listFiles(stagingDir).map((f) => {
        const dst = stagedTarget(root, f);
        if (!dst) return { file: f, state: "refused" as const };
        if (!existsSync(dst)) return { file: f, state: "new" as const };
        return { file: f, state: sha(readFileSync(join(stagingDir, f))) === sha(readFileSync(dst)) ? ("identical" as const) : ("differs" as const) };
      })
    : null;
  const envFile = join(root, ".env.local");
  const env = existsSync(envFile) ? parseDotenv(readFileSync(envFile, "utf8")) : {};
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  const harnessDev = existsSync(join(home, "harness-dev"));
  const ok = !harnessDev && templates.every((t) => t.state !== "missing") && (staging ?? []).every((s) => s.state === "identical") && existsSync(envFile) && missing.length === 0;
  return { templates, staging, env: { file: existsSync(envFile), missing }, harnessDev, ok };
}

// ── shared harness install core (CLI setup + human-only web route) ─────────

export type HarnessFileState = "added" | "changed" | "removed" | "same";

export interface HarnessFile {
  /** Path relative to harness-staging/ (= relative to the repo root once installed). */
  path: string;
  state: HarnessFileState;
  stagedHash: string;
  installedHash: string | null;
}

export interface HarnessPlan {
  stagingDir: string;
  files: HarnessFile[];
  /** Staged files outside `.claude/` and `CLAUDE.md`: never installed. */
  refused: string[];
  /** Short hash of every staged file (path + content). */
  stagedVersion: string;
  /** Short hash of the installed counterparts of the staged files. */
  installedVersion: string;
}

/**
 * Read-only comparison of `harness-staging/` against the installed `.claude/` + `CLAUDE.md`.
 * `harness-staging/` is an overlay (only the files it holds are managed), so install never
 * deletes: the `removed` state is reserved and not produced today. Null when there is no staging.
 */
export function harnessPlan(root: string): HarnessPlan | null {
  const stagingDir = join(root, "harness-staging");
  if (!existsSync(stagingDir)) return null;
  const files: HarnessFile[] = [];
  const refused: string[] = [];
  for (const f of listFiles(stagingDir)) {
    const dst = stagedTarget(root, f);
    if (!dst) {
      refused.push(f);
      continue;
    }
    const stagedHash = sha(readFileSync(join(stagingDir, f)));
    const installedHash = existsSync(dst) ? sha(readFileSync(dst)) : null;
    files.push({ path: f, state: installedHash === null ? "added" : installedHash === stagedHash ? "same" : "changed", stagedHash, installedHash });
  }
  const version = (pick: (x: HarnessFile) => string) => sha(files.map((x) => `${x.path}:${pick(x)}`).join("\n")).slice(0, 12);
  return { stagingDir, files, refused, stagedVersion: version((x) => x.stagedHash), installedVersion: version((x) => x.installedHash ?? "none") };
}

/** Files an install would write (added or changed). */
export function harnessChanges(plan: HarnessPlan): HarnessFile[] {
  return plan.files.filter((f) => f.state === "added" || f.state === "changed");
}

/** Hash bound into the passkey challenge: exactly which bytes replace which bytes. */
export function harnessPayloadHash(plan: HarnessPlan): string {
  return sha(JSON.stringify({ op: "harness-install", files: harnessChanges(plan).map((f) => ({ path: f.path, before: f.installedHash, after: f.stagedHash })) }));
}

export const HARNESS_DIFF_MAX_CHARS = 200_000;

/** Unified diff installed → staged of ONE staged file (only paths of the plan; size-capped). */
export function harnessDiff(root: string, path: string, maxChars = HARNESS_DIFF_MAX_CHARS): { path: string; diff: string; truncated: boolean } {
  const plan = harnessPlan(root);
  const file = plan?.files.find((f) => f.path === path);
  if (!plan || !file) throw new Error(`not_staged:${path}`);
  const dst = stagedTarget(root, file.path)!;
  const diff = unifiedDiff(existsSync(dst) ? readFileSync(dst, "utf8") : "", readFileSync(join(plan.stagingDir, file.path), "utf8"), file.path, `harness-staging/${file.path}`);
  return diff.length > maxChars ? { path, diff: diff.slice(0, maxChars) + "\n…\n", truncated: true } : { path, diff, truncated: false };
}

/** True when the staged hooks must be tested before installing (same condition as setup). */
export function stagedHooksNeedTest(root: string, plan: HarnessPlan): boolean {
  return harnessChanges(plan).length > 0 && existsSync(join(plan.stagingDir, ".claude", "hooks")) && existsSync(join(root, "tests", "hooks.test.ts"));
}

export interface HarnessInstallResult {
  installed: string[];
  hashes: Record<string, string>;
  /** Directory with the previous version of every replaced file (absent when nothing was replaced). */
  backupDir?: string;
  backedUp: string[];
}

/**
 * Copy the planned changes into `.claude/` / `CLAUDE.md` and verify each written file hashes to
 * the staged content. With `backupDir`, previous versions are copied there first; on a verify
 * failure the backups are restored and the call throws. Throws when the staging changed since
 * the plan was computed (what was reviewed is what is written).
 */
export function installHarnessFiles(root: string, plan: HarnessPlan, opts: { backupDir?: string } = {}): HarnessInstallResult {
  const changes = harnessChanges(plan);
  const backedUp: string[] = [];
  for (const f of changes) {
    const dst = stagedTarget(root, f.path)!;
    if (sha(readFileSync(join(plan.stagingDir, f.path))) !== f.stagedHash) throw new Error(`harness-staging/${f.path} cambió desde la revisión; vuelve a revisar.`);
    if ((existsSync(dst) ? sha(readFileSync(dst)) : null) !== f.installedHash) throw new Error(`${f.path} cambió desde la revisión; vuelve a revisar.`);
    if (opts.backupDir && existsSync(dst)) {
      const b = join(opts.backupDir, ...f.path.split("/"));
      mkdirSync(dirname(b), { recursive: true });
      writeFileSync(b, readFileSync(dst));
      backedUp.push(f.path);
    }
  }
  const hashes: Record<string, string> = {};
  const written: string[] = [];
  try {
    for (const f of changes) {
      const data = readFileSync(join(plan.stagingDir, f.path));
      const dst = stagedTarget(root, f.path)!;
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, data);
      written.push(f.path);
      if (sha(readFileSync(dst)) !== f.stagedHash) throw new Error(`Verificación fallida al escribir ${f.path}.`);
      hashes[f.path] = f.stagedHash;
    }
  } catch (err) {
    // Roll back what was written: previous content from the backup, new files removed.
    for (const p of written) {
      const dst = stagedTarget(root, p)!;
      const b = opts.backupDir ? join(opts.backupDir, ...p.split("/")) : undefined;
      if (b && backedUp.includes(p)) writeFileSync(dst, readFileSync(b));
      else if (!changes.find((c) => c.path === p)?.installedHash) rmSync(dst, { force: true });
    }
    throw err;
  }
  return { installed: changes.map((f) => f.path), hashes, ...(backedUp.length ? { backupDir: opts.backupDir } : {}), backedUp };
}

export function printStatus(s: InstallStatus, io: Pick<SetupIO, "out">): void {
  io.out("Estado de instalación:");
  for (const t of s.templates) io.out(`  ${t.target.padEnd(26)} ${t.state === "identical" ? "OK" : t.state === "differs" ? "difiere de la plantilla (personalizado)" : "FALTA"}`);
  if (s.staging) {
    const pending = s.staging.filter((x) => x.state !== "identical");
    io.out(`  harness-staging/ → .claude/, CLAUDE.md ${pending.length ? `${pending.length === 1 ? "1 archivo" : `${pending.length} archivos`} sin instalar` : "OK"}`);
  }
  io.out(`  .env.local                 ${!s.env.file ? "FALTA" : s.env.missing.length ? `faltan variables: ${s.env.missing.join(", ")}` : "OK (valores no mostrados)"}`);
  io.out(`  .coordinator/harness-dev   ${s.harnessDev ? "PRESENTE: modo desarrollo del harness activo (las guardas están relajadas)" : "no existe (OK)"}`);
}

export const MANUAL_STEPS = [
  "Pasos manuales restantes:",
  "  1. App APS (aps.autodesk.com): callbacks http://localhost:3000/auth/callback (web) y http://localhost:8765/callback (CLI).",
  "  2. ACC → Admin de cuenta → Custom Integrations: agrega el Client ID de la app.",
  "  3. Inicia sesión: npm run coordinator -- login",
  "  4. Registra tu passkey: npm run coordinator -- passkey-enroll y luego la UI web (Ajustes → Passkey).",
];

/** `setup --check`: read-only. Returns the exit code (1 when not OK or harness-dev exists). */
export function setupCheck(root: string, io: Pick<SetupIO, "out">, home?: string): number {
  const s = installStatus(root, home);
  printStatus(s, io);
  if (s.harnessDev) io.out("ERROR: elimina .coordinator/harness-dev antes de usar el agente con coordinadores.");
  return s.ok ? 0 : 1;
}

export interface SetupDeps {
  root: string;
  home?: string;
  io: SetupIO;
  /** Audit sink (Coordinator store). */
  audit: (details: Record<string, string | number | boolean | null>) => Promise<void>;
  /** Runs the hook tests; returns the exit code. */
  runHookTests?: () => number;
  /** Where the previous `.claude` files are copied before an install (data home backups). */
  backupDir?: string;
}

/** HOOKS_DIR value that makes tests/hooks.test.ts exercise the staged hooks. */
export const STAGED_HOOKS_DIR = "harness-staging/.claude/hooks";

/** Backup folder name for one install: `harness-<UTC stamp>`. */
export function harnessBackupName(now: number): string {
  return `harness-${new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}`;
}

export async function runSetup(deps: SetupDeps): Promise<number> {
  const { root, io } = deps;
  let failures = 0;

  // a) templates
  for (const { template, target } of TEMPLATE_FILES) {
    const src = readFileSync(join(root, template), "utf8");
    const dst = join(root, target);
    if (!existsSync(dst)) {
      writeFileSync(dst, src);
      io.out(`Creado ${target} desde ${template}.`);
      continue;
    }
    const cur = readFileSync(dst, "utf8");
    if (norm(cur) === norm(src)) {
      io.out(`${target}: ya instalado.`);
      continue;
    }
    io.out(unifiedDiff(cur, src, target, template));
    const a = (await io.ask(`${target} difiere de la plantilla. ¿Reemplazar? (s/N): `)).trim().toLowerCase();
    if (a === "s" || a === "si" || a === "sí" || a === "y" || a === "yes") {
      writeFileSync(dst, src);
      io.out(`${target} reemplazado.`);
    } else io.out(`${target} sin cambios.`);
  }

  // b) harness-staging → .claude
  const plan = harnessPlan(root);
  if (plan) {
    for (const f of plan.refused) io.err(`harness-staging/${f}: fuera de .claude/ o CLAUDE.md; no se instala.`);
    if (plan.refused.length) failures++;
    const changes = harnessChanges(plan);
    // Test the STAGED hooks before installing them.
    let stagedOk = true;
    if (stagedHooksNeedTest(root, plan)) {
      io.out("Probando los hooks en harness-staging/ antes de instalar…");
      const pre = deps.runHookTests ?? (() => spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["vitest", "run", "tests/hooks.test.ts"], { cwd: root, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, HOOKS_DIR: STAGED_HOOKS_DIR } }).status ?? 1);
      stagedOk = pre() === 0;
      if (!stagedOk) { io.out("Las pruebas de los hooks en staging FALLARON: no se instala el harness."); failures++; }
    }
    if (!changes.length) io.out("harness-staging/: .claude/ y CLAUDE.md ya están al día.");
    else if (stagedOk) {
      for (const f of changes) io.out(harnessDiff(root, f.path, Number.MAX_SAFE_INTEGER).diff);
      const typed = (await io.ask(`Se ${changes.length === 1 ? "instalará 1 archivo" : `instalarán ${changes.length} archivos`} en .claude/ y CLAUDE.md. Escribe INSTALAR para confirmar: `)).trim();
      if (typed !== "INSTALAR") io.out("Instalación del harness cancelada.");
      else {
        const r = installHarnessFiles(root, plan, deps.backupDir ? { backupDir: deps.backupDir } : {});
        await deps.audit({ files: r.installed.length, hashes: JSON.stringify(r.hashes), channel: "cli", backup: r.backupDir ? basename(r.backupDir) : null });
        io.out(`Harness instalado (${r.installed.length} archivos; evento harness.installed registrado${r.backupDir ? `; copia anterior en ${r.backupDir}` : ""}).`);
      }
    }
  }

  // c) hook tests
  const run = deps.runHookTests ?? (() => spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["vitest", "run", "tests/hooks.test.ts"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" }).status ?? 1);
  if (existsSync(join(root, "tests", "hooks.test.ts"))) {
    io.out("Ejecutando las pruebas de hooks…");
    const code = run();
    io.out(code === 0 ? "Pruebas de hooks: OK." : `Pruebas de hooks: FALLARON (código ${code}).`);
    if (code !== 0) failures++;
  }

  // d) env + manual steps
  const s = installStatus(root, deps.home);
  printStatus(s, io);
  if (!s.env.file || s.env.missing.length) failures++;
  for (const l of MANUAL_STEPS) io.out(l);
  return failures ? 1 : 0;
}
