/**
 * THE single place that decides where the coordinator's DATA lives (decisions,
 * feedback, audit, ledgers, tests, chat, proposals…). Secrets are elsewhere
 * (server/secure/keystore.ts, DPAPI in %APPDATA%\bim-coordinator) and never
 * move with the data.
 *
 * Resolution (first match):
 *   1. explicit home (Coordinator opts.home)   → mode "override" (tests, evals)
 *   2. COORDINATOR_HOME                         → mode "override" (demo, evals)
 *   3. data source "fixtures"                   → mode "fixtures": <root>/.coordinator (as before)
 *   4. per-user data folder, outside the repo   → mode "default"
 *        Windows: %LOCALAPPDATA%\bim-coordinator\data
 *        macOS/Linux: $XDG_DATA_HOME|~/.local/share/bim-coordinator/data
 *      … unless it is still empty and the old repo-local `<root>/.coordinator`
 *      holds data (migration pending or failed) → mode "legacy": keep using the old folder.
 *
 * The resolution depends only on the file system, so every process (Vite/API,
 * MCP server, chat agent child, CLI) reaches the same answer without passing it along.
 * Migration itself: ./migrate.ts. Backups: ../data-admin.ts.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const APP_DIR = "bim-coordinator";
/** Old repo-local data folder. Also where the harness hooks keep their marker and agent audit. */
export const LEGACY_DIR = ".coordinator";
/** Written in the OLD folder after a verified migration (points to the new path). */
export const MIGRATED_MARKER = "MIGRATED.txt";
/** Written in the NEW home after a verified migration. */
export const MIGRATION_RECORD = "migration.json";
/** Written next to the new home (data root) when a migration attempt failed. */
export const MIGRATION_ERROR = "migration-error.json";

export type DataHomeMode = "override" | "fixtures" | "default" | "legacy";

export interface DataHomeResolution {
  /** The folder the store uses. */
  home: string;
  mode: DataHomeMode;
  /** Per-user default data folder (…\bim-coordinator\data). */
  defaultHome: string;
  /** `<root>/.coordinator`. */
  legacyHome: string;
  /** Where zip backups go: `<dataRoot>/backups` (default mode) or `<home>-backups`. */
  backupsDir: string;
  /** Default mode only: the old folder has data, the new one does not (yet). */
  pendingMigration: boolean;
  /** Default mode only: both folders hold data and the old one was never marked as migrated. */
  bothExist: boolean;
}

export interface ResolveDataHomeOptions {
  /** Repository root. */
  root: string;
  /** Explicit home (Coordinator opts.home); wins over everything. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Data source kind; default: COORD_DATA_SOURCE. */
  dataSource?: "live" | "fixtures";
  /** Test seams. */
  platform?: NodeJS.Platform;
  userHome?: string;
}

/** Per-user default data folder (does not touch the disk). */
export function defaultDataHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, userHome: string = homedir()): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(env.USERPROFILE || userHome, "AppData", "Local");
    return join(local, APP_DIR, "data");
  }
  const xdg = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(userHome, ".local", "share");
  return join(xdg, APP_DIR, "data");
}

/** `<root>/.coordinator`. */
export function legacyDataHome(root: string): string {
  return join(resolve(root), LEGACY_DIR);
}

/**
 * Files that never count as "data" when deciding whether a folder is in use:
 * locks, temp files, the harness-dev marker, .gitkeep, the migration marker and
 * the agent audit lines the Claude Code hooks append to the repo folder.
 */
export function isIgnorableForPresence(rel: string): boolean {
  const r = rel.replace(/\\/g, "/");
  const name = r.split("/").pop() ?? r;
  if (/\.(lock|tmp)$/i.test(name)) return true;
  if (r === "harness-dev" || r === ".gitkeep" || r === MIGRATED_MARKER || r === MIGRATION_RECORD) return true;
  if (/^audit\/agent-[^/]+\.jsonl$/.test(r)) return true;
  return false;
}

/** True when `dir` contains at least one file that is real data (short-circuits). */
export function hasData(dir: string): boolean {
  const walk = (abs: string, rel: string, depth: number): boolean => {
    if (depth > 12) return false;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (walk(join(abs, e.name), r, depth + 1)) return true;
      } else if (e.isFile() && !isIgnorableForPresence(r)) return true;
    }
    return false;
  };
  return walk(dir, "", 0);
}

function backupsFor(home: string, mode: DataHomeMode): string {
  return mode === "default" ? join(dirname(home), "backups") : join(dirname(home), `${basename(home)}-backups`);
}

export function resolveDataHome(opts: ResolveDataHomeOptions): DataHomeResolution {
  const env = opts.env ?? process.env;
  const legacyHome = legacyDataHome(opts.root);
  const defaultHome = defaultDataHome(env, opts.platform, opts.userHome);
  const make = (home: string, mode: DataHomeMode, extra: Partial<DataHomeResolution> = {}): DataHomeResolution => ({
    home,
    mode,
    defaultHome,
    legacyHome,
    backupsDir: backupsFor(home, mode),
    pendingMigration: false,
    bothExist: false,
    ...extra,
  });
  const override = opts.home ?? env.COORDINATOR_HOME;
  if (override) return make(resolve(override), "override");
  const kind = opts.dataSource ?? (env.COORD_DATA_SOURCE === "fixtures" ? "fixtures" : "live");
  if (kind === "fixtures") return make(legacyHome, "fixtures");
  const newHas = hasData(defaultHome);
  const oldHas = hasData(legacyHome);
  if (newHas) {
    const bothExist = oldHas && !existsSync(join(legacyHome, MIGRATED_MARKER));
    return { ...make(defaultHome, "default"), bothExist };
  }
  if (oldHas) {
    // Not migrated yet, the migration failed, or the new folder was emptied after a migration (the
    // old copy is better than nothing): keep using the old folder; backups go next to the NEW one.
    return { ...make(legacyHome, "legacy"), backupsDir: backupsFor(defaultHome, "default"), pendingMigration: true };
  }
  return make(defaultHome, "default");
}
