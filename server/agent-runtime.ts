/**
 * The IN-APP agent runtime (chat + flows), shipped as app code.
 *
 * Source: `<app root>/agent-runtime/` (agents/, skills/, hooks/, settings.json, CLAUDE.md). It is NOT the
 * repository's `.claude/` (that one is the VS Code developer harness). At start — and before every spawn, so an
 * edited source is picked up — the server materialises it into a private folder laid out as a Claude project:
 *
 *   <base>/<contentHash>/CLAUDE.md
 *   <base>/<contentHash>/.claude/{agents/*.md, skills/<name>/SKILL.md, hooks/*.mjs, settings.json}
 *   <base>/<contentHash>/.runtime-manifest.json      (sha256 of every file above)
 *
 * `<base>` is `%LOCALAPPDATA%\bim-coordinator\agent-runtime` (a sibling of `data/` and `backups/`, so backups never
 * include it; `$XDG_DATA_HOME|~/.local/share/bim-coordinator/agent-runtime` elsewhere). Demo / fixtures / tests
 * (COORDINATOR_HOME or fixtures data) use a temp folder. The base is never inside the data home nor the repo.
 *
 * Guarantees: only the whitelisted files are copied (nothing else from the repo); `{{APP_ROOT}}` in .md files is
 * replaced by the app folder (the agent reads docs/ and rules/ there, read-only); written atomically (staging
 * folder + rename); an existing folder is reused only if it verifies against its manifest (no missing, changed or
 * extra agent/skill/hook/settings file); only the current and the previous hash are kept.
 * The chat and the flows spawn `claude -p` with `cwd` = that folder, so Claude Code resolves CLAUDE_PROJECT_DIR,
 * the hooks, the agents and the skills there.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { defaultDataHome } from "./store/home";

export const RUNTIME_SOURCE_DIR = "agent-runtime";
export const RUNTIME_MANIFEST = ".runtime-manifest.json";
/** Placeholder replaced in .md files by the application folder (forward slashes). */
export const APP_ROOT_TOKEN = "{{APP_ROOT}}";
const KEEP_STAGE_MS = 10 * 60_000;

export interface RuntimeFile {
  /** Path inside the materialised folder (POSIX). */
  target: string;
  /** Path inside agent-runtime/ (POSIX). */
  source: string;
  content: Buffer;
  sha256: string;
}

export interface RuntimePlan {
  appRoot: string;
  files: RuntimeFile[];
  /** 16 hex chars of sha256 over (target, sha256) pairs. */
  hash: string;
}

export interface RuntimeManifest {
  version: 1;
  hash: string;
  appRoot: string;
  files: Record<string, string>;
}

export interface MaterializedRuntime {
  dir: string;
  hash: string;
  base: string;
  /** True when an existing verified folder was reused. */
  reused: boolean;
  /** The source and target of each agent definition (name → path in the runtime). */
  agents: string[];
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const posix = (p: string) => p.split(sep).join("/");

/**
 * Where materialised runtimes live (never inside the data home or the repo). `ephemeral` (demo, fixtures, tests):
 * a temp folder keyed by `scope` (the data home override or the app folder), so parallel test runs never clean
 * up each other's runtime.
 */
export function defaultRuntimeBase(opts: { env?: NodeJS.ProcessEnv; ephemeral?: boolean; scope?: string; platform?: NodeJS.Platform; userHome?: string } = {}): string {
  if (opts.ephemeral) return join(tmpdir(), "bim-coordinator-agent-runtime", sha(resolve(opts.scope ?? "default").toLowerCase()).slice(0, 10));
  // defaultDataHome = <LOCALAPPDATA>\bim-coordinator\data → sibling folder.
  return join(dirname(defaultDataHome(opts.env ?? process.env, opts.platform, opts.userHome)), "agent-runtime");
}

/** Base for a coordinator: temp folder in demo / fixtures / tests (COORDINATOR_HOME or fixtures data). */
export function runtimeBaseFor(coord: { root: string; homeOverride?: string; source: { kind: string } }, env: NodeJS.ProcessEnv = process.env): string {
  if (env.COORD_AGENT_RUNTIME_BASE) return resolve(env.COORD_AGENT_RUNTIME_BASE);
  const ephemeral = !!coord.homeOverride || coord.source.kind === "fixtures";
  return defaultRuntimeBase({ env, ephemeral, scope: coord.homeOverride ?? coord.root });
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p).map((x) => `${name}/${x}`));
    else out.push(name);
  }
  return out.sort();
}

/** Source path (inside agent-runtime/) → target path (inside the runtime folder), or null if not shipped. */
export function runtimeTarget(source: string): string | null {
  if (source.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  if (source === "CLAUDE.md") return "CLAUDE.md";
  if (source === "settings.json") return ".claude/settings.json";
  if (/^agents\/[a-z0-9][a-z0-9-]*\.md$/.test(source)) return `.claude/${source}`;
  if (/^skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md$/.test(source)) return `.claude/${source}`;
  if (/^hooks\/[A-Za-z0-9_][A-Za-z0-9_.-]*\.mjs$/.test(source)) return `.claude/${source}`;
  return null;
}

/** Read agent-runtime/ and compute what would be written. Undefined when the source folder is missing. */
export function runtimePlan(appRoot: string): RuntimePlan | undefined {
  const root = resolve(appRoot);
  const src = join(root, RUNTIME_SOURCE_DIR);
  if (!existsSync(src)) return undefined;
  const files: RuntimeFile[] = [];
  const rootPosix = posix(root);
  for (const source of walk(src)) {
    const target = runtimeTarget(source);
    if (!target) continue;
    let content = readFileSync(join(src, ...source.split("/")));
    if (source.endsWith(".md")) content = Buffer.from(content.toString("utf8").split(APP_ROOT_TOKEN).join(rootPosix), "utf8");
    files.push({ target, source, content, sha256: sha(content) });
  }
  if (!files.length) return undefined;
  files.sort((a, b) => (a.target < b.target ? -1 : 1));
  const hash = sha(files.map((f) => `${f.target}\0${f.sha256}`).join("\n")).slice(0, 16);
  return { appRoot: root, files, hash };
}

/** Folders whose contents must match the manifest exactly (extra files there = tampering). */
const STRICT = [".claude/agents/", ".claude/skills/", ".claude/hooks/"];
const STRICT_FILES = /^\.claude\/settings(\.local)?\.json$|^CLAUDE\.md$|^CLAUDE\.local\.md$|^\.mcp\.json$/;

/** True when `dir` holds exactly the manifest's files with the recorded sha256 (strict areas only). */
export function verifyRuntime(dir: string, expectedHash?: string): boolean {
  let m: RuntimeManifest;
  try {
    m = JSON.parse(readFileSync(join(dir, RUNTIME_MANIFEST), "utf8")) as RuntimeManifest;
  } catch {
    return false;
  }
  if (m.version !== 1 || (expectedHash && m.hash !== expectedHash)) return false;
  for (const [rel, h] of Object.entries(m.files)) {
    try {
      if (sha(readFileSync(join(dir, ...rel.split("/")))) !== h) return false;
    } catch {
      return false;
    }
  }
  for (const rel of walk(dir)) {
    if (rel === RUNTIME_MANIFEST) continue;
    const strict = STRICT.some((p) => rel.startsWith(p)) || STRICT_FILES.test(rel);
    if (strict && !(rel in m.files)) return false;
  }
  return true;
}

function assertOutside(base: string, forbidden: Array<string | undefined>): void {
  const b = resolve(base).toLowerCase();
  for (const f of forbidden) {
    if (!f) continue;
    const r = relative(resolve(f).toLowerCase(), b);
    if (r === "" || (!r.startsWith("..") && !/^[a-z]:/i.test(r))) throw new Error(`La carpeta del agente (${base}) no puede estar dentro de ${f}.`);
  }
}

interface BaseState {
  current?: string;
  previous?: string;
}

function readState(base: string): BaseState {
  try {
    return JSON.parse(readFileSync(join(base, "state.json"), "utf8")) as BaseState;
  } catch {
    return {};
  }
}

const HASH_DIR = /^[0-9a-f]{16}$/;

/** Remove every runtime folder except `keep`, and stale staging folders. Errors (folder in use) are ignored. */
function cleanup(base: string, keep: Set<string>, now: number): void {
  let names: string[] = [];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(base, n);
    try {
      if (HASH_DIR.test(n) && !keep.has(n)) rmSync(p, { recursive: true, force: true });
      else if ((n.startsWith(".stage-") || n.startsWith(".old-")) && now - statSync(p).mtimeMs > KEEP_STAGE_MS) rmSync(p, { recursive: true, force: true });
    } catch {
      // in use (Windows: a running claude has it as cwd): retried on the next start
    }
  }
}

const cache = new Map<string, MaterializedRuntime>();

/**
 * Materialise agent-runtime/ (see the file header). Returns undefined when the app has no agent-runtime/.
 * `forbidden`: folders the base may not be inside (the data home, the repo) — checked before writing anything.
 */
export function materializeRuntime(opts: { appRoot: string; base: string; forbidden?: Array<string | undefined>; now?: number }): MaterializedRuntime | undefined {
  const plan = runtimePlan(opts.appRoot);
  if (!plan) return undefined;
  const base = resolve(opts.base);
  assertOutside(base, [plan.appRoot, ...(opts.forbidden ?? [])]);
  const key = `${base}|${plan.hash}`;
  const agents = plan.files.filter((f) => f.target.startsWith(".claude/agents/")).map((f) => f.target.slice(".claude/agents/".length, -3));
  const hit = cache.get(key);
  if (hit && existsSync(join(hit.dir, RUNTIME_MANIFEST))) return { ...hit, reused: true };

  mkdirSync(base, { recursive: true });
  const dir = join(base, plan.hash);
  let reused = false;
  if (existsSync(dir) && verifyRuntime(dir, plan.hash)) reused = true;
  else {
    const stage = join(base, `.stage-${plan.hash}-${process.pid}-${randomUUID().slice(0, 8)}`);
    try {
      for (const f of plan.files) {
        const p = join(stage, ...f.target.split("/"));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, f.content);
      }
      const manifest: RuntimeManifest = { version: 1, hash: plan.hash, appRoot: plan.appRoot, files: Object.fromEntries(plan.files.map((f) => [f.target, f.sha256])) };
      writeFileSync(join(stage, RUNTIME_MANIFEST), JSON.stringify(manifest, null, 2));
      if (!verifyRuntime(stage, plan.hash)) throw new Error("La copia del agente no coincide con su manifiesto.");
      if (existsSync(dir)) {
        // A folder with this hash exists but does not verify (tampered or half-written): move it aside.
        renameSync(dir, join(base, `.old-${plan.hash}-${Date.now()}`));
      }
      try {
        renameSync(stage, dir);
      } catch (err) {
        // Another process won the race: use its folder if it verifies.
        if (!(existsSync(dir) && verifyRuntime(dir, plan.hash))) throw err;
        reused = true;
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  const state = readState(base);
  const next: BaseState = state.current === plan.hash ? state : { current: plan.hash, ...(state.current ? { previous: state.current } : {}) };
  try {
    if (next !== state) writeFileSync(join(base, "state.json"), JSON.stringify(next));
  } catch {
    // state is advisory (cleanup only)
  }
  cleanup(base, new Set([next.current, next.previous].filter((x): x is string => !!x)), opts.now ?? Date.now());
  const out: MaterializedRuntime = { dir, hash: plan.hash, base, reused, agents };
  cache.set(key, out);
  return out;
}

/** Test seam: forget the per-process cache. */
export function resetRuntimeCache(): void {
  cache.clear();
}

/** Materialised runtime for a coordinator (base from {@link runtimeBaseFor}; never inside its data home). */
export function ensureAgentRuntime(coord: { root: string; homeOverride?: string; source: { kind: string }; dataHome?: { home: string; backupsDir: string } }, opts: { appRoot?: string; base?: string } = {}): MaterializedRuntime | undefined {
  return materializeRuntime({
    appRoot: opts.appRoot ?? coord.root,
    base: opts.base ?? runtimeBaseFor(coord),
    forbidden: [coord.dataHome?.home, coord.dataHome?.backupsDir],
  });
}

/** Source definition of an in-app agent exists (used by the MCP process, which never materialises). */
export function runtimeAgentSourceExists(appRoot: string, name: string): boolean {
  return existsSync(join(resolve(appRoot), RUNTIME_SOURCE_DIR, "agents", `${name}.md`));
}
