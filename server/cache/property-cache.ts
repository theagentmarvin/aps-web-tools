/**
 * Per-document-version cache of Model Properties (Index v2) rows.
 *
 *   .coordinator/cache/props/<sha1(seedVersionUrn)>/
 *     fields.json     the index field dictionary
 *     views.json      manifest view ids by viewableGuid
 *     rows.ndjson     IndexRow per line (append-only)
 *     absent.json     lmvIds the index does not return (not re-queried)
 *
 * A seed file version never changes, so when another model set version reuses
 * an unchanged document, its rows come from here and only new lmvIds are queried.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IndexField, IndexRow } from "../aps/types";

export interface CachedProps {
  fields?: IndexField[];
  views?: Record<string, string>;
  rows: Map<number, IndexRow>;
  absent: Set<number>;
}

export class PropertyRowCache {
  constructor(readonly root: string) {}

  dir(seedVersionUrn: string): string {
    return join(this.root, "props", createHash("sha1").update(seedVersionUrn).digest("hex"));
  }

  async get(seedVersionUrn: string): Promise<CachedProps> {
    const d = this.dir(seedVersionUrn);
    const read = async <T>(f: string): Promise<T | undefined> => {
      try {
        return JSON.parse(await readFile(join(d, f), "utf8")) as T;
      } catch {
        return undefined;
      }
    };
    const rows = new Map<number, IndexRow>();
    try {
      for (const line of (await readFile(join(d, "rows.ndjson"), "utf8")).split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as IndexRow;
          rows.set(r.lmvId, r);
        } catch {
          // torn line: ignore
        }
      }
    } catch {
      // no rows yet
    }
    const fields = await read<IndexField[]>("fields.json");
    const views = await read<Record<string, string>>("views.json");
    return { ...(fields ? { fields } : {}), ...(views ? { views } : {}), rows, absent: new Set(await read<number[]>("absent.json")) };
  }

  async putMeta(seedVersionUrn: string, meta: { fields?: IndexField[]; views?: Record<string, string> }): Promise<void> {
    const d = this.dir(seedVersionUrn);
    await mkdir(d, { recursive: true });
    if (meta.fields) await writeFile(join(d, "fields.json"), JSON.stringify(meta.fields));
    if (meta.views) await writeFile(join(d, "views.json"), JSON.stringify(meta.views));
  }

  async addRows(seedVersionUrn: string, rows: readonly IndexRow[], absent: readonly number[], prevAbsent: ReadonlySet<number>): Promise<void> {
    const d = this.dir(seedVersionUrn);
    await mkdir(d, { recursive: true });
    if (rows.length) await appendFile(join(d, "rows.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    if (absent.length) await writeFile(join(d, "absent.json"), JSON.stringify([...new Set([...prevAbsent, ...absent])]));
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
