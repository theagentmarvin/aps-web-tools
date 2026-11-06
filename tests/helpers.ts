/** Shared test helpers: fixture loading and a recording mock fetch. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ElementProps } from "../core/types";
import type { RawClashDocumentFile, RawClashFile, RawClashInstanceFile, RawModelSetVersion } from "../core/ingest/raw";
import type { ApsCtx, FetchFn, TokenProvider } from "../server/aps/http";
import { compileMapper, FieldDictionary, type PropertyMappingConfig } from "../server/aps/property-mapping";
import { parsePropertyAliases } from "../server/aps/index-properties";
import { parseNdjson } from "../server/aps/download";
import type { IndexField, IndexRow } from "../server/aps/types";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");
export const ROOT = join(HERE, "..");

export function fixtureBytes(rel: string): Buffer {
  return readFileSync(join(FIXTURES, rel));
}
export function fixtureJson<T>(rel: string): T {
  return JSON.parse(fixtureBytes(rel).toString("utf8")) as T;
}

export interface Truth {
  containerId: string;
  modelSetId: string;
  tests: Record<"41" | "42", string>;
  documents: Array<{ id: number; seed: string; fileName: string; viewableName: string }>;
  counts: { pool: number; v41: number; v42: number };
  expectedDiff: {
    new: string[];
    persisting: string[];
    resolved: string[];
    element_deleted: string[];
    reappeared: string[];
    matchedByPairKey: Array<{ prevId: string; nextId: string }>;
  };
  patterns: Record<string, string>;
  deletedExternalIds: string[];
  index: Record<string, { indexId: string; seed: string; file: string; rows: number; views: Array<{ id: string; viewableGuid: string; viewableName: string }> }>;
}
export const truth = (): Truth => fixtureJson<Truth>("fixture-truth.json");

export function rawVersion(v: 41 | 42): {
  clashes: RawClashFile;
  instances: RawClashInstanceFile;
  documents: RawClashDocumentFile;
  modelSetVersion: RawModelSetVersion;
} {
  return {
    clashes: fixtureJson(`mc/v${v}/scope-version-clash.json`),
    instances: fixtureJson(`mc/v${v}/scope-version-clash-instance.json`),
    documents: fixtureJson(`mc/v${v}/scope-version-document.json`),
    modelSetVersion: fixtureJson(`mc/v${v}/modelset-version.json`),
  };
}

export const aliasConfig = (): PropertyMappingConfig =>
  parsePropertyAliases(readFileSync(join(ROOT, "rules", "property-aliases.yaml"), "utf8"));

export const fields = (): IndexField[] => parseNdjson<IndexField>(fixtureBytes("index/fields.ndjson").toString("utf8"));

/** documentId → lmvId → ElementProps for one model set version, from the index fixtures. */
export function elementTables(v: 41 | 42): {
  tables: Map<number, Map<number, ElementProps>>;
  externalIds: Set<string>;
} {
  const t = truth();
  const msv = rawVersion(v).modelSetVersion;
  const dict = new FieldDictionary(fields());
  const config = aliasConfig();
  const tables = new Map<number, Map<number, ElementProps>>();
  const externalIds = new Set<string>();
  const docs = rawVersion(v).documents.documents;
  for (const d of docs) {
    const dv = msv.documentVersions.find((x) => x.versionUrn === d.urn && x.viewableName === d.viewableName)!;
    const entry = t.index[dv.originalSeedFileVersionUrn!];
    const rows = parseNdjson<IndexRow>(fixtureBytes(entry.file).toString("utf8"));
    const map = compileMapper(dict, config, {
      documentId: d.id,
      modelFile: dv.documentLineage.lineageUrn,
      documentName: dv.originalSeedFileVersionName,
    });
    const table = new Map<number, ElementProps>();
    for (const r of rows) {
      table.set(r.lmvId, map(r));
      if (r.externalId) externalIds.add(r.externalId);
    }
    tables.set(d.id, table);
  }
  return { tables, externalIds };
}

// ── mock fetch ───────────────────────────────────────────────────────────

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type Route = (url: URL, call: Call) => Response | Promise<Response> | undefined;

/** Fetch that records calls and answers from `routes` (first non-undefined wins). */
export function mockFetch(...routes: Route[]): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = {
      url: input,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : init?.body ? new TextDecoder().decode(init.body as Uint8Array) : undefined,
    };
    calls.push(call);
    for (const r of routes) {
      const res = await r(new URL(input), call);
      if (res) return res;
    }
    return new Response(JSON.stringify({ title: "no route", detail: input }), { status: 404 });
  };
  return { fetch: fetchFn, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const bytes = (b: Uint8Array, status = 200): Response => new Response(b, { status });

export function staticToken(token = "test-token"): TokenProvider & { forced: number } {
  const t = {
    forced: 0,
    async getAccessToken(opts?: { forceRefresh?: boolean }) {
      if (opts?.forceRefresh) t.forced++;
      return t.forced ? `${token}-${t.forced}` : token;
    },
  };
  return t;
}

export function testCtx(fetchFn: FetchFn, extra: Partial<ApsCtx> = {}): ApsCtx & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    token: staticToken(),
    fetch: fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    sleeps,
    ...extra,
  };
}
