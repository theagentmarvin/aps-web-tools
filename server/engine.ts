/**
 * Integration of the deterministic engine (core/pipeline.ts runCoordination)
 * with the server records. The engine vocabulary is binding (orchestrator
 * ruling): validity real | false_positive | tolerated | needs_info, nature
 * hard | clearance | duplicate | workflow, severity incl. none, group ids
 * G-<10 hex>. Only the strategy gets a coarse alias for the MCP contract:
 *   nonissue|hygiene|needsinfo → by_root_cause; hub-*|single → by_element;
 *   run → by_system_run; zone → by_level_zone (engineStrategy keeps the original).
 */
import type { ClassifiedClash } from "../core/classified";
import type { ClashGroup as EngineGroup } from "../core/group";
import { DEFAULT_REVIEW_POLICY, type ReviewPolicy } from "../core/group/review";
import { buildIssueDraft } from "../core/issues";
import { runCoordination } from "../core/pipeline";
import type { CompiledRuleSet } from "../core/rules/load";
import type { ElementProps, ModelDocument, NormalizedClash } from "../core/types";
import type { CoordinatorConfig } from "./config";
import { loadRulesFromDisk } from "./rules-loader";
import { sanitizeModelText } from "./sanitize";
import type {
  AccStatus,
  ClashRecord,
  ConfidenceBand,
  ElementSideRecord,
  GroupRecord,
  GroupStrategy,
  TestDocumentRecord,
  Validity,
} from "./store/types";

export const ENGINE_NAME = "core/pipeline";
export const ENGINE_VERSION = "1";

export function mapBand(b: string): 1 | 2 | 3 | 4 {
  return b === "P1" ? 1 : b === "P2" ? 2 : b === "P3" ? 3 : 4;
}

export function mapStrategy(s: string): GroupStrategy {
  switch (s) {
    case "run":
      return "by_system_run";
    case "zone":
      return "by_level_zone";
    case "hub-mover":
    case "hub-fixed":
    case "single":
      return "by_element";
    default:
      return "by_root_cause";
  }
}

/** Validities whose groups may be closed as "not an issue" (duplicates are false_positive + nature duplicate). */
export const CLOSABLE: readonly Validity[] = ["false_positive", "tolerated"];

let rulesCache: { rs: CompiledRuleSet; at: number } | undefined;
/** CompiledRuleSet.warnings are logged once per process (stderr). */
let warnedRules = false;

/** Compile rules/ (cached for 5 s so repeated calls in one request are cheap; edits are picked up). */
export function loadRules(dir?: string): CompiledRuleSet {
  if (!dir && rulesCache && Date.now() - rulesCache.at < 5000) return rulesCache.rs;
  const rs = loadRulesFromDisk(dir ? { dir } : {});
  if (!dir) rulesCache = { rs, at: Date.now() };
  if (!dir && !warnedRules && rs.warnings?.length) {
    warnedRules = true;
    process.stderr.write(`[coord] reglas: ${rs.warnings.length} advertencias\n${rs.warnings.map((w) => `  - ${w}`).join("\n")}\n`);
  }
  return rs;
}

export function reviewPolicyFrom(cfg: CoordinatorConfig): ReviewPolicy {
  const c = cfg.classification;
  const d = DEFAULT_REVIEW_POLICY;
  return {
    ...d,
    autoAccept: { ...d.autoAccept, ...c.autoAccept },
    reviewFloor: c.reviewFloor ?? d.reviewFloor,
    alwaysReview: { ...d.alwaysReview, ...(c.alwaysReview as Partial<ReviewPolicy["alwaysReview"]>) },
    bulkClosureMax: c.bulkClosureMax ?? d.bulkClosureMax,
  };
}

export interface EngineInput {
  clashes: readonly NormalizedClash[];
  elements: readonly ElementProps[];
  documents: readonly ModelDocument[];
  config: CoordinatorConfig;
  rules?: CompiledRuleSet;
  /** Project level aliases (config levelMap) → CoordinationOptions.levelMap. */
  levelMap?: Readonly<Record<string, string>>;
  /** Extra tags per MC clash id (e.g. `regresion`). */
  extraTags?: (c: NormalizedClash) => readonly string[] | undefined;
  /** For engine-built issue skeletons (due dates). */
  publishDate?: string;
  testId?: string;
  modelSetVersion?: number;
}

export interface EngineOutput {
  groups: GroupRecord[];
  clashes: ClashRecord[];
  documents: TestDocumentRecord[];
  ruleset: { version: string; rules: number; hash: string };
  unmatchedClashes: number;
  topRules: Array<{ ruleId: string; hits: number }>;
  byStrategy: Record<string, number>;
  /** Engine issue skeletons for `real` groups (groupId → draft). */
  issueDrafts: Record<string, { title: string; description: string; responsibleDiscipline: string; dueDate: string; viewpointClashId?: string }>;
}

const STATUS_RANK: AccStatus[] = ["active", "reviewed", "resolved", "closed"];

function accStatus(s: string): AccStatus {
  return (STATUS_RANK as string[]).includes(s) ? (s as AccStatus) : "active";
}

function bboxCenter(el?: ElementProps): { x: number; y: number; z: number } | undefined {
  if (!el?.bbox) return undefined;
  const { min, max } = el.bbox;
  return { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
}

function sizeHintOf(el?: ElementProps): string | undefined {
  if (!el) return undefined;
  const dia = el.outsideDiameterMm ?? el.diameterMm;
  if (dia) return `Ø${Math.round(dia)}`;
  if (el.widthMm && el.heightMm) return `${Math.round(el.widthMm)}x${Math.round(el.heightMm)}`;
  return el.size ? sanitizeModelText(el.size, 20) : undefined;
}

function dominant<T extends string>(values: readonly T[]): T | undefined {
  const m = new Map<T, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  let best: T | undefined;
  let n = -1;
  for (const [k, c] of m) if (c > n || (c === n && best !== undefined && k < best)) [best, n] = [k, c];
  return best;
}

/**
 * Deterministic representative clash of a group: highest clash priority score,
 * then deepest penetration, then key. Same order as core/issues worstMember(),
 * so the rationale and the engine issue draft describe the same clash.
 */
export function representativeOf(members: readonly ClassifiedClash[]): ClassifiedClash | undefined {
  return [...members].sort(
    (x, y) => y.priority.score - x.priority.score || y.facts.penetrationMm - x.facts.penetrationMm || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
  )[0];
}

/** Run the deterministic engine and project its output to server records. */
export function runEngine(input: EngineInput): EngineOutput {
  const rs = input.rules ?? loadRules();
  const res = runCoordination({
    clashes: input.clashes,
    elements: input.elements,
    documents: input.documents,
    rules: rs,
    options: {
      review: reviewPolicyFrom(input.config),
      ...(input.extraTags ? { extraTags: input.extraTags } : {}),
      ...(input.levelMap && Object.keys(input.levelMap).length ? { levelMap: input.levelMap } : {}),
    },
  });

  const docs = new Map(input.documents.map((d) => [d.id, d]));
  const els = new Map<string, ElementProps>();
  for (const e of input.elements) if (e.documentId !== undefined) els.set(`${e.documentId}:${e.lmvId}`, e);

  // Document discipline = dominant discipline of its elements as seen by the engine.
  const docDisc = new Map<number, string[]>();
  for (const c of res.classified) {
    for (const el of [c.left, c.right]) {
      const id = Number(el.documentId);
      if (Number.isFinite(id)) docDisc.set(id, [...(docDisc.get(id) ?? []), el.discipline]);
    }
  }

  const byMcId = new Map<string, ClassifiedClash>();
  for (const c of res.classified) for (const id of c.mcClashIds) byMcId.set(id, c);
  const groupOf = new Map<string, EngineGroup>();
  for (const g of res.groups) for (const id of g.mcClashIds) groupOf.set(id, g);

  const side = (s: NormalizedClash["left"], facts: ClassifiedClash["left"] | undefined): ElementSideRecord => {
    const el = els.get(`${s.documentId}:${s.viewerDbId}`);
    const doc = docs.get(s.documentId);
    return {
      ref: `E-${s.documentId}:${s.viewerDbId}`,
      documentId: s.documentId,
      dbId: s.viewerDbId,
      objectId: s.objectId,
      externalId: el?.externalId,
      discipline: facts?.discipline ?? "?",
      category: (facts?.category as string | undefined) ?? el?.category ?? "?",
      name: sanitizeModelText(el?.name ?? `${el?.category ?? "Elemento"} ${s.viewerDbId}`),
      family: el?.family ? sanitizeModelText(el.family) : undefined,
      type: el?.type ? sanitizeModelText(el.type) : undefined,
      system: el?.system ? sanitizeModelText(el.system) : undefined,
      level: el?.level ? sanitizeModelText(el.level, 40) : undefined,
      sizeHint: sizeHintOf(el),
      modelName: sanitizeModelText(doc?.displayName ?? `doc ${s.documentId}`),
      bboxCenterM: bboxCenter(el),
    };
  };

  const clashes: ClashRecord[] = [];
  for (const c of input.clashes) {
    const cc = byMcId.get(c.id);
    const g = groupOf.get(c.id);
    if (!cc || !g) continue;
    const a = side(c.left, cc.left);
    const b = side(c.right, cc.right);
    const cl = cc.classification;
    const pair = [a.discipline, b.discipline].sort();
    const cats = [a.category, b.category].sort();
    clashes.push({
      id: c.id,
      groupId: g.id,
      status: accStatus(c.status),
      triageState: c.triage ?? (c.status === "closed" ? "closed" : "open"),
      rationale: sanitizeModelText(cl.rationale, 400),
      tags: cl.tags,
      suggestedAction: cl.suggestedAction,
      distanceMm: c.distanceMm,
      penetrationMm: c.penetrationMm,
      validity: cl.validity,
      nature: cl.nature,
      severity: cl.severity,
      confidence: cl.confidence,
      ruleId: cl.ruleId,
      level: cc.level ? sanitizeModelText(cc.level, 40) : a.level ?? b.level,
      disciplinePair: `${pair[0]}×${pair[1]}`,
      categoryPair: `${cats[0]}×${cats[1]}`,
      a,
      b,
      delta: "new",
      pairKey: c.pairKey,
    });
  }
  const clashById = new Map(clashes.map((c) => [c.id, c]));

  const issueDrafts: EngineOutput["issueDrafts"] = {};
  const byKey = new Map(res.classified.map((c) => [c.key, c]));
  const groups: GroupRecord[] = res.groups.map((g) => {
    const members = g.mcClashIds.map((id) => clashById.get(id)).filter((c): c is ClashRecord => !!c);
    // ONE deterministic representative per group, shared by the rationale, the issue
    // draft (core/issues uses the same "worst member" order) and the pushpin.
    const rep = representativeOf(g.memberKeys.map((k) => byKey.get(k)).filter((c): c is ClassifiedClash => !!c));
    const pens = members.map((m) => m.penetrationMm);
    const validity = g.validity;
    const [p0, p1] = g.disciplinePair.split("×");
    // Engine issue skeletons: coordination issues for real groups and hygiene issues
    // (one per responsible file and rule); never for needs_info (it is a question, not an issue).
    if (validity !== "needs_info" && (validity === "real" || g.strategy === "hygiene")) {
      try {
        const d = buildIssueDraft(rs, g, res.classified, {
          publishDate: input.publishDate ?? new Date().toISOString().slice(0, 10),
          ...(input.testId ? { testId: input.testId } : {}),
          ...(input.modelSetVersion !== undefined ? { modelSetVersion: input.modelSetVersion } : {}),
        });
        const vp = res.classified.find((c) => c.key === d.viewpointClashKey);
        issueDrafts[g.id] = {
          title: d.title,
          description: d.description,
          responsibleDiscipline: d.responsibleDiscipline,
          dueDate: d.dueDate,
          viewpointClashId: vp ? vp.id : rep?.id,
        };
      } catch {
        // Skeleton is optional; the agent drafts issues via draft_issue.
      }
    }
    const conf: ConfidenceBand = g.confidenceBand;
    return {
      id: g.id,
      strategy: mapStrategy(g.strategy),
      engineStrategy: g.strategy,
      title: sanitizeModelText(g.title, 160),
      clashIds: [...g.mcClashIds],
      validity,
      nature: g.nature,
      severity: g.severity,
      priority: Math.round(Math.max(0, Math.min(100, g.priorityScore))),
      band: mapBand(g.band),
      bandName: g.band,
      humanReview: g.humanReview,
      tags: g.tags,
      ...(g.secondaryDiscipline ? { secondaryDiscipline: g.secondaryDiscipline } : {}),
      triageState: dominant(members.map((m) => m.triageState)) ?? "open",
      rationale: rep ? sanitizeModelText(rep.classification.rationale, 400) : members[0]?.rationale,
      ...(rep ? { representativeClashId: rep.id } : {}),
      confidence: Math.round(g.confidence * 1000) / 1000,
      confidenceBand: conf,
      reviewState: g.reviewState,
      reviewReasons: g.reviewReasons,
      escalate: g.escalate,
      disciplinePair: g.disciplinePair,
      pair: [p0 ?? "?", p1 ?? p0 ?? "?"],
      categoryPair: g.categoryPair,
      levels: g.levels.map((l) => sanitizeModelText(l, 40)),
      responsibleDiscipline: g.responsibleDiscipline,
      rootCause: g.rootCause,
      suggestedAction: g.suggestedAction,
      ruleIds: g.ruleIds,
      maxPenetrationMm: pens.length ? Math.max(...pens) : 0,
      minPenetrationMm: pens.length ? Math.min(...pens) : 0,
      sampleClashIds: g.sample
        .map((k) => res.classified.find((c) => c.key === k)?.id)
        .filter((x): x is string => !!x),
      accStatus: dominant(members.map((m) => m.status)) ?? "active",
      deltaSummary: { new: 0, persisting: 0, reappeared: 0, modified: 0 },
      delta: "new",
    };
  });

  const documents: TestDocumentRecord[] = input.documents.map((d) => ({
    documentId: d.id,
    urn: d.urn,
    viewerUrn: d.viewerUrn,
    name: sanitizeModelText(d.displayName),
    viewableName: sanitizeModelText(d.viewableName),
    lineageUrn: d.lineageUrn,
    discipline: dominant(docDisc.get(d.id) ?? []),
  }));

  return {
    groups,
    clashes,
    documents,
    ruleset: { version: `m${rs.versions.matrix}.r${rs.versions.rules}.s${rs.versions.scoring}`, rules: rs.rules.length, hash: rs.hash.slice(0, 12) },
    unmatchedClashes: res.stats.unmatchedClashes,
    topRules: res.stats.topRules,
    byStrategy: res.stats.groups.byStrategy,
    issueDrafts,
  };
}
