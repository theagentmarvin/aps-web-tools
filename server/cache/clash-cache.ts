/**
 * Disk cache for one ingested clash test.
 *
 * Layout (research §7 "cache per {container, modelSet, version, testId}"):
 *   .coordinator/cache/<projectId>/<modelSetId>/v<version>/<testId>/
 *     manifest.json      — key, counts, hashes, ingest options, resource types
 *     clashes.ndjson     — NormalizedClash, one per line
 *     documents.json     — ModelDocument[]
 *     elements.ndjson    — ElementProps, one per line (optional)
 * Writes are atomic (temp file + rename). Path segments are validated so a key
 * can never escape the cache root.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ElementProps, ModelDocument, NormalizedClash } from "../../core/types";

export const DEFAULT_CACHE_ROOT = ".coordinator/cache";
export const CACHE_SCHEMA_VERSION = 1;

export interface CacheKey {
  /** Project GUID (the `b.` prefix is stripped). */
  projectId: string;
  modelSetId: string;
  version: number;
  testId: string;
}

export interface CacheFileInfo {
  format: "json" | "ndjson";
  count: number;
  bytes: number;
  sha256: string;
}

export interface CacheManifest {
  schemaVersion: number;
  key: CacheKey;
  createdAt: string;
  updatedAt: string;
  files: Partial<Record<"clashes" | "documents" | "elements", CacheFileInfo>>;
  /** Free-form ingest metadata (dist unit, resource types, warnings…). */
  meta?: Record<string, unknown>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeSegment(v: string, what: string): string {
  if (!SAFE_SEGMENT.test(v) || v.includes("..")) throw new Error(`Invalid cache ${what}: ${JSON.stringify(v)}`);
  return v;
}

const FILES = {
  clashes: { name: "clashes.ndjson", format: "ndjson" },
  documents: { name: "documents.json", format: "json" },
  elements: { name: "elements.ndjson", format: "ndjson" },
} as const;

export class ClashCache {
  readonly root: string;

  constructor(root: string = DEFAULT_CACHE_ROOT, cwd: string = process.cwd()) {
    this.root = resolve(cwd, root);
  }

  dirFor(key: CacheKey): string {
    if (!Number.isInteger(key.version) || key.version < 0) throw new Error(`Invalid cache version: ${key.version}`);
    const project = key.projectId.startsWith("b.") ? key.projectId.slice(2) : key.projectId;
    return join(
      this.root,
      safeSegment(project, "projectId"),
      safeSegment(key.modelSetId, "modelSetId"),
      `v${key.version}`,
      safeSegment(key.testId, "testId"),
    );
  }

  private async writeAtomic(path: string, data: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data, "utf8");
    await rename(tmp, path);
  }

  async readManifest(key: CacheKey): Promise<CacheManifest | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dirFor(key), "manifest.json"), "utf8")) as CacheManifest;
    } catch {
      return undefined;
    }
  }

  async has(key: CacheKey): Promise<boolean> {
    const m = await this.readManifest(key);
    return !!m?.files.clashes && !!m.files.documents;
  }

  private async put(
    key: CacheKey,
    kind: keyof typeof FILES,
    rows: readonly unknown[],
    meta?: Record<string, unknown>,
  ): Promise<CacheFileInfo> {
    const dir = this.dirFor(key);
    await mkdir(dir, { recursive: true });
    const spec = FILES[kind];
    const text = spec.format === "ndjson" ? rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "") : JSON.stringify(rows);
    await this.writeAtomic(join(dir, spec.name), text);
    const info: CacheFileInfo = {
      format: spec.format,
      count: rows.length,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    };
    const now = new Date().toISOString();
    const prev = await this.readManifest(key);
    const manifest: CacheManifest = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      key,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      files: { ...prev?.files, [kind]: info },
      meta: { ...prev?.meta, ...meta },
    };
    await this.writeAtomic(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    return info;
  }

  /** Store the normalized test (clashes + documents) and optional metadata. */
  async writeTest(
    key: CacheKey,
    data: { clashes: readonly NormalizedClash[]; documents: readonly ModelDocument[]; meta?: Record<string, unknown> },
  ): Promise<CacheManifest> {
    await this.put(key, "documents", data.documents, data.meta);
    await this.put(key, "clashes", data.clashes);
    return (await this.readManifest(key))!;
  }

  async writeElements(key: CacheKey, elements: readonly ElementProps[]): Promise<CacheFileInfo> {
    return this.put(key, "elements", elements);
  }

  private async readRows<T>(key: CacheKey, kind: keyof typeof FILES): Promise<T[] | undefined> {
    let text: string;
    try {
      text = await readFile(join(this.dirFor(key), FILES[kind].name), "utf8");
    } catch {
      return undefined;
    }
    if (FILES[kind].format === "json") return JSON.parse(text) as T[];
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as T);
  }

  async readTest(key: CacheKey): Promise<{ clashes: NormalizedClash[]; documents: ModelDocument[]; manifest: CacheManifest } | undefined> {
    const manifest = await this.readManifest(key);
    if (!manifest) return undefined;
    const clashes = await this.readRows<NormalizedClash>(key, "clashes");
    const documents = await this.readRows<ModelDocument>(key, "documents");
    if (!clashes || !documents) return undefined;
    return { clashes, documents, manifest };
  }

  async readElements(key: CacheKey): Promise<ElementProps[] | undefined> {
    return this.readRows<ElementProps>(key, "elements");
  }

  async remove(key: CacheKey): Promise<void> {
    await rm(this.dirFor(key), { recursive: true, force: true });
  }

  async sizeBytes(key: CacheKey): Promise<number> {
    let total = 0;
    for (const f of [...Object.values(FILES).map((f) => f.name), "manifest.json"]) {
      total += await stat(join(this.dirFor(key), f)).then((s) => s.size).catch(() => 0);
    }
    return total;
  }
}
