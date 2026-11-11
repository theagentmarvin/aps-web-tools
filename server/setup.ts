/**
 * `npm run coordinator -- setup` / `npm run setup`: the single HUMAN install step.
 *
 * Interactive (TTY only; refused when the CLAUDECODE env var exists, even if empty):
 *   a) writes `.mcp.json` and `coordinator.config.json` from server/templates/
 *      when missing; when present and different, shows a diff and asks y/N;
 *   b) if `harness-staging/` exists (mirrors the `.claude/` layout), shows a
 *      per-file unified diff against `.claude/`, asks the user to type INSTALAR,
 *      copies the files and writes a `harness.installed` audit event with hashes;
 *   c) runs the hook test suite (`npx vitest run tests/hooks.test.ts`);
 *   d) checks `.env.local` has the APS variables (never prints values) and
 *      prints the remaining manual steps.
 * `--check`: non-interactive and read-only; reports the install status and
 * FAILS if `.coordinator/harness-dev` exists.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parseDotenv } from "./aps/config";
import { legacyDataHome } from "./store/home";

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
/** `home`: where the dev-mode marker is checked (the hooks look in the repo-local `.coordinator`). */
export function installStatus(root: string, home = legacyDataHome(root)): InstallStatus {
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
  const stagingDir = join(root, "harness-staging");
  if (existsSync(stagingDir)) {
    const files = listFiles(stagingDir);
    const refused = files.filter((f) => !stagedTarget(root, f));
    for (const f of refused) io.err(`harness-staging/${f}: fuera de .claude/ o CLAUDE.md; no se instala.`);
    if (refused.length) failures++;
    const changes = files.filter((f) => {
      const dst = stagedTarget(root, f);
      return dst !== null && (!existsSync(dst) || sha(readFileSync(join(stagingDir, f))) !== sha(readFileSync(dst)));
    });
    // Test the STAGED hooks before installing them.
    const stagedHooks = join(stagingDir, ".claude", "hooks");
    let stagedOk = true;
    if (changes.length && existsSync(stagedHooks) && existsSync(join(root, "tests", "hooks.test.ts"))) {
      io.out("Probando los hooks en harness-staging/ antes de instalar…");
      const pre = deps.runHookTests ?? (() => spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["vitest", "run", "tests/hooks.test.ts"], { cwd: root, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, HOOKS_DIR: "harness-staging/.claude/hooks" } }).status ?? 1);
      stagedOk = pre() === 0;
      if (!stagedOk) { io.out("Las pruebas de los hooks en staging FALLARON: no se instala el harness."); failures++; }
    }
    if (!changes.length) io.out("harness-staging/: .claude/ y CLAUDE.md ya están al día.");
    else if (stagedOk) {
      for (const f of changes) {
        const dst = stagedTarget(root, f)!;
        io.out(unifiedDiff(existsSync(dst) ? readFileSync(dst, "utf8") : "", readFileSync(join(stagingDir, f), "utf8"), f, `harness-staging/${f}`));
      }
      const typed = (await io.ask(`Se ${changes.length === 1 ? "instalará 1 archivo" : `instalarán ${changes.length} archivos`} en .claude/ y CLAUDE.md. Escribe INSTALAR para confirmar: `)).trim();
      if (typed !== "INSTALAR") io.out("Instalación del harness cancelada.");
      else {
        const hashes: Record<string, string> = {};
        for (const f of changes) {
          const data = readFileSync(join(stagingDir, f));
          const dst = stagedTarget(root, f)!;
          mkdirSync(dirname(dst), { recursive: true });
          writeFileSync(dst, data);
          hashes[f] = sha(data);
        }
        await deps.audit({ files: changes.length, hashes: JSON.stringify(hashes) });
        io.out(`Harness instalado (${changes.length} archivos; evento harness.installed registrado).`);
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
