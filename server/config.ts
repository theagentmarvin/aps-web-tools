/**
 * Coordinator policy config (docs/ai/harness-design.md §3.1, §4.1, §4.2).
 *
 * `coordinator.config.json` (committed defaults) deep-merged with the
 * git-ignored `coordinator.config.local.json`. The autonomy level is HARD
 * CAPPED at {@link MAX_SUPPORTED_LEVEL} (L1 in v1) whatever the files say:
 * `effectiveLevel = min(configured, MAX_SUPPORTED_LEVEL)`.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Template used when `coordinator.config.json` is absent (copy it to the repo root to customise). */
export const TEMPLATE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "templates", "coordinator.config.json");

/** v1 ships propose-only (L1). Raising this is a code change, never a config change. */
export const MAX_SUPPORTED_LEVEL = 1 as const;

export type AutonomyLevel = 0 | 1 | 2 | 3;

const Level = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

export const ConfigSchema = z.object({
  autonomy: z
    .object({
      level: Level.default(1),
      approvalExpiryDays: z.number().min(0.001).max(30).default(7),
      requireDryRunBeforeApply: z.boolean().default(true),
    })
    .prefault({}),
  classification: z
    .object({
      /**
       * Optional overrides of core/group DEFAULT_REVIEW_POLICY (the engine owns the
       * defaults; keys follow ReviewPolicy: real, false_positive, duplicate, tolerance).
       */
      autoAccept: z
        .object({
          real: z.number().min(0).max(1.01).optional(),
          false_positive: z.number().min(0).max(1.01).optional(),
          duplicate: z.number().min(0).max(1.01).optional(),
          tolerance: z.number().min(0).max(1.01).optional(),
        })
        .default({})
        .transform((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, number>),
      reviewFloor: z.number().min(0).max(1).optional(),
      alwaysReview: z
        .object({
          severity: z.array(z.string()).optional(),
          minClashCount: z.number().int().optional(),
          unmatched: z.boolean().optional(),
          rulesConflict: z.boolean().optional(),
        })
        .default({})
        .transform((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))),
      bulkClosureMax: z.number().int().optional(),
      /** propose_status_change actions the agent may use to propose a closure. */
      llmMayClose: z.array(z.string()).default(["close_not_issue", "mark_reviewed"]),
      qaSampleRate: z.number().min(0).max(1).default(0.05),
    })
    .prefault({}),
  /** Per discipline-pair tolerance overrides in mm, e.g. {"CLI×EST": {"hardMm": 10}}. Passed to the engine. */
  tolerances: z.record(z.string(), z.object({ hardMm: z.number().optional(), clearanceMm: z.number().optional() })).default({}),
  ui: z
    .object({
      confidenceBands: z.object({ high: z.number().default(0.85), medium: z.number().default(0.6) }).prefault({}),
      baseUrl: z.string().default("http://localhost:3000"),
    })
    .prefault({}),
  agent: z
    .object({
      triageBatchSize: z.number().int().default(20),
      maxParallelTriagers: z.number().int().default(3),
      maxResponseTokens: z.number().int().min(500).max(20000).default(6000),
    })
    .prefault({}),
  policies: z
    .object({
      lowRiskRuleAllowlist: z.array(z.string()).default([]),
      dailyApplyCap: z.number().int().default(500),
    })
    .prefault({}),
  apply: z
    .object({
      /** Local budget per project and operation; ACC allows 250 jobs/h (research §7). */
      jobsPerHourPerOperation: z.number().int().min(1).max(250).default(200),
      /** Max groups in one clashes:assign / clashes:close POST body. */
      maxGroupsPerRequest: z.number().int().min(1).max(500).default(100),
      jobTimeoutMs: z.number().int().default(5 * 60_000),
    })
    .prefault({}),
  issues: z
    .object({
      urlAllowlist: z.array(z.string()).default(["acc.autodesk.com"]),
      defaultDueInDays: z.number().int().default(7),
      /** ACC issue type / subtype used by clashes:assign when the draft names none. */
      issueTypeId: z.string().optional(),
      issueSubtypeId: z.string().optional(),
    })
    .prefault({}),
  approver: z
    .object({
      /** Fallback approver display name when the APS profile is unavailable. */
      name: z.string().optional(),
    })
    .prefault({}),
  language: z.enum(["es", "en"]).default("es"),
});

export type CoordinatorConfig = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  config: CoordinatorConfig;
  /** Level written in the files (after merge). */
  configuredLevel: AutonomyLevel;
  /** min(configured, MAX_SUPPORTED_LEVEL). */
  effectiveLevel: AutonomyLevel;
  /** Which files contributed, for get_session_status. */
  sources: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge: objects merge, arrays and scalars from `over` replace. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

function readJson(path: string): unknown | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`Config inválida en ${path}: ${(err as Error).message}`);
  }
}

export function effectiveLevelOf(configured: AutonomyLevel): AutonomyLevel {
  return Math.min(configured, MAX_SUPPORTED_LEVEL) as AutonomyLevel;
}

/**
 * Load and validate the config. `COORDINATOR_CONFIG` may point to the committed
 * file; the local override always sits next to it.
 */
export function loadConfig(root: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const mainPath = env.COORDINATOR_CONFIG ? resolve(root, env.COORDINATOR_CONFIG) : join(root, "coordinator.config.json");
  const localPath = mainPath.replace(/coordinator\.config\.json$/, "coordinator.config.local.json");
  const sources: string[] = [];
  let main = readJson(mainPath);
  if (main !== undefined) sources.push("coordinator.config.json");
  else {
    // Committed defaults not installed yet: use the template shipped with the server.
    main = readJson(TEMPLATE_PATH);
    if (main !== undefined) sources.push("server/templates/coordinator.config.json");
  }
  const local = readJson(localPath);
  if (local !== undefined) sources.push("coordinator.config.local.json");
  const merged = deepMerge(main ?? {}, local ?? {});
  if (isPlainObject(merged)) delete merged.$schema;
  const config = ConfigSchema.parse(merged);
  const configuredLevel = config.autonomy.level as AutonomyLevel;
  return { config, configuredLevel, effectiveLevel: effectiveLevelOf(configuredLevel), sources };
}
