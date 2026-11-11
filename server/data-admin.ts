/**
 * "Datos y respaldos": where the data lives, daily backups, export and restore.
 * HUMAN-ONLY: reachable from the web UI routes (server/api/router.ts, CSRF; restore also
 * needs a passkey). There is deliberately NO MCP tool for any of this (an agent must not
 * be able to export the coordinator's decisions, change the backup target or restore).
 *
 *   backups      <backupsDir>/coordinator-YYYY-MM-DD.zip            daily (one per day)
 *                <backupsDir>/coordinator-YYYY-MM-DD-HHMMSS.zip     "Respaldar ahora"
 *                <backupsDir>/coordinator-YYYY-MM-DD-HHMMSS-pre-restore.zip   before a restore
 *                keeps the newest `keep` (default 14) of each kind; also copied to the optional
 *                external `targetDir` (a corporate synced folder chosen by the human).
 *   settings     <backupsDir>/settings.json   { targetDir, keep }   (outside the data home)
 *   state        <backupsDir>/backup-state.json   last backup / last error
 *
 * ZIP layout: `bim-coordinator-backup.json` (manifest: format, version, files + sha256) and
 * `data/<relative path>`. Secrets, locks, temp files and local markers never enter a ZIP;
 * only data file types (json, jsonl, md, yaml…) do — never executable content.
 */
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type * as C from "./api/contract";
import type { Coordinator } from "./coordinator";
import { hasData, resolveDataHome } from "./store/home";
import { BOTH_EXIST_WARNING, migrationNotice } from "./store/migrate";
import { readJsonFile, renameWithRetry, withFileLock, writeJsonAtomic } from "./store/fs";
import { pathSegment, type Actor } from "./store";
import { isExcludedFromCopy, LOCAL_ONLY_FILES, SECRET_TOP_DIRS, sha256Buf, snapshotDir, verifySnapshot, walkFiles, withIoRetry, type SnapshotEntry } from "./store/snapshot";
import { readZip, unsafeEntryReason, ZipWriter } from "./store/zip";
import { bareProjectId, CoordError, log } from "./util";

export const BACKUP_FORMAT = "bim-coordinator-backup";
export const BACKUP_VERSION = 1;
export const MANIFEST_NAME = "bim-coordinator-backup.json";
export const DEFAULT_KEEP = 14;
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

/** Data file types that may enter (and come back from) a ZIP. Anything else — executables included — is refused. */
export const ALLOWED_DATA_FILE = /\.(json|jsonl|ndjson|md|txt|patch|diff|ya?ml|csv|html|gz)$/i;
/** Top-level entries of the data home the app knows about (others are warned about on import). */
export const KNOWN_TOP = new Set([
  "applied", "approvals", "audit", "batches", "budget", "cache", "chat", "decisions", "feedback", "fixture-acc",
  "issue-checks", "ledgers", "meeting", "projects", "proposals", "questions.json", "reports", "rule-proposals",
  "rule-publications", "state", "tests",
]);
/** Folders keyed by project id (`<dir>/<projectId>/…`). */
const PROJECT_DIRS = new Set(["projects", "reports", "ledgers", "chat", "meeting", "issue-checks", "cache"]);
/** Folders of per-record JSON files that carry a `projectId`. */
const PROJECT_RECORD_DIRS = new Set(["proposals", "batches", "approvals", "applied"]);

export const BACKUP_ACTOR: Actor = { type: "server", id: "backup", name: "Respaldo automático" };

export type BackupKind = "scheduled" | "manual" | "pre-restore" | "export";

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  kind: BackupKind;
  scope: "full" | "project";
  projectId?: string;
  fileCount: number;
  bytes: number;
  /** Files left out because their type is not a data type. */
  skipped: number;
  files: Array<{ path: string; size: number; sha256: string }>;
}

/** Wire types live in the API contract (types only); aliases keep this module readable. */
export type BackupSettings = C.BackupSettings;
export type BackupInfo = C.BackupInfo;
export type DataStatus = C.DataStatus;
export type ImportStage = C.DataImportStage;
export type RestoreProof = C.DataRestoreRequest;
export type RestoreResult = C.DataRestoreResult;

interface BackupState {
  lastBackup?: C.DataStatus["lastBackup"];
  lastError?: C.DataStatus["lastError"];
}

const DAILY_RE = /^coordinator-(\d{4}-\d{2}-\d{2})\.zip$/;
const EXTRA_RE = /^coordinator-(\d{4}-\d{2}-\d{2})-(\d{6})(-pre-restore)?\.zip$/;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}
function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Copy filter for backups / export: no secrets / locks / markers, only data file types. */
export function backupInclude(rel: string): boolean {
  return !isExcludedFromCopy(rel) && ALLOWED_DATA_FILE.test(rel);
}

function isInside(child: string, parent: string): boolean {
  const r = relative(resolve(parent), resolve(child));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

export class DataAdmin {
  private running?: Promise<BackupInfo>;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private readonly stages = new Map<string, { dir: string; payloadHash: string; manifest: BackupManifest; expiresAt: number }>();

  constructor(private readonly coord: Coordinator) {}

  get home(): string {
    return this.coord.store.home;
  }
  get backupsDir(): string {
    return this.coord.dataHome.backupsDir;
  }
  private now(): number {
    return this.coord.now();
  }

  // ── settings ─────────────────────────────────────────────────────────────

  async settings(): Promise<BackupSettings> {
    const s = await readJsonFile<Partial<BackupSettings>>(join(this.backupsDir, "settings.json")).catch(() => undefined);
    const keep = Number.isInteger(s?.keep) && s!.keep! >= 1 && s!.keep! <= 365 ? s!.keep! : DEFAULT_KEEP;
    return { targetDir: typeof s?.targetDir === "string" ? s.targetDir : "", keep };
  }

  async saveSettings(input: { targetDir?: string; keep?: number }, actor: Actor): Promise<BackupSettings> {
    const cur = await this.settings();
    const next: BackupSettings = { ...cur };
    if (input.keep !== undefined) {
      if (!Number.isInteger(input.keep) || input.keep < 1 || input.keep > 365) throw new CoordError("validation_error", "La cantidad de respaldos a conservar debe ser un entero entre 1 y 365.");
      next.keep = input.keep;
    }
    if (input.targetDir !== undefined) next.targetDir = await this.validateTarget(input.targetDir);
    await writeJsonAtomic(join(this.backupsDir, "settings.json"), next);
    // No paths in the audit: they contain the OS user name.
    await this.coord.store.audit({ actor, action: "data.backup_settings", details: { externalTarget: next.targetDir !== "", keep: next.keep } });
    return next;
  }

  private async validateTarget(raw: string): Promise<string> {
    const t = raw.trim();
    if (!t) return "";
    if (t.length > 400) throw new CoordError("validation_error", "La ruta de la carpeta externa es demasiado larga.");
    if (!isAbsolute(t)) throw new CoordError("validation_error", "La carpeta externa debe ser una ruta absoluta (p. ej. C:\\Users\\…\\OneDrive - Empresa\\Respaldos).");
    if (t.split(/[\\/]+/).includes("..")) throw new CoordError("validation_error", "La ruta de la carpeta externa no puede contener '..'.");
    const abs = resolve(t);
    const s = await stat(abs).catch(() => undefined);
    if (!s?.isDirectory()) throw new CoordError("validation_error", "La carpeta externa no existe o no es una carpeta. Créala primero (p. ej. en OneDrive/SharePoint sincronizado).");
    for (const [inside, what] of [
      [this.home, "la carpeta de datos"],
      [this.backupsDir, "la carpeta de respaldos locales"],
      [this.coord.root, "el repositorio"],
    ] as const) {
      if (isInside(abs, inside) || isInside(inside, abs)) throw new CoordError("validation_error", `La carpeta externa no puede estar dentro de ${what} ni contenerla.`);
    }
    return abs;
  }

  // ── backups ──────────────────────────────────────────────────────────────

  async listBackups(dir = this.backupsDir): Promise<BackupInfo[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: Array<BackupInfo & { mtime: number }> = [];
    for (const name of names) {
      const daily = DAILY_RE.exec(name);
      const extra = EXTRA_RE.exec(name);
      if (!daily && !extra) continue;
      const s = await stat(join(dir, name)).catch(() => undefined);
      if (!s?.isFile()) continue;
      out.push({ name, bytes: s.size, createdAt: s.mtime.toISOString(), mtime: s.mtimeMs, kind: daily ? "scheduled" : extra![3] ? "pre-restore" : "manual" });
    }
    return out.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1)).map(({ mtime: _m, ...b }) => b);
  }

  /** Keep the newest `keep` daily backups and the newest `keep` other backups (only our file names). */
  async rotate(dir: string, keep: number): Promise<string[]> {
    const all = await this.listBackups(dir);
    const removed: string[] = [];
    for (const group of [all.filter((b) => b.kind === "scheduled"), all.filter((b) => b.kind !== "scheduled")]) {
      for (const b of group.slice(Math.max(1, keep))) {
        await rm(join(dir, b.name), { force: true }).catch(() => undefined);
        removed.push(b.name);
      }
    }
    return removed;
  }

  private async readState(): Promise<BackupState> {
    return (await readJsonFile<BackupState>(join(this.backupsDir, "backup-state.json")).catch(() => undefined)) ?? {};
  }

  /** Snapshot (copy-then-verify under the store lock) → ZIP at `out`. */
  private async writeZip(out: string, kind: BackupKind, projectId?: string): Promise<BackupManifest> {
    await mkdir(this.backupsDir, { recursive: true });
    const snap = join(this.backupsDir, `.snap-${process.pid}-${this.now()}-${randomBytes(3).toString("hex")}`);
    try {
      let entries = await snapshotDir(this.home, snap, { include: backupInclude, lockPath: this.coord.store.path("state", "store.lock") });
      const v = await verifySnapshot(snap, entries);
      if (!v.ok) throw new CoordError("internal", `La copia para el respaldo no se pudo verificar: ${v.problems.slice(0, 3).join("; ")}`);
      if (projectId) entries = await this.filterProject(snap, entries, projectId);
      const skipped = (await walkFiles(this.home, (rel) => !isExcludedFromCopy(rel) && !ALLOWED_DATA_FILE.test(rel))).length;
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: new Date(this.now()).toISOString(),
        kind,
        scope: projectId ? "project" : "full",
        ...(projectId ? { projectId: bareProjectId(projectId) } : {}),
        fileCount: entries.length,
        bytes: entries.reduce((s, e) => s + e.size, 0),
        skipped,
        files: entries.map((e) => ({ path: e.rel, size: e.size, sha256: e.sha256 })),
      };
      const w = await ZipWriter.create(out);
      try {
        await w.add(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2)));
        for (const e of entries) await w.add(`data/${e.rel}`, await readFile(join(snap, ...e.rel.split("/"))));
        await w.close();
      } catch (err) {
        await w.abort();
        await rm(out, { force: true });
        throw err;
      }
      return manifest;
    } finally {
      await rm(snap, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Re-read a written ZIP: every entry decompresses with the right CRC and matches the manifest. */
  private async verifyZip(path: string, manifest: BackupManifest): Promise<void> {
    const entries = readZip(await readFile(path), { maxTotalBytes: Number.MAX_SAFE_INTEGER, maxEntries: 0xffff });
    const files = new Map(manifest.files.map((f) => [`data/${f.path}`, f]));
    let n = 0;
    for (const e of entries) {
      if (e.isDir || e.name === MANIFEST_NAME) continue;
      const f = files.get(e.name);
      if (!f || sha256Buf(e.read()) !== f.sha256) throw new CoordError("internal", `Respaldo inconsistente (${e.name}).`);
      n++;
    }
    if (n !== manifest.files.length) throw new CoordError("internal", "Respaldo inconsistente (cantidad de archivos).");
  }

  /** Create a backup now (single-flight per process). */
  backupNow(kind: "scheduled" | "manual" | "pre-restore", actor: Actor): Promise<BackupInfo> {
    if (this.running) return kind === "pre-restore" ? this.running.then(() => this.backupNow(kind, actor)) : this.running;
    const p = this.doBackup(kind, actor).finally(() => {
      if (this.running === p) this.running = undefined;
    });
    this.running = p;
    return p;
  }

  private async doBackup(kind: "scheduled" | "manual" | "pre-restore", actor: Actor): Promise<BackupInfo> {
    const t = this.now();
    const name = kind === "scheduled" ? `coordinator-${localDay(t)}.zip` : `coordinator-${localDay(t)}-${localTime(t)}${kind === "pre-restore" ? "-pre-restore" : ""}.zip`;
    const dir = this.backupsDir;
    const final = join(dir, name);
    const part = `${final}.${process.pid}.part`;
    const settings = await this.settings();
    try {
      const manifest = await this.writeZip(part, kind);
      await this.verifyZip(part, manifest);
      await renameWithRetry(part, final);
      const bytes = (await stat(final)).size;
      const info: BackupInfo = { name, bytes, createdAt: new Date(t).toISOString(), kind };
      await this.rotate(dir, settings.keep);
      let external: { ok: boolean; error?: string } | undefined;
      if (settings.targetDir) external = await this.copyExternal(final, name, settings);
      await writeJsonAtomic(join(dir, "backup-state.json"), { ...(await this.readState()), lastBackup: { ...info, fileCount: manifest.fileCount, ...(external ? { external } : {}) }, lastError: undefined } satisfies BackupState);
      await this.coord.store.audit({
        actor,
        action: "data.backup",
        targetIds: [name],
        details: { kind, files: manifest.fileCount, bytes, external: external ? external.ok : null },
      });
      log.info("data.backup", { name, files: manifest.fileCount, bytes });
      return info;
    } catch (err) {
      await rm(part, { force: true }).catch(() => undefined);
      const message = (err as Error).message.slice(0, 300);
      await writeJsonAtomic(join(dir, "backup-state.json"), { ...(await this.readState()), lastError: { at: new Date(t).toISOString(), message } }).catch(() => undefined);
      log.warn("data.backup_failed", { message });
      throw err;
    }
  }

  private async copyExternal(file: string, name: string, settings: BackupSettings): Promise<{ ok: boolean; error?: string }> {
    try {
      const s = await stat(settings.targetDir).catch(() => undefined);
      if (!s?.isDirectory()) throw new Error("la carpeta externa no está disponible");
      const part = join(settings.targetDir, `${name}.part`);
      await withIoRetry(async () => writeFile(part, await readFile(file)));
      await renameWithRetry(part, join(settings.targetDir, name));
      await this.rotate(settings.targetDir, settings.keep);
      return { ok: true };
    } catch (err) {
      const error = `No se pudo copiar a la carpeta externa: ${(err as Error).message.slice(0, 200)}`;
      log.warn("data.backup_external_failed", { message: error });
      return { ok: false, error };
    }
  }

  /** Daily backup: a check at start (after `initialDelayMs`) and every hour; one scheduled backup per local day. */
  startSchedule(opts: { initialDelayMs?: number; checkEveryMs?: number } = {}): () => void {
    this.stopSchedule();
    const tick = async () => {
      try {
        const today = `coordinator-${localDay(this.now())}.zip`;
        if (existsSync(join(this.backupsDir, today))) return;
        await this.backupNow("scheduled", BACKUP_ACTOR);
      } catch {
        /* recorded in backup-state.json and logged */
      }
    };
    const a = setTimeout(() => void tick(), opts.initialDelayMs ?? 5_000);
    const b = setInterval(() => void tick(), opts.checkEveryMs ?? 60 * 60_000);
    a.unref?.();
    b.unref?.();
    this.timers = [a, b];
    return () => this.stopSchedule();
  }

  stopSchedule(): void {
    for (const t of this.timers) clearTimeout(t as never);
    this.timers = [];
  }

  // ── status ───────────────────────────────────────────────────────────────

  async status(): Promise<DataStatus> {
    const r = this.coord.dataHome;
    const notice = await migrationNotice(r);
    // A migration done by another process after this one started: tell the human to restart.
    const fresh = r.mode === "default" || r.mode === "legacy" ? resolveDataHome({ root: this.coord.root, dataSource: this.coord.source.kind }) : r;
    const state = await this.readState();
    return {
      home: this.home,
      mode: r.mode,
      defaultHome: r.defaultHome,
      legacyHome: r.legacyHome,
      backupsDir: this.backupsDir,
      migration: {
        ...(notice.record ? { migratedAt: notice.record.migratedAt, from: notice.record.from, fileCount: notice.record.fileCount } : {}),
        pending: fresh.pendingMigration,
        ...(notice.error && fresh.pendingMigration ? { error: { at: notice.error.at, message: notice.error.message } } : {}),
        ...(fresh.bothExist ? { bothExistWarning: BOTH_EXIST_WARNING } : {}),
      },
      settings: await this.settings(),
      backups: await this.listBackups(),
      ...(state.lastBackup ? { lastBackup: state.lastBackup } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      scheduleActive: this.timers.length > 0,
    };
  }

  // ── export ───────────────────────────────────────────────────────────────

  /** Write an export ZIP to a temp file in the backups folder; the caller streams and deletes it. */
  async exportZip(projectId?: string): Promise<{ path: string; fileName: string; manifest: BackupManifest }> {
    if (projectId !== undefined && !/^(b\.)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(projectId)) throw new CoordError("validation_error", "projectId inválido.");
    const t = this.now();
    const path = join(this.backupsDir, `.export-${process.pid}-${t}-${randomBytes(3).toString("hex")}.zip`);
    const manifest = await this.writeZip(path, "export", projectId);
    const fileName = projectId ? `coordinator-export-${pathSegment(bareProjectId(projectId))}-${localDay(t)}.zip` : `coordinator-export-${localDay(t)}.zip`;
    return { path, fileName, manifest };
  }

  /** Reduce a snapshot to one project's files (and its lines of the shared logs). */
  private async filterProject(snap: string, entries: SnapshotEntry[], projectId: string): Promise<SnapshotEntry[]> {
    const pid = bareProjectId(projectId);
    const segs = new Set([pathSegment(pid), pathSegment(projectId)]);
    const matches = (v: unknown) => typeof v === "string" && bareProjectId(v) === pid;
    const testOk = new Map<string, boolean>();
    const keep: SnapshotEntry[] = [];
    for (const e of entries) {
      const parts = e.rel.split("/");
      const top = parts[0]!;
      const abs = join(snap, ...parts);
      let ok = false;
      let rewrite: Buffer | undefined;
      if (PROJECT_DIRS.has(top)) ok = parts.length > 2 && segs.has(parts[1]!);
      else if (top === "tests" && parts.length > 2) {
        const key = parts[1]!;
        if (!testOk.has(key)) {
          const tr = await readJsonFile<{ projectId?: string }>(join(snap, "tests", key, "test.json")).catch(() => undefined);
          testOk.set(key, matches(tr?.projectId));
        }
        ok = testOk.get(key)!;
      } else if (PROJECT_RECORD_DIRS.has(top) && e.rel.endsWith(".json")) {
        const rec = await readJsonFile<{ projectId?: string }>(abs).catch(() => undefined);
        ok = matches(rec?.projectId);
      } else if (e.rel.endsWith(".jsonl")) {
        const lines = (await readFile(abs, "utf8")).split("\n").filter((l) => {
          if (!l.trim()) return false;
          try {
            return matches((JSON.parse(l) as { projectId?: string }).projectId);
          } catch {
            return false;
          }
        });
        if (lines.length) {
          ok = true;
          rewrite = Buffer.from(lines.join("\n") + "\n");
        }
      }
      if (!ok) {
        await rm(abs, { force: true });
        continue;
      }
      if (rewrite) {
        await writeFile(abs, rewrite);
        keep.push({ rel: e.rel, size: rewrite.length, sha256: sha256Buf(rewrite) });
      } else keep.push(e);
    }
    return keep;
  }

  // ── import / restore ─────────────────────────────────────────────────────

  private async sweepStages(): Promise<void> {
    const t = this.now();
    for (const [id, s] of this.stages) {
      if (s.expiresAt < t) {
        this.stages.delete(id);
        await rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * Step 1 of a restore: receive the ZIP, validate it (zip-slip, file types, manifest +
   * sha256, JSON) and extract it into a staging folder. Writes nothing to the data home.
   */
  async stageImport(body: AsyncIterable<Buffer | string>, maxBytes = MAX_IMPORT_BYTES): Promise<ImportStage> {
    await this.sweepStages();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of body) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += b.length;
      if (size > maxBytes) throw new CoordError("validation_error", `El archivo supera el máximo de ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      chunks.push(b);
    }
    if (!size) throw new CoordError("validation_error", "No se recibió ningún archivo.");
    const buf = Buffer.concat(chunks);
    const payloadHash = sha256Buf(buf);
    const entries = readZip(buf);
    const bad = (m: string) => new CoordError("validation_error", `Respaldo rechazado: ${m}`);
    const man = entries.find((e) => e.name === MANIFEST_NAME);
    if (!man) throw bad(`falta ${MANIFEST_NAME} (¿es un respaldo de esta aplicación?).`);
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(man.read().toString("utf8")) as BackupManifest;
    } catch {
      throw bad("el manifiesto no es JSON válido.");
    }
    if (manifest?.format !== BACKUP_FORMAT) throw bad("formato desconocido.");
    if (manifest.version !== BACKUP_VERSION) throw bad(`versión ${String(manifest.version)} no soportada (se espera ${BACKUP_VERSION}).`);
    if (manifest.scope !== "full") throw bad("es una exportación de un solo proyecto; solo un respaldo completo puede restaurarse.");
    if (!Array.isArray(manifest.files)) throw bad("manifiesto sin lista de archivos.");
    const want = new Map<string, { size: number; sha256: string }>();
    for (const f of manifest.files) {
      if (typeof f?.path !== "string" || unsafeEntryReason(f.path)) throw bad(`ruta insegura en el manifiesto: ${JSON.stringify(String(f?.path).slice(0, 120))}`);
      want.set(f.path, { size: f.size, sha256: f.sha256 });
    }
    const warnings = new Set<string>();
    const files: Array<{ rel: string; read: () => Buffer }> = [];
    for (const e of entries) {
      if (e.isDir || e.name === MANIFEST_NAME) continue;
      if (!e.name.startsWith("data/")) throw bad(`entrada fuera de data/: ${e.name.slice(0, 120)}`);
      const rel = e.name.slice(5);
      if (!rel) throw bad("entrada vacía.");
      if (isExcludedFromCopy(rel)) throw bad(`contiene archivos que nunca se importan (secretos, bloqueos o marcadores): ${rel.slice(0, 120)}`);
      if (!ALLOWED_DATA_FILE.test(rel)) throw bad(`tipo de archivo no permitido (solo datos: json, jsonl, md, yaml…): ${rel.slice(0, 120)}`);
      if (!want.has(rel)) throw bad(`archivo no declarado en el manifiesto: ${rel.slice(0, 120)}`);
      const top = rel.split("/")[0]!;
      if (!KNOWN_TOP.has(top)) warnings.add(`Carpeta desconocida (se restaura igual): ${top}`);
      files.push({ rel, read: e.read });
    }
    if (files.length !== want.size) throw bad(`el manifiesto declara ${want.size} archivos y el ZIP trae ${files.length}.`);
    if (!files.length) throw bad("no contiene datos.");

    const id = randomBytes(8).toString("hex");
    const dir = join(this.backupsDir, `.import-${id}`);
    const dataDir = join(dir, "data");
    try {
      let bytes = 0;
      for (const f of files) {
        const data = f.read();
        const w = want.get(f.rel)!;
        if (data.length !== w.size || sha256Buf(data) !== w.sha256) throw bad(`sha256 distinto al del manifiesto: ${f.rel.slice(0, 120)}`);
        if (/\.json$/i.test(f.rel)) {
          try {
            JSON.parse(data.toString("utf8"));
          } catch {
            throw bad(`JSON inválido: ${f.rel.slice(0, 120)}`);
          }
        }
        const target = join(dataDir, ...f.rel.split("/"));
        // Defence in depth against zip-slip: the resolved target must stay inside the staging folder.
        if (!isInside(target, dataDir) || target === dataDir) throw bad(`ruta fuera de la carpeta de destino: ${f.rel.slice(0, 120)}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, data);
        bytes += data.length;
      }
      const projects = new Set(files.filter((f) => f.rel.startsWith("projects/") || f.rel.startsWith("ledgers/")).map((f) => f.rel.split("/")[1]));
      this.stages.set(id, { dir, payloadHash, manifest, expiresAt: this.now() + 30 * 60_000 });
      return { id, payloadHash, createdAt: String(manifest.createdAt ?? ""), kind: manifest.kind, fileCount: files.length, bytes, projects: projects.size, warnings: [...warnings] };
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  private stage(id: string) {
    if (!/^[0-9a-f]{16}$/.test(id)) throw new CoordError("validation_error", "Id de importación inválido.");
    const s = this.stages.get(id);
    if (!s || s.expiresAt < this.now()) throw new CoordError("not_found", "La importación no existe o venció (30 min). Vuelve a subir el archivo.");
    return s;
  }

  /** Step 2: WebAuthn options whose challenge is bound to the exact uploaded file. */
  async restoreOptions(id: string): Promise<{ nonce: string; options: unknown; payloadHash: string }> {
    const s = this.stage(id);
    const { nonce, options } = await this.coord.webauthn.approvalOptions(`data-restore-${id}`, s.payloadHash, 0);
    return { nonce, options, payloadHash: s.payloadHash };
  }

  async cancelImport(id: string): Promise<void> {
    const s = this.stage(id);
    this.stages.delete(id);
    await rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Step 3 (passkey): back up the current home, then swap the staged data in. Secrets and local
   * markers of the current home are carried over; the replaced folder is removed only after the
   * swap succeeded (the pre-restore backup is the way back).
   */
  async restore(id: string, proof: RestoreProof, actor: Actor): Promise<RestoreResult> {
    const s = this.stage(id);
    let kind: "webauthn" | "demo";
    if (proof.webauthn) {
      await this.coord.webauthn.verifyApproval({ batchId: `data-restore-${id}`, payloadHash: s.payloadHash, testVersion: 0, nonce: proof.webauthn.nonce, origin: proof.webauthn.origin, response: proof.webauthn.response as never });
      kind = "webauthn";
    } else if (proof.demo && this.coord.source.kind === "fixtures") kind = "demo";
    else throw new CoordError("approval_missing", "Restaurar datos requiere confirmar con tu passkey (Windows Hello).");
    this.stages.delete(id);

    const pre = await this.backupNow("pre-restore", actor);
    const home = this.home;
    const staged = join(s.dir, "data");
    const aside = `${home}.replaced-${this.now()}`;
    await withFileLock(
      this.coord.store.path("state", "store.lock"),
      async () => {
        // Carry over what never travels in a ZIP: secrets (test/demo homes keep them here) and local markers.
        const carried: string[] = [];
        for (const name of [...SECRET_TOP_DIRS, ...LOCAL_ONLY_FILES]) {
          const from = join(home, ...name.split("/"));
          const to = join(staged, ...name.split("/"));
          if (!existsSync(from) || existsSync(to)) continue;
          await mkdir(dirname(to), { recursive: true });
          await renameWithRetry(from, to);
          carried.push(name);
        }
        try {
          await renameWithRetry(home, aside);
        } catch (err) {
          for (const name of carried) await renameWithRetry(join(staged, ...name.split("/")), join(home, ...name.split("/"))).catch(() => undefined);
          throw new CoordError("conflict", `No se pudo reemplazar la carpeta de datos (¿un archivo abierto?): ${(err as Error).message.slice(0, 200)}`);
        }
        for (let attempt = 0; ; attempt++) {
          try {
            await rename(staged, home);
            break;
          } catch (err) {
            // Another process may have re-created an empty `home/state` for its lock in between.
            if (attempt < 5 && existsSync(home) && !hasData(home)) {
              await renameWithRetry(home, `${aside}-${attempt}`).catch(() => undefined);
              continue;
            }
            if (attempt < 20 && ["EPERM", "EBUSY", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "")) {
              await new Promise((r) => setTimeout(r, 20 + attempt * 20));
              continue;
            }
            // Put the old home back.
            await renameWithRetry(aside, home).catch(() => undefined);
            throw new CoordError("internal", `No se pudo activar los datos restaurados: ${(err as Error).message.slice(0, 200)}. Los datos anteriores siguen en uso.`);
          }
        }
      },
      { timeoutMs: 60_000 },
    );
    await rm(aside, { recursive: true, force: true }).catch((e) => log.warn("data.restore_cleanup", { message: (e as Error).message }));
    await rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
    await this.coord.store.audit({
      actor,
      action: "data.restored",
      targetIds: [pre.name],
      details: { files: s.manifest.fileCount, bytes: s.manifest.bytes, payloadHash: s.payloadHash, proof: kind, backupCreatedAt: String(s.manifest.createdAt ?? "") },
    });
    return { restoredFiles: s.manifest.fileCount, preRestoreBackup: pre.name, proof: kind, restartRecommended: true };
  }
}

/** Stream a file into an HTTP response (used by the export route); `onDone` runs once. */
export function streamFileTo(res: import("node:http").ServerResponse, path: string, onDone: () => void): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onDone();
  };
  const rs = createReadStream(path);
  rs.on("error", () => {
    if (!res.writableEnded) res.destroy();
    finish();
  });
  res.on("close", finish);
  rs.pipe(res);
}
