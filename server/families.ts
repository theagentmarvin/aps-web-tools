/**
 * Solution families on top of groups (docs/domain/solution-families-proposal.md).
 *
 *  - {@link attachFamilies}: engine projection. Per-clash signatures (core/families),
 *    invariant 8 (one group = one family: mixed groups are split, the dominant part
 *    keeps the old id), family aggregates for the test.
 *  - {@link FamilyDecisionStore}: human decisions per project + model set
 *    (versioned, audited), exceptions, confirmations of inherited instances,
 *    merges (aliases) and detached instances. Survives re-tests.
 *  - {@link familyViews}: projection of families + decisions for one test,
 *    with the inheritance state of every instance.
 */
import type { ClassifiedClash } from "../core/classified";
import { assignFamilies, bucketOf, familyIdOf, familyTitle, problemTypeOf, signatureOfParts, systemDisciplineOf, upgradeParts, type ClashFamily, type ProblemTypeCode, type SignatureParts } from "../core/families";
import type { ClashGroup as EngineGroup } from "../core/group";
import { STRUCTURAL_OPENING_TAG } from "../core/group/review";
import { sha1 } from "../core/util/sha1";
import { sanitizeModelText } from "./sanitize";
import type { Store } from "./store";
import { pathSegment } from "./store";
import { readJsonFile, writeJsonAtomic } from "./store/fs";
import type { ClashRecord, FamilyAction, FamilyRecord, GroupRecord, Validity } from "./store/types";
import { bareProjectId, CoordError, nowIso, sha256 } from "./util";

// ── engine projection ───────────────────────────────────────────────────────

export interface AttachInput {
  groups: GroupRecord[];
  clashes: ClashRecord[];
  engineGroups: readonly EngineGroup[];
  classified: readonly ClassifiedClash[];
  /** externalId (link prefix removed) → origin file name. */
  originFile: (side: ClassifiedClash["left"]) => string;
  /** Representative of a member set (same order as the engine). */
  representativeOf: (members: readonly ClassifiedClash[]) => ClassifiedClash | undefined;
  /** Title of a split part from its own members (the counts in the parent title would be wrong). */
  retitle?: (eg: EngineGroup, members: readonly ClassifiedClash[]) => string;
}

function dominant<T extends string>(values: readonly T[]): T | undefined {
  const m = new Map<T, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
}

/** Mutates groups/clashes (familyId, split groups) and returns the family aggregates. */
export function attachFamilies(input: AttachInput): {
  groups: GroupRecord[];
  families: FamilyRecord[];
  byKey: Map<string, ClashFamily>;
  /** Parts of split groups (dominant part included, with the original id). */
  parts: Array<{ id: string; engineGroupId: string; keys: string[]; mcClashIds: string[] }>;
} {
  const splitParts: Array<{ id: string; engineGroupId: string; keys: string[]; mcClashIds: string[] }> = [];
  const groupOfKey = new Map<string, string>();
  for (const g of input.engineGroups) for (const k of g.memberKeys) groupOfKey.set(k, g.id);
  const byKey = assignFamilies(input.classified, { originFile: input.originFile, groupOf: (k) => groupOfKey.get(k) });
  const classifiedByKey = new Map(input.classified.map((c) => [c.key, c]));
  const keyOfMc = new Map<string, string>();
  for (const c of input.classified) for (const id of c.mcClashIds) keyOfMc.set(id, c.key);
  const clashById = new Map(input.clashes.map((c) => [c.id, c]));
  const engineById = new Map(input.engineGroups.map((g) => [g.id, g]));

  const out: GroupRecord[] = [];
  for (const g of input.groups) {
    const eg = engineById.get(g.id);
    const keys = eg ? eg.memberKeys : [...new Set(g.clashIds.map((id) => keyOfMc.get(id)).filter((k): k is string => !!k))];
    const parts = new Map<string, string[]>();
    for (const k of keys) {
      const f = byKey.get(k);
      if (!f) continue;
      const list = parts.get(f.familyId) ?? [];
      list.push(k);
      parts.set(f.familyId, list);
    }
    if (parts.size <= 1) {
      const fid = [...parts.keys()][0];
      out.push(fid ? tag(g, fid, keys) : g);
      continue;
    }
    // Invariant 8: split by family. The dominant part (most unique conflicts) keeps the id.
    const ordered = [...parts.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
    ordered.forEach(([fid, ks], i) => {
      const mcIds = new Set(ks.flatMap((k) => classifiedByKey.get(k)?.mcClashIds ?? []));
      const clashIds = g.clashIds.filter((id) => mcIds.has(id));
      const id = i === 0 ? g.id : `G-${sha1(`${eg?.strategy ?? g.engineStrategy}|${eg?.canonicalKey ?? g.id}|${fid}`).slice(0, 10)}`;
      const members = clashIds.map((x) => clashById.get(x)).filter((c): c is ClashRecord => !!c);
      for (const m of members) m.groupId = id;
      const pens = members.map((m) => m.penetrationMm);
      const rep = input.representativeOf(ks.map((k) => classifiedByKey.get(k)).filter((c): c is ClassifiedClash => !!c));
      const f = byKey.get(ks[0]!)!;
      const sizes = ks.map((k) => byKey.get(k)?.moverSizeMm).filter((x): x is number => x !== undefined);
      const levels = [...new Set(members.map((m) => m.level).filter((l): l is string => !!l))].sort();
      splitParts.push({ id, engineGroupId: g.id, keys: [...ks], mcClashIds: clashIds });
      const split: GroupRecord = {
        ...g,
        id,
        clashIds,
        ...(rep ? { rationale: sanitizeModelText(rep.classification.rationale, 400) } : {}),
        // Review fix #5: every part of a split group gets a title built from ITS members (counts included).
        title: (() => {
          const ms = ks.map((k) => classifiedByKey.get(k)).filter((c): c is ClassifiedClash => !!c);
          if (eg && input.retitle) {
            try {
              return sanitizeModelText(input.retitle({ ...eg, id, memberKeys: [...ks], mcClashIds: clashIds, levels }, ms), 160);
            } catch {
              /* fall through */
            }
          }
          return sanitizeModelText(`${familyTitle(f.parts, sizes)} — ${levels[0] ?? "sin nivel"}`, 160);
        })(),
        levels: i === 0 ? g.levels.filter((l) => levels.includes(l)).concat(levels.filter((l) => !g.levels.includes(l))) : levels,
        maxPenetrationMm: pens.length ? Math.max(...pens) : 0,
        minPenetrationMm: pens.length ? Math.min(...pens) : 0,
        ...(rep ? { representativeClashId: clashIds.includes(rep.id) ? rep.id : clashIds[0] } : {}),
        sampleClashIds: g.sampleClashIds.filter((x) => clashIds.includes(x)).concat(clashIds).filter((x, j, a) => a.indexOf(x) === j).slice(0, 3),
        ruleIds: byFreq(ks.map((k) => classifiedByKey.get(k)?.classification.ruleId).filter((r): r is string => !!r)),
        triageState: dominant(members.map((m) => m.triageState)) ?? g.triageState,
        accStatus: dominant(members.map((m) => m.status)) ?? g.accStatus,
        // G23: a split part describes ITS members (the parent's pair may be another system's).
        ...partDisciplines(ks.map((k) => classifiedByKey.get(k)).filter((c): c is ClassifiedClash => !!c), g),
        ...(i === 0 ? {} : { tags: [...new Set([...g.tags, "familia_separada"])] }),
      };
      out.push(tag(split, fid, ks));
    });
  }

  function tag(g: GroupRecord, fid: string, keys: readonly string[]): GroupRecord {
    const f = byKey.get(keys[0]!)!;
    const label = keys.map((k) => byKey.get(k)?.hostLevelLabel).find((x) => !!x);
    for (const id of g.clashIds) {
      const c = clashById.get(id);
      const k = keyOfMc.get(id);
      const cf = k ? byKey.get(k) : undefined;
      if (c && cf) Object.assign(c, { familyId: cf.familyId, problemType: cf.parts.problemType, signature: sanitizeModelText(cf.signature, 300) });
    }
    const sp = systemPair(g, f.parts);
    const { secondaryDiscipline: _sec, ...base } = g;
    void _sec;
    return { ...base, ...sp, familyId: fid, problemType: f.parts.problemType, signature: sanitizeModelText(f.signature, 300), uniqueClashCount: keys.length, ...(label ? { hostLevelLabel: sanitizeModelText(label, 80) } : {}) };
  }

  const families = aggregateFamilies(out, byKey, classifiedByKey, keyOfMc);
  return { groups: out, families, byKey, parts: splitParts };
}

const code = (d: string | undefined): string => (!d || d === "UNK" ? "SIN" : d);

/** Pair, responsible and secondary discipline of a split part, from its own members. */
function partDisciplines(ms: readonly ClassifiedClash[], parent: GroupRecord): Pick<GroupRecord, "pair" | "disciplinePair" | "responsibleDiscipline"> & { secondaryDiscipline?: string } {
  if (!ms.length) return { pair: parent.pair, disciplinePair: parent.disciplinePair, responsibleDiscipline: parent.responsibleDiscipline, ...(parent.secondaryDiscipline ? { secondaryDiscipline: parent.secondaryDiscipline } : {}) };
  const pairKey = dominant(ms.map((c) => [code(c.left.discipline), code(c.right.discipline)].sort().join("×")))!;
  const [p0, p1] = pairKey.split("×") as [string, string];
  const resp = dominant(ms.map((c) => code(c.classification.responsibleDiscipline)))!;
  const sec = dominant(ms.map((c) => c.classification.secondaryDiscipline).filter((x): x is string => !!x));
  return { pair: [p0, p1 ?? p0], disciplinePair: pairKey, responsibleDiscipline: resp, ...(sec ? { secondaryDiscipline: code(sec) } : {}) };
}

/** Host classes that are themselves MEP runs (PT08 crossings): the host discipline is its system's. */
const MEP_HOST_CLASSES = new Set(["tub_grav", "tub_pres", "ducto", "elec"]);
const MEP_CODES = new Set(["AP", "ALL", "ALC", "CAL", "INC", "CLI", "ELE", "CORR", "GAS", "SAN", "SIN"]);

/**
 * G23: the pair label and the responsible party use the SYSTEM discipline of the MEP element
 * (AP agua potable, ALL aguas lluvia, ALC alcantarillado; rules/discipline-matrix.yaml), not the
 * discipline of the file or of the parent group. The non-MEP side (EST, ARQ…) is kept as is.
 */
export function systemPair(
  g: Pick<GroupRecord, "pair" | "responsibleDiscipline" | "secondaryDiscipline">,
  parts: Pick<ClashFamily["parts"], "systemClass" | "hostClass" | "hostType" | "problemType">,
): Pick<GroupRecord, "pair" | "disciplinePair" | "responsibleDiscipline"> & { secondaryDiscipline?: string } {
  const same = { pair: g.pair, disciplinePair: `${g.pair[0]}×${g.pair[1]}`, responsibleDiscipline: g.responsibleDiscipline, ...(g.secondaryDiscipline ? { secondaryDiscipline: g.secondaryDiscipline } : {}) };
  if (bucketOf(parts.problemType as ProblemTypeCode) !== "pair" || parts.problemType === "PT09") return same;
  const md = systemDisciplineOf(parts.systemClass);
  if (!md) return same;
  const hd = MEP_HOST_CLASSES.has(parts.hostClass) ? systemDisciplineOf(parts.hostType) : g.pair.find((d) => !MEP_CODES.has(d));
  if (!hd) return same;
  const map = (d: string) => (d === hd ? d : MEP_CODES.has(d) ? md : d);
  const pair = [map(g.pair[0]), map(g.pair[1])].sort() as [string, string];
  if (!pair.includes(hd)) return same;
  const sec = g.secondaryDiscipline ? map(g.secondaryDiscipline) : undefined;
  return { pair, disciplinePair: `${pair[0]}×${pair[1]}`, responsibleDiscipline: map(g.responsibleDiscipline), ...(sec && sec !== map(g.responsibleDiscipline) ? { secondaryDiscipline: sec } : {}) };
}

function byFreq(values: readonly string[]): string[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
}

function sizeLabel(size: number, duct: boolean): string {
  return duct ? `${Math.round(size)} mm` : `Ø${Math.round(size)}`;
}

function aggregateFamilies(groups: readonly GroupRecord[], byKey: Map<string, ClashFamily>, classifiedByKey: Map<string, ClassifiedClash>, keyOfMc: Map<string, string>): FamilyRecord[] {
  const gByFam = new Map<string, GroupRecord[]>();
  for (const g of groups) if (g.familyId) gByFam.set(g.familyId, [...(gByFam.get(g.familyId) ?? []), g]);
  const fams: FamilyRecord[] = [];
  for (const [fid, gs] of gByFam) {
    const keys = [...new Set(gs.flatMap((g) => g.clashIds.map((id) => keyOfMc.get(id)).filter((k): k is string => !!k)))];
    const cfs = keys.map((k) => byKey.get(k)!).filter((x) => x && x.familyId === fid);
    const f0 = cfs[0] ?? byKey.get(keys[0]!)!;
    const pt = f0.parts.problemType as ProblemTypeCode;
    const mix: Partial<Record<Validity, number>> = {};
    for (const k of keys) {
      const v = classifiedByKey.get(k)?.classification.validity;
      if (v) mix[v] = (mix[v] ?? 0) + 1;
    }
    const validities = Object.keys(mix) as Validity[];
    const proposedValidity: Validity = mix.real ? "real" : validities.sort((a, b) => (mix[b] ?? 0) - (mix[a] ?? 0) || (a < b ? -1 : 1))[0] ?? "needs_info";
    const action: FamilyAction = pt === "PT12" || pt === "PT13" ? "hygiene_issue" : proposedValidity === "real" ? "create_issue" : proposedValidity === "needs_info" ? "escalate" : "close";
    const weighted = (pick: (g: GroupRecord) => string | undefined, filter: (g: GroupRecord) => boolean) => {
      const m = new Map<string, number>();
      for (const g of gs.filter(filter)) {
        const v = pick(g);
        if (v) m.set(v, (m.get(v) ?? 0) + (g.uniqueClashCount ?? g.clashIds.length));
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
    };
    const relevant = (g: GroupRecord) => g.validity === proposedValidity;
    const responsible = weighted((g) => g.responsibleDiscipline, relevant) ?? weighted((g) => g.responsibleDiscipline, () => true) ?? "COORD";
    const secondary = weighted((g) => g.secondaryDiscipline, relevant);
    const pairSrc = gs.find((g) => g.responsibleDiscipline === responsible) ?? gs[0]!;
    const other = pairSrc.pair[0] === responsible ? pairSrc.pair[1] : pairSrc.pair[0];
    const levels = [...new Set(gs.flatMap((g) => g.levels))].sort();
    const sizes = cfs.map((c) => c.moverSizeMm).filter((x): x is number => x !== undefined);
    const pens = gs.flatMap((g) => [g.minPenetrationMm, g.maxPenetrationMm]);
    const duct = f0.parts.moverClass === "ducto";
    const hist = new Map<string, number>();
    for (const s of sizes) hist.set(sizeLabel(s, duct), (hist.get(sizeLabel(s, duct)) ?? 0) + 1);
    const tags: FamilyRecord["tags"] = [];
    if (gs.length >= 3 && levels.length >= 2) tags.push("tipico");
    if (validities.length > 1) tags.push("validez_mixta");
    if (cfs.some((c) => c.flags.orientationUnknown)) tags.push("orientacion_por_confirmar");
    if (cfs.some((c) => c.flags.noSystem)) tags.push("sin_sistema");
    const depth = cfs.map((c) => c.hostDepthMm).find((x) => x !== undefined);
    const bucket = bucketOf(pt);
    fams.push({
      id: fid,
      signature: sanitizeModelText(f0.signature, 300),
      parts: Object.fromEntries(Object.entries(f0.parts).map(([k, v]) => [k, typeof v === "string" ? sanitizeModelText(v, 80) : v])) as FamilyRecord["parts"],
      title: sanitizeModelText(familyTitle(f0.parts, sizes), 160),
      bucket,
      ...(bucket === "pair" ? { pair: [responsible, other ?? responsible] as [string, string] } : {}),
      groupIds: gs.map((g) => g.id),
      instanceCount: gs.length,
      uniqueClashCount: keys.length,
      rawClashCount: gs.reduce((n, g) => n + g.clashIds.length, 0),
      levels,
      validityMix: mix,
      proposed: {
        validity: proposedValidity,
        action,
        responsibleDiscipline: responsible,
        ...(secondary ? { secondaryDiscipline: secondary } : {}),
        solutionOption: problemTypeOf(pt).options[0],
        band: Math.min(...gs.map((g) => g.band)) as 1 | 2 | 3 | 4,
      },
      tags,
      evidence: {
        ...(sizes.length ? { moverSizeMm: { min: Math.round(Math.min(...sizes)), max: Math.round(Math.max(...sizes)) } } : {}),
        penetrationMm: { min: pens.length ? Math.round(Math.min(...pens)) : 0, max: pens.length ? Math.round(Math.max(...pens)) : 0 },
        ...(depth ? { hostDepthMm: depth } : {}),
        sizeHistogram: [...hist.entries()].map(([size, count]) => ({ size, count })).sort((a, b) => b.count - a.count || (a.size < b.size ? -1 : 1)),
      },
    });
  }
  return fams.sort((a, b) => b.instanceCount - a.instanceCount || b.uniqueClashCount - a.uniqueClashCount || (a.id < b.id ? -1 : 1));
}

// ── human decisions ─────────────────────────────────────────────────────────

export interface FamilyDecisionFields {
  validity: Validity;
  action: FamilyAction;
  responsibleDiscipline: string;
  secondaryDiscipline?: string;
  solutionOption?: string;
  typicalDetail?: { name: string; note?: string };
  issueMode: "family" | "per_instance";
}

export interface FamilyDecisionVersion extends FamilyDecisionFields {
  familyId: string;
  version: number;
  status: "approved" | "rejected";
  decidedBy: string;
  decidedAt: string;
  spotChecked: string[];
  /** Instances present when this version was decided (testKey → groupIds). */
  coveredGroupIds: string[];
  testKey: string;
  note?: string;
  /** Instances whose validity changed with this decision (explicitly acknowledged). */
  acknowledgedValidityChanges?: string[];
}

export interface FamilyException {
  groupId: string;
  fields: Partial<FamilyDecisionFields>;
  reason: string;
  by: string;
  at: string;
  /** Decision version current when the exception was made ("familia cambió" if newer). */
  decisionVersion?: number;
}

export interface FamilyState {
  versions: FamilyDecisionVersion[];
  exceptions: FamilyException[];
  /** Inherited instances a human confirmed (groupIds), per decision version. */
  confirmed: Array<{ groupId: string; version: number; by: string; at: string; testKey?: string }>;
}

export interface ModelSetFamilies {
  version: number;
  families: Record<string, FamilyState>;
  /** Merges: F-a → F-b. */
  aliases: Record<string, string>;
  /** Detached instances: groupId → manual family id. */
  detached: Record<string, { familyId: string; by: string; at: string }>;
  /** Titles of manual families created by an applied regroup proposal (agent text, untrusted). */
  labels?: Record<string, string>;
  /**
   * G7: human confirmations of inherited HUMAN decisions that policy re-asks (critical, structural
   * opening, life safety), per test: testKey → groupId → the confirmed decision reference.
   * (Family-decision confirmations live in `families[id].confirmed`.)
   */
  inheritConfirmations?: Record<string, Record<string, { ref: string; by: string; at: string; reasons: string[] }>>;
  updatedAt?: string;
  updatedBy?: string;
}

export class FamilyDecisionStore {
  constructor(private readonly store: Store) {}

  path(projectId: string, modelSetId: string): string {
    const safe = (s: string) => pathSegment(s);
    return this.store.path("projects", safe(bareProjectId(projectId)), "model-sets", safe(modelSetId), "families.json");
  }

  async load(projectId: string, modelSetId: string): Promise<ModelSetFamilies> {
    return (await readJsonFile<ModelSetFamilies>(this.path(projectId, modelSetId))) ?? { version: 0, families: {}, aliases: {}, detached: {} };
  }

  /** Versioned update + audit (before/after hashes). */
  async update<T>(
    projectId: string,
    modelSetId: string,
    by: { id: string; name: string },
    mutate: (cfg: ModelSetFamilies) => T,
    audit: { action: string; testKey?: string; targetIds: string[]; details?: Record<string, string | number | boolean | null> },
  ): Promise<{ state: ModelSetFamilies; result: T }> {
    return this.store.withLock(async () => {
      const cur = await this.load(projectId, modelSetId);
      const before = sha256(JSON.stringify(cur.families) + JSON.stringify(cur.aliases) + JSON.stringify(cur.detached));
      const next: ModelSetFamilies = JSON.parse(JSON.stringify(cur));
      const result = mutate(next);
      next.version = cur.version + 1;
      next.updatedAt = nowIso(this.store.now());
      next.updatedBy = by.name;
      await writeJsonAtomic(this.path(projectId, modelSetId), next);
      await this.store.audit({
        actor: { type: "user", id: by.id, name: by.name },
        action: audit.action,
        projectId,
        modelSetId,
        ...(audit.testKey ? { testId: audit.testKey } : {}),
        targetIds: audit.targetIds,
        details: { ...(audit.details ?? {}), before: before.slice(0, 16), after: sha256(JSON.stringify(next.families) + JSON.stringify(next.aliases) + JSON.stringify(next.detached)).slice(0, 16), stateVersion: next.version },
      });
      return { state: next, result };
    });
  }
}

export function currentDecision(st: FamilyState | undefined): FamilyDecisionVersion | undefined {
  return st?.versions[st.versions.length - 1];
}

/** Follow merge aliases (cycle-safe). */
export function resolveAlias(aliases: Record<string, string>, id: string): string {
  const seen = new Set<string>();
  let cur = id;
  while (aliases[cur] && !seen.has(cur)) {
    seen.add(cur);
    cur = aliases[cur]!;
  }
  return cur;
}

export type InheritanceState = "none" | "inherited" | "inherited_pending" | "exception" | "detached";

export interface FamilyInstanceView {
  groupId: string;
  title: string;
  levels: string[];
  hostLevelLabel?: string;
  validity: Validity;
  band: 1 | 2 | 3 | 4;
  uniqueClashCount: number;
  rawClashCount: number;
  delta: GroupRecord["delta"];
  inheritance: { state: InheritanceState; decisionVersion?: number; exceptionReason?: string; familyChanged?: boolean };
}

export interface FamilyView extends Omit<FamilyRecord, "groupIds"> {
  groupIds: string[];
  /** Ids merged into this one. */
  mergedFrom: string[];
  decision?: FamilyDecisionVersion;
  exceptions: FamilyException[];
  instances: FamilyInstanceView[];
  state: "sin_decidir" | "decidida" | "rechazada";
  counts: { exceptions: number; pendingInherited: number; inherited: number };
  /** Instances whose current validity differs from the decision (mixed-validity guard). */
  validityConflicts: Array<{ groupId: string; title: string; from: Validity; to: Validity }>;
  issue?: { mode: "family" | "per_instance" };
  problemTypeName: string;
  /** G16: decisions of earlier family ids (old signature) that disagree here: a human reviews them. */
  legacyDecisions?: LegacyFamilyDecision[];
}

/** Families of one test with merges, detaches, decisions and inheritance applied. */
export interface FamilyViewContext {
  /** The test being shown. */
  testKey: string;
  /**
   * A family decision taken on ANOTHER version is inherited by an instance only when this returns
   * true: every clash still carries that family's decision reference, unchanged (|Δpen| ≤ 10 mm,
   * same element types), and the engine does not gate the group (needs_review). Otherwise the
   * instance is "inherited_pending" (a human confirms it). Review fix #1.
   */
  stable: (groupId: string, familyId: string) => boolean;
  /** G16: old decisions that could not be carried to a new family (shown as "revisar"). */
  legacyReview?: ReadonlyMap<string, LegacyFamilyDecision[]>;
}

export function familyViews(families: readonly FamilyRecord[], groups: readonly GroupRecord[], st: ModelSetFamilies, ctx?: FamilyViewContext): FamilyView[] {
  const gById = new Map(groups.map((g) => [g.id, g]));
  // Re-key: alias merges and detached instances.
  const members = new Map<string, { base: FamilyRecord; ids: Set<string>; mergedFrom: Set<string> }>();
  const famById = new Map(families.map((f) => [f.id, f]));
  for (const f of families) {
    const target = resolveAlias(st.aliases, f.id);
    const base = famById.get(target) ?? f;
    const e = members.get(target) ?? { base, ids: new Set<string>(), mergedFrom: new Set<string>() };
    if (target !== f.id) e.mergedFrom.add(f.id);
    for (const g of f.groupIds) {
      const d = st.detached[g];
      if (d) continue;
      e.ids.add(g);
    }
    members.set(target, e);
  }
  for (const [gid, d] of Object.entries(st.detached)) {
    const g = gById.get(gid);
    if (!g) continue;
    const src = families.find((f) => f.groupIds.includes(gid));
    if (!src) continue;
    const e = members.get(d.familyId) ?? { base: { ...src, id: d.familyId, title: st.labels?.[d.familyId] ?? `${src.title} (separada)`, groupIds: [], tags: src.tags.filter((t) => t !== "tipico") }, ids: new Set<string>(), mergedFrom: new Set<string>() };
    e.ids.add(gid);
    members.set(d.familyId, e);
  }

  const views: FamilyView[] = [];
  for (const [id, { base, ids, mergedFrom }] of members) {
    const gs = [...ids].map((g) => gById.get(g)).filter((g): g is GroupRecord => !!g);
    if (!gs.length) continue;
    const fs = st.families[id];
    const dec = currentDecision(fs);
    const approved = dec?.status === "approved" ? dec : undefined;
    const exByGroup = new Map((fs?.exceptions ?? []).map((e) => [e.groupId, e]));
    // Confirmations count for the version they were made on (legacy entries without testKey: as before).
    const confirmed = new Set((fs?.confirmed ?? []).filter((c) => approved && c.version <= approved.version && (!ctx || !c.testKey || c.testKey === ctx.testKey)).map((c) => c.groupId));
    // "covered" means decided only on the version the decision was taken on.
    const sameVersion = !ctx || !approved || approved.testKey === ctx.testKey;
    const covered = new Set(approved ? fs!.versions.filter((v) => v.status === "approved" && (!ctx || v.testKey === ctx.testKey)).flatMap((v) => v.coveredGroupIds) : []);
    const instances: FamilyInstanceView[] = gs.map((g) => {
      const ex = exByGroup.get(g.id);
      let inh: FamilyInstanceView["inheritance"];
      if (st.detached[g.id]) inh = { state: "detached" };
      else if (ex) inh = { state: "exception", exceptionReason: ex.reason, ...(ex.decisionVersion !== undefined && approved && approved.version > ex.decisionVersion ? { familyChanged: true } : {}), ...(approved ? { decisionVersion: approved.version } : {}) };
      else if (!approved) inh = { state: "none" };
      else if (covered.has(g.id) || confirmed.has(g.id) || (!sameVersion && ctx!.stable(g.id, id))) inh = { state: "inherited", decisionVersion: approved.version };
      else inh = { state: "inherited_pending", decisionVersion: approved.version };
      return {
        groupId: g.id,
        title: g.title,
        levels: g.levels,
        ...(g.hostLevelLabel ? { hostLevelLabel: g.hostLevelLabel } : {}),
        validity: g.validity,
        band: g.band,
        uniqueClashCount: g.uniqueClashCount ?? g.clashIds.length,
        rawClashCount: g.clashIds.length,
        delta: g.delta,
        inheritance: inh,
      };
    });
    const mix: Partial<Record<Validity, number>> = {};
    for (const g of gs) mix[g.validity] = (mix[g.validity] ?? 0) + (g.uniqueClashCount ?? g.clashIds.length);
    const levels = [...new Set(gs.flatMap((g) => g.levels))].sort();
    const tags: FamilyRecord["tags"] = base.tags.filter((t) => t !== "tipico" && t !== "validez_mixta");
    if (gs.length >= 3 && levels.length >= 2) tags.unshift("tipico");
    if (Object.keys(mix).length > 1) tags.push("validez_mixta");
    const target = approved?.validity;
    const validityConflicts = target ? instances.filter((i) => i.inheritance.state !== "exception" && i.inheritance.state !== "detached" && i.validity !== target).map((i) => ({ groupId: i.groupId, title: i.title, from: i.validity, to: target })) : [];
    views.push({
      ...base,
      id,
      groupIds: gs.map((g) => g.id),
      mergedFrom: [...mergedFrom],
      instanceCount: gs.length,
      uniqueClashCount: gs.reduce((n, g) => n + (g.uniqueClashCount ?? g.clashIds.length), 0),
      rawClashCount: gs.reduce((n, g) => n + g.clashIds.length, 0),
      levels,
      validityMix: mix,
      tags: tags.filter((t, i, a) => a.indexOf(t) === i),
      proposed: { ...base.proposed, band: Math.min(...gs.map((g) => g.band)) as 1 | 2 | 3 | 4 },
      ...(dec ? { decision: dec } : {}),
      exceptions: fs?.exceptions.filter((e) => ids.has(e.groupId)) ?? [],
      instances,
      state: !dec ? "sin_decidir" : dec.status === "approved" ? "decidida" : "rechazada",
      counts: {
        exceptions: instances.filter((i) => i.inheritance.state === "exception").length,
        pendingInherited: instances.filter((i) => i.inheritance.state === "inherited_pending").length,
        inherited: instances.filter((i) => i.inheritance.state === "inherited").length,
      },
      validityConflicts,
      ...(approved && (approved.action === "create_issue" || approved.action === "hygiene_issue") ? { issue: { mode: approved.issueMode } } : {}),
      problemTypeName: problemTypeOf(base.parts.problemType as ProblemTypeCode).nameEs,
      ...((): Partial<FamilyView> => {
        const legacy = [id, ...mergedFrom].flatMap((x) => ctx?.legacyReview?.get(x) ?? []);
        return legacy.length ? { legacyDecisions: legacy } : {};
      })(),
    });
  }
  return views.sort((a, b) => b.instanceCount - a.instanceCount || b.uniqueClashCount - a.uniqueClashCount || (a.id < b.id ? -1 : 1));
}

// ── G7: policy that re-asks an inherited decision ───────────────────────────

export type InheritPolicyReason = "critical" | "structural_opening" | "life_safety";

/**
 * Reasons that force a human look at an inherited decision even when nothing changed
 * (CLAUDE.md rule 4): critical severity, an opening in structure (calculista), life safety.
 * Rule-only gate reasons (confidence, group size, unmatched, conflicting rules) are not here.
 * real → closure is never inherited at all (handled by the inheritance itself).
 */
export function inheritPolicyReasons(g: Pick<GroupRecord, "severity" | "tags">): InheritPolicyReason[] {
  const out: InheritPolicyReason[] = [];
  if (g.severity === "critical") out.push("critical");
  if (g.tags.includes(STRUCTURAL_OPENING_TAG)) out.push("structural_opening");
  if (g.tags.includes("seguridad_personas")) out.push("life_safety");
  return out;
}

// ── G16: family decisions across signature changes ──────────────────────────

/** A decision of a family id that no longer exists, shown on its new family for a human to review. */
export interface LegacyFamilyDecision {
  familyId: string;
  version: number;
  validity: Validity;
  action: FamilyAction;
  responsibleDiscipline: string;
  decidedAt: string;
}

export interface LegacyFamilyMapping {
  /** New family id → old (decided) family id: the old decision carries over (merge alias, not persisted). */
  aliases: Record<string, string>;
  /** View id (old id) → every old family id whose decision references are accepted as the same decision. */
  compatible: Map<string, Set<string>>;
  /** New family id → old decisions that do NOT agree with each other (or split evenly over families): "revisar". */
  review: Map<string, LegacyFamilyDecision[]>;
}

const decisionKey = (d: FamilyDecisionFields) => [d.validity, d.action, d.responsibleDiscipline, d.secondaryDiscipline ?? "", d.solutionOption ?? "", d.issueMode].join("|");

/**
 * Family ids are sha1(signature): when the signature changes (v6 → v7, G16) the decided families
 * of earlier versions get new ids. Old decisions are mapped to the new families through the ledger
 * references of the current clashes (`F-old@vN`) and, as a fallback, the groups each decision covered.
 *
 *  - every old decision that lands in one new family, all with the same fields → alias (carried over;
 *    instances still inherit only when unchanged and confirmed by policy, as before);
 *  - different decisions in one new family, or one old family split evenly over several → "revisar"
 *    (listed on the family, never applied, never silently lost).
 * A closure is never carried to a real instance by this mapping: inheritance and the batch keep
 * their own real → closure guards.
 */
export function legacyFamilyMapping(
  families: readonly FamilyRecord[],
  groups: readonly GroupRecord[],
  st: ModelSetFamilies,
  familyRefOf: (clashId: string) => string | undefined,
  /** Parts of an old family as recorded in the classification it was decided on (last fallback). */
  oldParts?: (familyId: string) => SignatureParts | undefined,
): LegacyFamilyMapping {
  const out: LegacyFamilyMapping = { aliases: {}, compatible: new Map(), review: new Map() };
  const current = new Set(families.map((f) => f.id));
  const isCurrent = (id: string) => current.has(id) || current.has(resolveAlias(st.aliases, id));
  const decided = (id: string) => {
    const d = currentDecision(st.families[id]);
    return d && d.status === "approved" ? d : undefined;
  };
  const famOfGroup = new Map<string, string>();
  for (const f of families) for (const g of f.groupIds) famOfGroup.set(g, f.id);
  const candidates = new Map<string, Map<string, number>>(); // old id → new id → weight
  const add = (oldId: string, newId: string | undefined, w = 1) => {
    if (!newId) return;
    const target = resolveAlias(st.aliases, oldId);
    if (isCurrent(target) || !decided(target)) return;
    const m = candidates.get(target) ?? new Map<string, number>();
    m.set(newId, (m.get(newId) ?? 0) + w);
    candidates.set(target, m);
  };
  for (const g of groups) {
    const nf = g.familyId ?? famOfGroup.get(g.id);
    for (const id of g.clashIds) {
      const ref = familyRefOf(id);
      const m = ref ? /^(F-[0-9A-Za-z]+)@v\d+$/.exec(ref) : null;
      if (m) add(m[1]!, nf);
    }
  }
  const gIds = new Set(groups.map((g) => g.id));
  for (const [oldId, fs] of Object.entries(st.families)) {
    if (candidates.has(resolveAlias(st.aliases, oldId))) continue;
    for (const v of fs.versions) if (v.status === "approved") for (const g of v.coveredGroupIds) if (gIds.has(g)) add(oldId, famOfGroup.get(g));
  }
  // Last fallback (no clash and no ubicación left in common): translate the old signature to today's.
  for (const oldId of Object.keys(st.families)) {
    const target = resolveAlias(st.aliases, oldId);
    if (candidates.has(target) || isCurrent(target) || !decided(target)) continue;
    const parts = oldParts?.(target);
    if (!parts) continue;
    const nid = familyIdOf(signatureOfParts(upgradeParts(parts)));
    if (current.has(nid)) add(target, nid);
  }
  // Each old family goes to the new family holding most of its clashes (a clash that moved to another
  // family since the decision is simply "changed" there, as before). A tie is ambiguous: "revisar".
  const byNew = new Map<string, string[]>();
  const spread = new Set<string>();
  for (const [oldId, m] of candidates) {
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const top = ranked.filter((x) => x[1] === ranked[0]![1]);
    if (top.length > 1) spread.add(oldId);
    for (const [n] of top) byNew.set(n, [...(byNew.get(n) ?? []), oldId]);
  }
  for (const [newId, olds] of byNew) {
    // A family decided under its new id, or already merged by a human, keeps what it has.
    if (decided(newId) || st.aliases[newId]) continue;
    const decs = olds.map((o) => ({ id: o, d: decided(o)! })).sort((a, b) => (a.d.decidedAt < b.d.decidedAt ? 1 : -1));
    const keys = new Set(decs.map((x) => decisionKey(x.d)));
    if (keys.size === 1 && !olds.some((o) => spread.has(o))) {
      out.aliases[newId] = decs[0]!.id;
      out.compatible.set(decs[0]!.id, new Set(olds));
    } else {
      out.review.set(newId, decs.map(({ id, d }) => ({ familyId: id, version: d.version, validity: d.validity, action: d.action, responsibleDiscipline: d.responsibleDiscipline, decidedAt: d.decidedAt })));
    }
  }
  return out;
}

/** Validity that a family decision would set on an instance (exceptions override). */
export function effectiveFields(dec: FamilyDecisionFields, ex?: FamilyException): FamilyDecisionFields {
  return ex ? { ...dec, ...ex.fields } : dec;
}

/** ACC issue description ≤ 1,000 chars with locations grouped by level. */
export function familyIssueDescription(view: Pick<FamilyView, "id" | "title" | "uniqueClashCount">, dec: FamilyDecisionFields, instances: readonly FamilyInstanceView[], max = 1000): string {
  const byLevel = new Map<string, number>();
  for (const i of instances) {
    const l = i.hostLevelLabel ?? i.levels[0] ?? "sin nivel";
    byLevel.set(l, (byLevel.get(l) ?? 0) + 1);
  }
  const loc = [...byLevel.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([l, n]) => `${l}: ${n}`).join(" · ");
  const head = `[${view.id}] ${view.title}. ${dec.solutionOption ? `Solución: ${dec.solutionOption}. ` : ""}${dec.typicalDetail ? `Detalle típico: ${dec.typicalDetail.name}${dec.typicalDetail.note ? ` (${dec.typicalDetail.note})` : ""}. ` : ""}`;
  const body = `${instances.length} ubicaciones, ${instances.reduce((n, i) => n + i.uniqueClashCount, 0)} interferencias. Ubicaciones por nivel: ${loc}.`;
  const s = `${head}${body}`;
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function assertFamilyInTest(views: readonly FamilyView[], familyId: string): FamilyView {
  const v = views.find((f) => f.id === familyId || f.mergedFrom.includes(familyId));
  if (!v) throw new CoordError("not_found", `Familia ${familyId} no existe en este test`);
  return v;
}
