/**
 * One-time, automatic and safe move of the coordinator's data out of the repo:
 * `<root>/.coordinator` → per-user data folder (./home.ts). Runs at server start
 * (Vite / standalone API / MCP server), never in fixtures mode or with COORDINATOR_HOME.
 *
 *   - COPY, never move: the old folder is never deleted; a MIGRATED.txt marker
 *     pointing at the new path is written into it.
 *   - Under a cross-process lock (`<dataRoot>/migration.lock`), idempotent: a second
 *     process waits, re-resolves and finds nothing to do.
 *   - Into a staging folder next to the new home, verified (file count + sha256 per
 *     file), then renamed into place — other processes never see a half-copied home.
 *   - Verification failure: the staging copy is discarded, the old folder stays in use,
 *     and `<dataRoot>/migration-error.json` is written (shown in Ajustes → Datos y respaldos).
 *   - Both folders with data: the new one wins; no merge; a warning is shown.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonFile, renameWithRetry, withFileLock, writeJsonAtomic } from "./fs";
import { MIGRATED_MARKER, MIGRATION_ERROR, MIGRATION_RECORD, resolveDataHome, type DataHomeResolution, type ResolveDataHomeOptions } from "./home";
import { isExcludedFromCopy, snapshotDir, verifySnapshot } from "./snapshot";
import { log } from "../util";

export interface MigrationRecord {
  version: 1;
  migratedAt: string;
  from: string;
  to: string;
  fileCount: number;
  bytes: number;
}

export interface MigrationErrorRecord {
  version: 1;
  at: string;
  from: string;
  to: string;
  message: string;
  problems: string[];
}

export type MigrationOutcome =
  | { status: "skipped"; reason: "override" | "fixtures"; resolution: DataHomeResolution }
  | { status: "none"; resolution: DataHomeResolution }
  | { status: "both_exist"; resolution: DataHomeResolution; warning: string }
  | { status: "migrated"; resolution: DataHomeResolution; record: MigrationRecord }
  | { status: "failed"; resolution: DataHomeResolution; error: MigrationErrorRecord };

export interface MigrateOptions extends ResolveDataHomeOptions {
  now?: () => number;
  /** Test seam: called after the copy, before verification (e.g. to corrupt a file). */
  afterCopy?: (stagingDir: string) => Promise<void>;
}

export const BOTH_EXIST_WARNING =
  "Hay datos en la carpeta nueva y también en la carpeta antigua del repositorio (.coordinator). Se usa la carpeta nueva; la antigua no se fusionó ni se borró.";

function markerText(to: string, at: string): string {
  return [
    "Los datos del Coordinador BIM se copiaron a una carpeta fuera del repositorio.",
    `Nueva ubicación: ${to}`,
    `Fecha: ${at}`,
    "",
    "Esta carpeta ya no se usa para datos. No se borró por seguridad: puedes conservarla como copia",
    "o eliminarla cuando confirmes que la aplicación muestra tus decisiones.",
    "",
  ].join("\r\n");
}

/** Read the migration notice for the UI (record in the new home, or the last error). */
export async function migrationNotice(r: DataHomeResolution): Promise<{ record?: MigrationRecord; error?: MigrationErrorRecord }> {
  const record = await readJsonFile<MigrationRecord>(join(r.defaultHome, MIGRATION_RECORD)).catch(() => undefined);
  const error = await readJsonFile<MigrationErrorRecord>(join(dirname(r.defaultHome), MIGRATION_ERROR)).catch(() => undefined);
  return { ...(record ? { record } : {}), ...(error ? { error } : {}) };
}

export async function migrateLegacyHome(opts: MigrateOptions): Promise<MigrationOutcome> {
  const now = opts.now ?? Date.now;
  const first = resolveDataHome(opts);
  if (first.mode === "override" || first.mode === "fixtures") return { status: "skipped", reason: first.mode, resolution: first };
  if (first.bothExist) {
    log.warn("data.both_homes", { message: BOTH_EXIST_WARNING });
    return { status: "both_exist", resolution: first, warning: BOTH_EXIST_WARNING };
  }
  if (!first.pendingMigration) return { status: "none", resolution: first };

  const dataRoot = dirname(first.defaultHome);
  await mkdir(dataRoot, { recursive: true });
  return withFileLock(
    join(dataRoot, "migration.lock"),
    async (): Promise<MigrationOutcome> => {
      // Another process may have finished while we waited.
      const r = resolveDataHome(opts);
      if (!r.pendingMigration) return { status: "none", resolution: r };
      const from = r.legacyHome;
      const to = r.defaultHome;
      const staging = join(dataRoot, `data.migrating-${process.pid}-${now()}`);
      const at = new Date(now()).toISOString();
      const fail = async (message: string, problems: string[]): Promise<MigrationOutcome> => {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        const error: MigrationErrorRecord = { version: 1, at, from, to, message, problems };
        await writeJsonAtomic(join(dataRoot, MIGRATION_ERROR), error).catch(() => undefined);
        log.warn("data.migration_failed", { message, problems: problems.slice(0, 5) });
        return { status: "failed", resolution: resolveDataHome(opts), error };
      };
      try {
        const include = (rel: string) => !isExcludedFromCopy(rel);
        const manifest = await snapshotDir(from, staging, { include, lockPath: join(from, "state", "store.lock") });
        if (opts.afterCopy) await opts.afterCopy(staging);
        const v = await verifySnapshot(staging, manifest);
        if (!v.ok) return await fail("La copia no coincide con el original (cantidad de archivos o sha256).", v.problems);
        const record: MigrationRecord = { version: 1, migratedAt: at, from, to, fileCount: v.fileCount, bytes: v.bytes };
        await writeFile(join(staging, MIGRATION_RECORD), JSON.stringify(record, null, 2));
        if (existsSync(to)) {
          // Only an EMPTY (data-less) new home can be here: remove it so the rename can take its place.
          const left = await readdir(to).catch(() => [] as string[]);
          // Never delete: a folder with only locks/temp files is set aside.
          if (left.length) await renameWithRetry(to, join(dataRoot, `data.empty-${now()}`));
          else await rmdir(to).catch(() => undefined);
        }
        await renameWithRetry(staging, to);
        await writeFile(join(from, MIGRATED_MARKER), markerText(to, at)).catch((e) => log.warn("data.migration_marker", { message: (e as Error).message }));
        await rm(join(dataRoot, MIGRATION_ERROR), { force: true }).catch(() => undefined);
        log.info("data.migrated", { fileCount: record.fileCount, bytes: record.bytes });
        return { status: "migrated", resolution: resolveDataHome(opts), record };
      } catch (e) {
        return fail(`No se pudo copiar: ${(e as Error).message.slice(0, 300)}`, []);
      }
    },
    { timeoutMs: 10 * 60_000 },
  );
}

/**
 * Server start: migrate when needed, never throw (a failure keeps the old folder in use).
 * Returns the outcome for logging.
 */
export async function prepareDataHome(opts: MigrateOptions): Promise<MigrationOutcome | undefined> {
  try {
    return await migrateLegacyHome(opts);
  } catch (e) {
    log.warn("data.migration_error", { message: (e as Error).message.slice(0, 300) });
    return undefined;
  }
}
