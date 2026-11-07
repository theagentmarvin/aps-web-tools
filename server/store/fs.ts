/**
 * File primitives for the `.coordinator/` store: atomic writes (temp file +
 * rename, retried on Windows sharing violations) and a cross-process
 * single-writer lock (exclusive-create lock file with stale takeover). Good
 * enough for one MCP process plus one web server on the same machine.
 */
import { mkdirSync } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let tmpCounter = 0;

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows: a reader holding the target open gives EPERM/EBUSY/EACCES briefly.
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await sleep(10 + attempt * 10);
    }
  }
}

export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
  try {
    await writeFile(tmp, data);
    await renameWithRetry(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2));
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text) as T;
}

export async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readTextFile(path);
  if (!text) return [];
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn last line from a crash: ignore it (the next append starts on a new line).
    }
  }
  return out;
}

/** Append one JSON line. Callers hold the store lock. */
export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(value) + "\n", "utf8");
}

export async function listFiles(dir: string, suffix = ".json"): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(suffix) && !f.endsWith(".tmp")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export function ensureDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

// ── Lock ────────────────────────────────────────────────────────────────────

export interface LockOptions {
  /** A lock older than this is considered abandoned (crashed holder). */
  staleMs?: number;
  timeoutMs?: number;
}

const held = new AsyncLocalStorage<Set<string>>();
const inProcess = new Map<string, Promise<void>>();

/**
 * Run `fn` holding an exclusive lock on `lockPath`. Re-entrant within the same
 * async call chain; serialised in-process with a promise chain and across
 * processes with an O_EXCL lock file.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const mine = held.getStore();
  if (mine?.has(lockPath)) return fn();

  // In-process FIFO.
  const prev = inProcess.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => gate);
  inProcess.set(lockPath, chained);
  await prev;
  try {
    await acquireFile(lockPath, opts);
    try {
      const set = new Set(mine ?? []);
      set.add(lockPath);
      return await held.run(set, fn);
    } finally {
      await rm(lockPath, { force: true });
    }
  } finally {
    release();
    if (inProcess.get(lockPath) === chained) inProcess.delete(lockPath);
  }
}

async function acquireFile(lockPath: string, opts: LockOptions): Promise<void> {
  const staleMs = opts.staleMs ?? 30_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
      if (age > staleMs) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`No se pudo obtener el bloqueo del store (${lockPath})`);
      await sleep(Math.min(200, 5 + attempt * 5));
    }
  }
}
