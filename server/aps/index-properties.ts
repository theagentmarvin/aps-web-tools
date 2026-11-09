/**
 * Model Properties API (Index v2) flow — element metadata without a viewer.
 *
 * research §4 and §4.1:
 *   batch-status (create or get, idempotent) → poll by `retryAt` → `/fields`
 *   (NDJSON, gzip) → POST `/queries` for given lmvIds → poll → NDJSON rows →
 *   map with the fields dictionary → `ElementProps` keyed by lmvId.
 * Join key: clash `lvid`/`rvid` == Index `lmvId` (SVF1), within the seed file
 * of `ldid`/`rdid`. `verifyIdMapping` checks that on a sample (§4.1 residual risk).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { RawClashInstance } from "../../core/ingest/raw";
import type { ElementProps } from "../../core/types";
import { ApsError } from "./errors";
import { iterateNdjsonStream, safeGet } from "./download";
import { APS_BASE_URL, apsRequest, realSleep, retryDeps, seg, toContainerId, type ApsCtx } from "./http";
import {
  compileMapper,
  FieldDictionary,
  PROPERTY_ALIAS_KEYS,
  type MapRowContext,
  type PropertyMappingConfig,
} from "./property-mapping";
import type { IndexField, IndexManifest, IndexQueryStatus, IndexRow, IndexStatus } from "./types";

const BASE = "/construction/index/v2";

// ─────────────────────────────────────────────────────────────────────────────
// Alias configuration (rules/property-aliases.yaml)
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_PROPERTY_ALIASES_FILE = "rules/property-aliases.yaml";

const LengthUnitSchema = z.enum(["mm", "cm", "m", "ft", "in"]);
const PropertyAliasesFileSchema = z.object({
  version: z.literal(1),
  lengthUnitWhenMissing: LengthUnitSchema.default("mm"),
  bboxUnit: LengthUnitSchema.default("ft"),
  aliases: z.object(
    Object.fromEntries(PROPERTY_ALIAS_KEYS.map((k) => [k, z.array(z.string().min(1)).default([])])) as Record<
      (typeof PROPERTY_ALIAS_KEYS)[number],
      z.ZodDefault<z.ZodArray<z.ZodString>>
    >,
  ),
});

/** Parse and validate the YAML text of rules/property-aliases.yaml (fails closed). */
export function parsePropertyAliases(yamlText: string): PropertyMappingConfig {
  const parsed = PropertyAliasesFileSchema.safeParse(parseYaml(yamlText));
  if (!parsed.success) {
    throw new ApsError({ code: "config", detail: `property-aliases.yaml inválido: ${parsed.error.message}` });
  }
  return parsed.data;
}

/** Load rules/property-aliases.yaml (path relative to `cwd`). */
export async function loadPropertyAliases(
  file: string = DEFAULT_PROPERTY_ALIASES_FILE,
  cwd: string = process.cwd(),
): Promise<PropertyMappingConfig> {
  return parsePropertyAliases(await readFile(resolve(cwd, file), "utf8"));
}

function projectPath(projectId: string): string {
  return `${BASE}/projects/${seg(toContainerId(projectId))}`;
}

export interface IndexQuery {
  query: object;
  columns?: Record<string, string>;
}

export interface PollOptions {
  timeoutMs?: number;
  /** Used when the API gives no `retryAt`. */
  defaultIntervalMs?: number;
  /** Upper bound for one wait, even if `retryAt` is later (default 30 s). */
  maxIntervalMs?: number;
  now?: () => number;
}

function isTerminal(state: string): boolean {
  return state === "FINISHED" || state === "FAILED";
}

function nextDelay(retryAt: string | undefined, now: number, fallback: number, max = 30_000): number {
  const t = retryAt ? Date.parse(retryAt) : NaN;
  const d = Number.isFinite(t) ? t - now : fallback;
  return Math.min(max, Math.max(Math.min(1000, max), d));
}

async function poll<T extends { state: string; retryAt?: string }>(
  ctx: ApsCtx,
  first: T,
  refresh: () => Promise<T>,
  what: string,
  opts: PollOptions,
): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = ctx.sleep ?? realSleep;
  const deadline = now() + (opts.timeoutMs ?? 10 * 60_000);
  let cur = first;
  // research §4: the tutorial shows "RUNNING" too; any non-terminal state is pending.
  while (!isTerminal(cur.state)) {
    if (now() >= deadline) throw new ApsError({ code: "timeout", detail: `${what} sigue en ${cur.state}` });
    await sleep(nextDelay(cur.retryAt, now(), opts.defaultIntervalMs ?? 2000, opts.maxIntervalMs));
    cur = await refresh();
  }
  if (cur.state === "FAILED") throw new ApsError({ code: "job_failed", detail: `${what} FAILED` });
  return cur;
}

export async function getIndexStatus(ctx: ApsCtx, projectId: string, indexId: string): Promise<IndexStatus> {
  return apsRequest<IndexStatus>(ctx, "GET", `${projectPath(projectId)}/indexes/${seg(indexId)}`);
}

/**
 * POST `indexes:batch-status` (NOT `batchStatus`, research §4 gotchas) and poll
 * every returned index until FINISHED. Handles both the bare-array and the
 * `{indexes:[…]}` response shapes.
 */
export async function ensureIndexes(
  ctx: ApsCtx,
  projectId: string,
  versionUrns: readonly string[],
  q?: IndexQuery,
  opts: PollOptions & { forceRegenerate?: boolean } = {},
): Promise<IndexStatus[]> {
  const unique = [...new Set(versionUrns)];
  if (unique.length === 0) return [];
  if (unique.length > 1000) throw new ApsError({ code: "bad_request", detail: "batch-status admite máx. 1000 versiones" });
  const data = await apsRequest<IndexStatus[] | { indexes?: IndexStatus[] }>(
    ctx,
    "POST",
    `${projectPath(projectId)}/indexes:batch-status`,
    {
      body: { versions: unique.map((versionUrn) => ({ versionUrn, ...(q ?? {}) })) },
      headers: opts.forceRegenerate ? { "x-ads-force-regenerate-cache": "true" } : undefined,
    },
  );
  const list = Array.isArray(data) ? data : (data?.indexes ?? []);
  if (list.length === 0) throw new ApsError({ code: "invalid_response", detail: "batch-status sin índices" });
  const out: IndexStatus[] = [];
  for (const idx of list) {
    out.push(await poll(ctx, idx, () => getIndexStatus(ctx, projectId, idx.indexId), `índice ${idx.indexId}`, opts));
  }
  return out;
}

/** Find the index covering a seed version URN. */
export function indexForVersion(indexes: readonly IndexStatus[], versionUrn: string): IndexStatus | undefined {
  return indexes.find((i) => i.versionUrns?.includes(versionUrn)) ?? (indexes.length === 1 ? indexes[0] : undefined);
}

/** Stream an authenticated NDJSON resource from the APS host, following 303s safely. */
async function* apsNdjson<T>(ctx: ApsCtx, path: string): AsyncGenerator<T> {
  const base = ctx.baseUrl ?? APS_BASE_URL;
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const token = await ctx.token.getAccessToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (ctx.region) headers["x-ads-region"] = ctx.region;
  const res = await safeGet(url, retryDeps(ctx), { headers, authOrigin: new URL(base).origin });
  if (!res.body) return;
  yield* iterateNdjsonStream<T>(res.body);
}

export async function getIndexManifest(ctx: ApsCtx, projectId: string, indexId: string): Promise<IndexManifest> {
  return apsRequest<IndexManifest>(ctx, "GET", `${projectPath(projectId)}/indexes/${seg(indexId)}/manifest`);
}

/** `/fields` NDJSON (gzip) → field list. */
export async function getIndexFields(ctx: ApsCtx, projectId: string, indexId: string): Promise<IndexField[]> {
  const out: IndexField[] = [];
  for await (const f of apsNdjson<IndexField>(ctx, `${projectPath(projectId)}/indexes/${seg(indexId)}/fields`)) out.push(f);
  return out;
}

/** Manifest view id for a document's `viewableGuid` (to filter rows by `views`). */
export function resolveManifestViewId(manifest: IndexManifest, seedVersionUrn: string, viewableGuid: string): string | undefined {
  const seed = manifest.seedFiles.find((s) => s.versionUrn === seedVersionUrn) ?? manifest.seedFiles[0];
  return seed?.views?.find((v) => v.viewableGuid === viewableGuid)?.id;
}

/**
 * Filter on a set of lmvIds. Syntax as given in research §4 (T:mpref:
 * `{"$in": {"s.lmvId": [..]}}`). Kept in one place so it is easy to adjust if
 * the live API disagrees.
 */
export function lmvIdQuery(lmvIds: readonly number[]): object {
  return { $in: { "s.lmvId": [...lmvIds] } };
}

/** POST a query, poll it, then stream its NDJSON result rows (research §4 table). */
export async function* queryIndex(
  ctx: ApsCtx,
  projectId: string,
  indexId: string,
  q: IndexQuery,
  opts: PollOptions = {},
): AsyncGenerator<IndexRow> {
  const idxPath = `${projectPath(projectId)}/indexes/${seg(indexId)}`;
  const started = await apsRequest<IndexQueryStatus>(ctx, "POST", `${idxPath}/queries`, { body: q });
  const done = await poll(
    ctx,
    started,
    () => apsRequest<IndexQueryStatus>(ctx, "GET", `${idxPath}/queries/${seg(started.queryId)}`),
    `consulta ${started.queryId}`,
    opts,
  );
  yield* apsNdjson<IndexRow>(ctx, `${idxPath}/queries/${seg(done.queryId)}/properties`);
}

export interface FetchElementsOptions extends MapRowContext, PollOptions {
  /** From {@link loadPropertyAliases}. */
  config: PropertyMappingConfig;
  /** Keep only rows visible in this manifest view id (research §4.1 resolution chain). */
  viewId?: string;
  /** lmvIds per query. Default 1000. */
  chunkSize?: number;
}

/**
 * Query rows for the given lmvIds of ONE index (one seed file) and map them to
 * ElementProps keyed by lmvId.
 */
export async function fetchElementProps(
  ctx: ApsCtx,
  projectId: string,
  indexId: string,
  lmvIds: readonly number[],
  fields: readonly IndexField[] | FieldDictionary,
  opts: FetchElementsOptions,
): Promise<Map<number, ElementProps>> {
  const dict = fields instanceof FieldDictionary ? fields : new FieldDictionary(fields);
  const map = compileMapper(dict, opts.config, {
    documentId: opts.documentId,
    modelFile: opts.modelFile,
    documentName: opts.documentName,
  });
  const ids = [...new Set(lmvIds)].sort((a, b) => a - b);
  const size = opts.chunkSize ?? 1000;
  const out = new Map<number, ElementProps>();
  for (let i = 0; i < ids.length; i += size) {
    const chunk = ids.slice(i, i + size);
    for await (const row of queryIndex(ctx, projectId, indexId, { query: lmvIdQuery(chunk) }, opts)) {
      if (opts.viewId && !(row.views ?? []).includes(opts.viewId)) continue;
      out.set(row.lmvId, map(row));
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// verifyIdMapping (research §4.1 residual risk)
// ─────────────────────────────────────────────────────────────────────────────

export interface IdMappingReport {
  /** Key to use for the join. */
  key: "lmvId" | "svf2Id";
  matchRate: number;
  lmvIdRate: number;
  svf2IdRate: number;
  sampled: number;
  /** True when the chosen key reaches `threshold`. */
  ok: boolean;
  /** Spanish message to log loudly when not ok or when falling back to svf2Id. */
  warning?: string;
}

function isGoodRow(e: ElementProps | undefined): boolean {
  return !!e && (e.views?.length ?? 0) > 0 && !!e.category;
}

/**
 * For a sample of clash instances, check that `lvid`/`rvid` resolve to a row
 * with non-empty `views` and a category, first by `lmvId`, then by `svf2Id`.
 * `tables` maps clash document id → (lmvId → ElementProps).
 * If the lmvId match rate is below `threshold` (default 0.9) and svf2Id is
 * better, recommend svf2Id and return a warning.
 */
export function verifyIdMapping(
  sample: readonly RawClashInstance[],
  tables: ReadonlyMap<number, ReadonlyMap<number, ElementProps>>,
  opts: { sampleSize?: number; threshold?: number } = {},
): IdMappingReport {
  const threshold = opts.threshold ?? 0.9;
  const picked = sample.slice(0, opts.sampleSize ?? 50);
  const svf2Tables = new Map<number, Map<number, ElementProps>>();
  for (const [doc, t] of tables) {
    const m = new Map<number, ElementProps>();
    for (const e of t.values()) if (e.svf2Id !== undefined) m.set(e.svf2Id, e);
    svf2Tables.set(doc, m);
  }
  let probes = 0;
  let lmvHits = 0;
  let svf2Hits = 0;
  for (const inst of picked) {
    for (const [doc, id] of [
      [inst.ldid, inst.lvid],
      [inst.rdid, inst.rvid],
    ] as const) {
      probes++;
      if (isGoodRow(tables.get(doc)?.get(id))) lmvHits++;
      if (isGoodRow(svf2Tables.get(doc)?.get(id))) svf2Hits++;
    }
  }
  const lmvIdRate = probes ? lmvHits / probes : 0;
  const svf2IdRate = probes ? svf2Hits / probes : 0;
  const useSvf2 = lmvIdRate < threshold && svf2IdRate > lmvIdRate;
  const key = useSvf2 ? "svf2Id" : "lmvId";
  const matchRate = useSvf2 ? svf2IdRate : lmvIdRate;
  const ok = probes > 0 && matchRate >= threshold;
  let warning: string | undefined;
  if (useSvf2) {
    warning = `ATENCIÓN: lvid/rvid no coinciden con lmvId (${pct(lmvIdRate)}); se usará svf2Id (${pct(svf2IdRate)}). Verifique el espacio de coordinación (research §4.1).`;
  } else if (!ok) {
    warning = `ATENCIÓN: solo ${pct(matchRate)} de los elementos del clash se encontraron en el índice de propiedades.`;
  }
  return { key, matchRate, lmvIdRate, svf2IdRate, sampled: probes, ok, warning };
}

function pct(r: number): string {
  return `${Math.round(r * 1000) / 10}%`;
}
