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
import { groupTitle, type ClashGroup as EngineGroup } from "../core/group";
import { DEFAULT_REVIEW_POLICY, type ReviewPolicy } from "../core/group/review";
import { buildIssueDraft } from "../core/issues";
import { runCoordination } from "../core/pipeline";
import type { CompiledRuleSet } from "../core/rules/load";
import type { ElementProps, ModelDocument, NormalizedClash } from "../core/types";
import type { CoordinatorConfig } from "./config";
import { loadRulesFromDisk } from "./rules-loader";
import { sanitizeModelText } from "./sanitize";
import { disambiguateTitles, normalizeLinkedExternalIds } from "./group-titles";
import { attachFamilies } from "./families";
import { modelLevelDiscipline, outCode, resolveDocument, SIN, type DocDiscipline, type DocInfo, type ProjectDisciplines } from "./disciplines";
import type {
  AccStatus,
  ClashRecord,
  ConfidenceBand,
  ElementSideRecord,
  FamilyRecord,
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

/** Drop the cached rule set (after rules/ is published or reverted at runtime). */
export function clearRulesCache(): void {
  rulesCache = undefined;
}

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
  /** Project discipline mappings (server/disciplines.ts). Default: none. */
  projectDisciplines?: ProjectDisciplines;
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
  /** Solution families (F1) of this test. */
  families: FamilyRecord[];
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
  // Model discipline per document is decided HERE (assignment > rule > matrix-if-enabled);
  // everything else is naming-independent (category + unambiguous system), see server/disciplines.ts.
  // Linked-model elements are keyed by their own uid so twin clashes dedupe (server/group-titles.ts).
  const elementsIn = normalizeLinkedExternalIds(input.elements);
  const pd = input.projectDisciplines ?? { version: 0, assignments: {}, rules: [] };
  const matrixOn = input.config.disciplines.fileNameDetection === "matrix";
  const docInfo = new Map<number, DocInfo>(
    input.documents.map((d) => [d.id, { documentId: d.id, lineageUrn: d.lineageUrn, fileName: d.displayName, viewName: d.viewableName }]),
  );
  const modelLevel = new Map<number, DocDiscipline | undefined>([...docInfo].map(([id, di]) => [id, modelLevelDiscipline(di, pd, rs, matrixOn)]));
  const res = runCoordination({
    clashes: input.clashes,
    elements: elementsIn,
    documents: input.documents,
    rules: rs,
    options: {
      modelDiscipline: (docId) => {
        const m = modelLevel.get(docId);
        return m && m.discipline !== SIN ? m.discipline : null;
      },
      strictCategoryDiscipline: true,
      review: reviewPolicyFrom(input.config),
      ...(input.extraTags ? { extraTags: input.extraTags } : {}),
      ...(input.levelMap && Object.keys(input.levelMap).length ? { levelMap: input.levelMap } : {}),
    },
  });

  const docs = new Map(input.documents.map((d) => [d.id, d]));
  const els = new Map<string, ElementProps>();
  for (const e of elementsIn) if (e.documentId !== undefined) els.set(`${e.documentId}:${e.lmvId}`, e);

  // Element discipline counts per document (distinct elements), for the "elements" step.
  const docCounts = new Map<number, Map<string, number>>();
  const seenEl = new Set<string>();
  for (const c of res.classified) {
    for (const el of [c.left, c.right]) {
      const id = Number(el.documentId);
      const k = `${id}|${String(el.elementKey ?? el.externalId ?? "")}`;
      if (!Number.isFinite(id) || seenEl.has(k)) continue;
      seenEl.add(k);
      const m = docCounts.get(id) ?? new Map<string, number>();
      m.set(el.discipline, (m.get(el.discipline) ?? 0) + 1);
      docCounts.set(id, m);
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
      discipline: outCode(facts?.discipline),
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

  /** Element uid without a linked-model prefix (`<linkUid>-<8hex>/<elementUid>` → `<elementUid>`). */
  const uid = (x: string | undefined) => (x ? (x.split("/").pop() ?? x) : undefined);
  const factsForSides = (c: NormalizedClash, cc: ClassifiedClash): [ClassifiedClash["left"], ClassifiedClash["right"]] => {
    const elL = els.get(`${c.left.documentId}:${c.left.viewerDbId}`);
    const elR = els.get(`${c.right.documentId}:${c.right.viewerDbId}`);
    const same = (el: typeof elL, f: ClassifiedClash["left"]) => {
      const k = uid(el?.externalId);
      return !!k && uid(f.externalId) === k;
    };
    // 1. Identity (externalId, link prefix ignored).
    if (same(elL, cc.left) || same(elR, cc.right)) return [cc.left, cc.right];
    if (same(elL, cc.right) || same(elR, cc.left)) return [cc.right, cc.left];
    // 2. Category, only when it tells the sides apart.
    const cat = (el: typeof elL, f: ClassifiedClash["left"]) => !!el?.category && (f.categoryRaw === el.category || f.category === el.category);
    const straight = Number(cat(elL, cc.left)) + Number(cat(elR, cc.right));
    const swapped = Number(cat(elL, cc.right)) + Number(cat(elR, cc.left));
    if (swapped > straight) return [cc.right, cc.left];
    // 3. Same order as the representative (also the case for non-merged clashes).
    return [cc.left, cc.right];
  };

  const clashes: ClashRecord[] = [];
  for (const c of input.clashes) {
    const cc = byMcId.get(c.id);
    const g = groupOf.get(c.id);
    if (!cc || !g) continue;
    // A merged (deduplicated) clash keeps its REPRESENTATIVE's left/right order, and ACC may
    // order a twin the other way round (e.g. slab left/pipe right vs pipe left/slab right).
    // Pair each of this clash's elements with its own facts by identity, never by position.
    const [fl, fr] = factsForSides(c, cc);
    const a = side(c.left, fl);
    const b = side(c.right, fr);
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
      // The engine G0 identity of the physical clash (linked copies normalized): ACC matching key (review fix #2).
      uniqueKey: cc.key,
    });
  }
  const clashById = new Map(clashes.map((c) => [c.id, c]));

  const issueDrafts: EngineOutput["issueDrafts"] = {};
  const byKey = new Map(res.classified.map((c) => [c.key, c]));
  const groups0: GroupRecord[] = res.groups.map((g) => {
    const members = g.mcClashIds.map((id) => clashById.get(id)).filter((c): c is ClashRecord => !!c);
    // ONE deterministic representative per group, shared by the rationale, the issue
    // draft (core/issues uses the same "worst member" order) and the pushpin.
    const rep = representativeOf(g.memberKeys.map((k) => byKey.get(k)).filter((c): c is ClassifiedClash => !!c));
    // Engine issue skeletons: coordination issues for real groups and hygiene issues
    // (one per responsible file and rule); never for needs_info (it is a question, not an issue).
    draftFor(g, rep);
    const conf: ConfidenceBand = g.confidenceBand;
    return groupRecordOf(g, members, rep, conf);
  });
  function draftFor(g: EngineGroup, rep: ClassifiedClash | undefined): void {
    const validity = g.validity;
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
  }
  function groupRecordOf(g: EngineGroup, members: ClashRecord[], rep: ClassifiedClash | undefined, conf: ConfidenceBand): GroupRecord {
    const pens = members.map((m) => m.penetrationMm);
    const validity = g.validity;
    const [p0, p1] = g.disciplinePair.split("×");
    return {
      id: g.id,
      strategy: mapStrategy(g.strategy),
      engineStrategy: g.strategy,
      title: sanitizeModelText(g.title, 160).replace(/\bUNK\b/g, SIN),
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
      disciplinePair: g.disciplinePair.split("×").map(outCode).join("×"),
      pair: [outCode(p0), outCode(p1 ?? p0)],
      categoryPair: g.categoryPair,
      levels: g.levels.map((l) => sanitizeModelText(l, 40)),
      responsibleDiscipline: outCode(g.responsibleDiscipline),
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
  }

  // F1 families + invariant 8 (one group = one family; mixed groups are split).
  const docName = new Map(input.documents.map((d) => [d.id, d.displayName]));
  const originOf = new Map<string, string>();
  for (const e of elementsIn) {
    if (!e.externalId || e.documentId === undefined) continue;
    const linked = !!(e.raw as Record<string, unknown> | undefined)?.["__coord/linkedExternalId"];
    if (!linked || !originOf.has(e.externalId)) {
      if (!linked) originOf.set(e.externalId, docName.get(e.documentId) ?? `doc ${e.documentId}`);
    }
  }
  const fam = attachFamilies({
    groups: groups0,
    clashes,
    engineGroups: res.groups,
    classified: res.classified,
    originFile: (s) => originOf.get(String(s.externalId ?? "")) ?? docName.get(Number(s.documentId)) ?? `doc ${String(s.documentId)}`,
    representativeOf,
    retitle: (eg, ms) => groupTitle(rs, eg, ms, {}).replace(/UNK/g, SIN),
  });
  const groups = fam.groups;
  // Split parts (invariant 8): the issue skeleton describes the part's own representative.
  const egById = new Map(res.groups.map((g) => [g.id, g]));
  for (const part of fam.parts) {
    const eg = egById.get(part.engineGroupId);
    if (!eg) continue;
    delete issueDrafts[part.id];
    const sub: EngineGroup = { ...eg, id: part.id, memberKeys: part.keys, mcClashIds: part.mcClashIds };
    draftFor(sub, representativeOf(part.keys.map((k) => byKey.get(k)).filter((c): c is ClassifiedClash => !!c)));
  }
  // G23: the issue owner follows the group's (system) responsible discipline.
  for (const g of groups) {
    const d = issueDrafts[g.id];
    if (d && d.responsibleDiscipline !== g.responsibleDiscipline) d.responsibleDiscipline = g.responsibleDiscipline;
  }
  const hubExt = new Map(res.groups.map((g) => [g.id, g.hubElement?.externalId]));
  // Unique, self-explaining titles (same type on the same level → state the element).
  disambiguateTitles(groups, {
    clashById,
    elementByRef: new Map([...els].map(([k, e]) => [`E-${k}`, e])),
    hubRef: (g) => {
      const ext = hubExt.get(g.id);
      if (!ext) return undefined;
      for (const id of g.clashIds) {
        const c = clashById.get(id);
        if (c?.a.externalId === ext) return c.a.ref;
        if (c?.b.externalId === ext) return c.b.ref;
      }
      return undefined;
    },
  });

  const documents: TestDocumentRecord[] = input.documents.map((d) => ({
    documentId: d.id,
    urn: d.urn,
    viewerUrn: d.viewerUrn,
    name: sanitizeModelText(d.displayName),
    viewableName: sanitizeModelText(d.viewableName),
    lineageUrn: d.lineageUrn,
    ...(() => {
      const r = resolveDocument(docInfo.get(d.id)!, pd, rs, matrixOn, docCounts.get(d.id));
      return { discipline: outCode(r.discipline), disciplineSource: r.source, ...(r.share !== undefined ? { disciplineShare: r.share } : {}), ...(r.ruleId ? { disciplineRuleId: r.ruleId } : {}) };
    })(),
  }));

  return {
    groups,
    clashes,
    documents,
    ruleset: { version: `m${rs.versions.matrix}.r${rs.versions.rules}.s${rs.versions.scoring}`, rules: rs.rules.length, hash: rs.hash.slice(0, 12) },
    unmatchedClashes: res.stats.unmatchedClashes,
    topRules: res.stats.topRules,
    byStrategy: res.stats.groups.byStrategy,
    families: fam.families,
    issueDrafts,
  };
}
