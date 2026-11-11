/**
 * Consistent folder copies for migration and backups ("copy then verify"):
 *
 *   pass 1 (no lock)    copy every file, hashing the bytes actually copied;
 *   pass 2 (store lock) re-list the source, re-copy what changed since pass 1, drop what vanished
 *                       — writers that use Store.withLock are paused only for this delta;
 *   verify              re-read every copied file and compare count + sha256.
 *
 * Windows: reads/copies retry EBUSY/EPERM/EACCES (antivirus, a writer mid-rename).
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MIGRATED_MARKER, MIGRATION_RECORD } from "./home";
import { withFileLock } from "./fs";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

/** Top-level folders that hold (or once held) secrets: never copied, exported, imported or replaced. */
export const SECRET_TOP_DIRS = new Set(["secret", "secrets", "auth"]);
/** Per-machine files that stay with the folder (never copied out, never replaced by a restore). */
export const LOCAL_ONLY_FILES = new Set(["harness-dev", ".gitkeep", MIGRATED_MARKER, MIGRATION_RECORD]);

/** Paths (relative, "/"-separated) that never leave the data home: secrets, locks, temp files, local markers. */
export function isExcludedFromCopy(rel: string): boolean {
  const r = rel.replace(/\\/g, "/");
  const top = r.split("/")[0] ?? "";
  if (SECRET_TOP_DIRS.has(top.toLowerCase())) return true;
  const name = r.split("/").pop() ?? r;
  if (/\.(lock|tmp)$/i.test(name)) return true;
  return LOCAL_ONLY_FILES.has(r);
}

export async function withIoRetry<T>(fn: () => Promise<T>, attempts = 20): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (i >= attempts || !RETRY_CODES.has(code)) throw err;
      await sleep(10 + i * 15);
    }
  }
}

export interface FileStat {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

/** Recursive file list ("/"-separated relative paths, sorted). Symlinks and other non-regular files are skipped. */
export async function walkFiles(root: string, include: (rel: string) => boolean = () => true): Promise<FileStat[]> {
  const out: FileStat[] = [];
  const visit = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > 32) return;
    let entries: Dirent[];
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const a = join(abs, e.name);
      if (e.isDirectory()) await visit(a, r, depth + 1);
      else if (e.isFile() && include(r)) {
        const s = await withIoRetry(() => stat(a)).catch(() => undefined);
        if (s) out.push({ rel: r, abs: a, size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  };
  await visit(root, "", 0);
  return out.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
}

export interface SnapshotEntry {
  rel: string;
  size: number;
  sha256: string;
}

export function sha256Buf(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

async function copyOne(f: FileStat, dst: string): Promise<SnapshotEntry | undefined> {
  let data: Buffer;
  try {
    data = await withIoRetry(() => readFile(f.abs));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; // vanished meanwhile
    throw err;
  }
  const target = join(dst, ...f.rel.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await withIoRetry(() => writeFile(target, data));
  return { rel: f.rel, size: data.length, sha256: sha256Buf(data) };
}

export interface SnapshotOptions {
  include?: (rel: string) => boolean;
  /** Lock held during the delta pass (normally `<src>/state/store.lock`). */
  lockPath?: string;
  lockTimeoutMs?: number;
}

/** Copy `src` into `dst` (which should be empty/new) consistently; returns the manifest of what was copied. */
export async function snapshotDir(src: string, dst: string, opts: SnapshotOptions = {}): Promise<SnapshotEntry[]> {
  const include = opts.include ?? ((rel: string) => !isExcludedFromCopy(rel));
  await mkdir(dst, { recursive: true });
  const seen = new Map<string, { size: number; mtimeMs: number }>();
  const entries = new Map<string, SnapshotEntry>();
  for (const f of await walkFiles(src, include)) {
    const e = await copyOne(f, dst);
    if (!e) continue;
    entries.set(f.rel, e);
    seen.set(f.rel, { size: f.size, mtimeMs: f.mtimeMs });
  }
  const delta = async () => {
    const now = await walkFiles(src, include);
    const present = new Set(now.map((f) => f.rel));
    for (const f of now) {
      const s = seen.get(f.rel);
      if (s && s.size === f.size && s.mtimeMs === f.mtimeMs && entries.has(f.rel)) continue;
      const e = await copyOne(f, dst);
      if (e) entries.set(f.rel, e);
      else present.delete(f.rel);
    }
    for (const rel of [...entries.keys()]) {
      if (present.has(rel)) continue;
      entries.delete(rel);
      await rm(join(dst, ...rel.split("/")), { force: true });
    }
  };
  if (opts.lockPath) await withFileLock(opts.lockPath, delta, { timeoutMs: opts.lockTimeoutMs ?? 60_000 });
  else await delta();
  return [...entries.values()].sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
}

export interface VerifyResult {
  ok: boolean;
  fileCount: number;
  bytes: number;
  problems: string[];
}

/** Re-read every file of `dir` and compare with the manifest: same set of files, same sha256. */
export async function verifySnapshot(dir: string, manifest: SnapshotEntry[], include: (rel: string) => boolean = () => true): Promise<VerifyResult> {
  const problems: string[] = [];
  const files = await walkFiles(dir, include);
  const want = new Map(manifest.map((m) => [m.rel, m]));
  let bytes = 0;
  if (files.length !== manifest.length) problems.push(`cantidad de archivos: ${files.length} copiados, ${manifest.length} esperados`);
  for (const f of files) {
    const m = want.get(f.rel);
    if (!m) {
      problems.push(`archivo inesperado: ${f.rel}`);
      continue;
    }
    const data = await withIoRetry(() => readFile(f.abs));
    bytes += data.length;
    if (data.length !== m.size || sha256Buf(data) !== m.sha256) problems.push(`sha256 distinto: ${f.rel}`);
    want.delete(f.rel);
  }
  for (const rel of want.keys()) problems.push(`falta: ${rel}`);
  return { ok: problems.length === 0, fileCount: files.length, bytes, problems: problems.slice(0, 20) };
}
