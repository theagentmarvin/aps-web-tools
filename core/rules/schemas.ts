/**
 * Zod schemas for the coordinator-editable rule files. They follow the DSL
 * documented in the headers of rules/*.yaml exactly; every object is strict,
 * so unknown keys are load errors. Matcher bodies are validated by the
 * matcher compiler (./matcher.ts), which knows the field and set names.
 */
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Shared enums (classification-rules.yaml §2)
// ─────────────────────────────────────────────────────────────────────────────

export const VALIDITIES = ["real", "false_positive", "tolerated", "needs_info"] as const;
export const NATURES = ["hard", "clearance", "duplicate", "workflow"] as const;
export const ROOT_CAUSES = [
  "design_coordination", "routing_conflict", "missing_opening", "modeling_error", "lod_mismatch",
  "outdated_model", "duplicate_model", "model_hygiene", "not_applicable",
] as const;
export const SEVERITIES = ["critical", "high", "medium", "low", "none"] as const;
export const SUGGESTED_ACTIONS = [
  "close_not_issue", "mark_reviewed", "create_issue", "hygiene_issue", "request_info", "escalate",
] as const;

export type Validity = (typeof VALIDITIES)[number];
export type Nature = (typeof NATURES)[number];
export type RootCause = (typeof ROOT_CAUSES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type SuggestedAction = (typeof SUGGESTED_ACTIONS)[number];

/** A matcher body: validated structurally by the matcher compiler. */
const Matcher = z.record(z.string(), z.unknown());

// ─────────────────────────────────────────────────────────────────────────────
// discipline-matrix.yaml
// ─────────────────────────────────────────────────────────────────────────────

const Discipline = z.strictObject({
  code: z.string().regex(/^[A-Z]{2,6}$/),
  group: z.string().min(1),
  criticality: z.number().min(0).max(1),
  es: z.string(),
  en: z.string(),
  aliases: z.array(z.string()),
});

const FileNamePattern = z
  .strictObject({
    discipline: z.string(),
    tokens: z.array(z.string()).optional(),
    regex: z.string().optional(),
  })
  .refine((p) => p.tokens !== undefined || p.regex !== undefined, { message: "needs `tokens` or `regex`" });

const ElementClassDef = z.strictObject({
  class: z.string().regex(/^[a-z][a-z0-9_]*$/),
  moveRank: z.union([z.number(), z.null(), z.literal("inherit")]),
  when: Matcher,
});

const PairTokens = z.tuple([z.string(), z.string()]);

export const DisciplineMatrixSchema = z.strictObject({
  version: z.number().int().positive(),
  disciplines: z.array(Discipline).min(1),
  groups: z.array(z.string()).min(1),
  categoryPrefixStrip: z.array(z.string()),
  categoryAliases: z.record(z.string(), z.array(z.string())),
  categoryLabelsEs: z.record(z.string(), z.string()),
  categorySets: z.record(z.string(), z.array(z.string())),
  detection: z.strictObject({
    iso19650: z.strictObject({
      modelTypes: z.array(z.string()),
      roleCodes: z.record(z.string(), z.string()),
    }),
    fileNamePatterns: z.array(FileNamePattern),
    refinableFrom: z.array(z.string()),
    systemRefinement: z.array(z.strictObject({ discipline: z.string(), when: Matcher })),
    categoryDefaults: z.record(z.string(), z.array(z.string())),
  }),
  systemClassificationAliases: z.record(z.string(), z.array(z.string())),
  derivedFlags: z.array(z.strictObject({ flag: z.string().regex(/^is[A-Z][A-Za-z]*$/), when: Matcher })),
  foreignExemptCategories: z.array(z.string()),
  elementClasses: z.array(ElementClassDef).min(1),
  classSets: z.record(z.string(), z.array(z.string())),
  whoMoves: z.strictObject({
    tieThreshold: z.number().min(0),
    hierarchy_note: z.string().optional(),
    overrides: z.array(
      z.strictObject({
        classes: PairTokens,
        mover: z.string(),
        approver: z.string().optional(),
        note: z.string().optional(),
      }),
    ),
  }),
  tolerances: z.strictObject({
    default: z.strictObject({ hardMm: z.number().min(0), clearanceMm: z.number().min(0) }),
    entries: z.array(
      z
        .strictObject({
          classes: PairTokens.optional(),
          disciplines: PairTokens.optional(),
          hardMm: z.number().min(0),
          clearanceMm: z.number().min(0),
          note: z.string().optional(),
        })
        .refine((e) => e.classes !== undefined || e.disciplines !== undefined, {
          message: "needs `classes` and/or `disciplines`",
        }),
    ),
  }),
});
export type DisciplineMatrix = z.infer<typeof DisciplineMatrixSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// classification-rules.yaml
// ─────────────────────────────────────────────────────────────────────────────

const When = z.strictObject({
  clash: Matcher.optional(),
  a: Matcher.optional(),
  b: Matcher.optional(),
  both: Matcher.optional(),
});

const Then = z.strictObject({
  validity: z.enum(VALIDITIES),
  nature: z.enum(NATURES),
  rootCause: z.enum(ROOT_CAUSES),
  responsibleDiscipline: z.string(),
  secondaryDiscipline: z.string().optional(),
  severity: z.enum(SEVERITIES),
  confidence: z.number().min(0).max(1),
  suggestedAction: z.enum(SUGGESTED_ACTIONS),
  humanReview: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  rationale: z.string().min(1),
});

export const ClassificationRulesSchema = z.strictObject({
  version: z.number().int().positive(),
  rules: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Z]{2,4}-\d{3}$/, "rule id must match [A-Z]{2,4}-\\d{3}"),
        name: z.string().min(1),
        /** Spanish display name (titles, issues). Optional; the loader warns when missing. */
        nameEs: z.string().min(1).optional(),
        when: When,
        then: Then,
      }),
    )
    .min(1),
  annotations: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Z]{2,4}-\d{3}$/),
        when: When,
        then: z.strictObject({ tags: z.array(z.string()).min(1), note: z.string().optional() }),
      }),
    )
    .default([]),
});
export type ClassificationRules = z.infer<typeof ClassificationRulesSchema>;
export type RuleThen = z.infer<typeof Then>;

// ─────────────────────────────────────────────────────────────────────────────
// priority-scoring.yaml
// ─────────────────────────────────────────────────────────────────────────────

export const FACTOR_NAMES = [
  "severity", "disciplineCriticality", "penetration", "elementSize", "zoneCriticality", "groupCount", "scheduleProximity",
] as const;
export type FactorName = (typeof FACTOR_NAMES)[number];

const Points = z
  .array(z.tuple([z.number(), z.number()]))
  .min(1)
  .refine((pts) => pts.every((p, i) => i === 0 || p[0] > pts[i - 1]![0]), { message: "points must be sorted by x (strictly increasing)" });

export const BAND_NAMES = ["P1", "P2", "P3", "P4"] as const;
export type BandName = (typeof BAND_NAMES)[number] | "NONE";

export const PriorityScoringSchema = z.strictObject({
  version: z.number().int().positive(),
  weights: z.strictObject({
    severity: z.number().min(0),
    disciplineCriticality: z.number().min(0),
    penetration: z.number().min(0),
    elementSize: z.number().min(0),
    zoneCriticality: z.number().min(0),
    groupCount: z.number().min(0),
    scheduleProximity: z.number().min(0),
  }),
  factors: z.strictObject({
    severity: z.strictObject({
      map: z.strictObject({ critical: z.number(), high: z.number(), medium: z.number(), low: z.number(), none: z.number() }),
      missing: z.number(),
    }),
    disciplineCriticality: z.strictObject({
      combine: z.strictObject({ maxWeight: z.number(), minWeight: z.number() }),
      missing: z.number(),
    }),
    penetration: z.strictObject({ points: Points, clearanceValue: z.number(), missing: z.number() }),
    elementSize: z.strictObject({ points: Points, missing: z.number() }),
    zoneCriticality: z.strictObject({
      patterns: z.array(z.strictObject({ match: z.string(), value: z.number() })),
      missing: z.number(),
    }),
    groupCount: z.strictObject({ saturation: z.number().gt(1), missing: z.number() }),
    scheduleProximity: z.strictObject({ points: Points, missing: z.number() }),
  }),
  overrides: z.array(
    z.strictObject({
      id: z.string(),
      when: z.record(z.string(), z.unknown()),
      set: z.strictObject({ score: z.number().min(0).max(100), band: z.enum(["P1", "P2", "P3", "P4", "NONE"]) }).optional(),
      add: z.number().optional(),
      floor: z.number().optional(),
      cap: z.number().optional(),
      note: z.string().optional(),
    }),
  ),
  bands: z
    .array(
      z.strictObject({
        band: z.enum(BAND_NAMES),
        minScore: z.number().min(0).max(100),
        es: z.string(),
        targetBusinessDays: z.number().int().positive(),
      }),
    )
    .min(1),
});
export type PriorityScoring = z.infer<typeof PriorityScoringSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// holidays-cl.yaml
// ─────────────────────────────────────────────────────────────────────────────

export const HolidaysSchema = z.strictObject({
  version: z.number().int().positive(),
  country: z.string(),
  note: z.string().optional(),
  holidays: z.array(
    z.strictObject({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD (quote it in YAML)"),
      name: z.string(),
    }),
  ),
});
export type Holidays = z.infer<typeof HolidaysSchema>;
