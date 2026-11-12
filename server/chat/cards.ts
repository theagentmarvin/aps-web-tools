/**
 * Chat cards (G12): what a proposal / question card shows — action, validity, target name and
 * clash count — built ONLY from the store (never from the model's text), so the card reads
 * "Crear incidencia · Conflicto" over "Grupo: Ductos CLI × vigas EST · 12 interferencias".
 */
import type * as C from "../api/contract";
import type { Coordinator } from "../coordinator";
import { proposalSummary } from "../coordinator";
import { questionView } from "../questions";
import { sanitizeModelText } from "../sanitize";
import type { ClassificationRecord, ProposalRecord } from "../store/types";

type Target = NonNullable<C.ChatCard["target"]>;

function targetOf(cls: ClassificationRecord | undefined, ids: { familyId?: string; groupIds: string[]; clashIds: string[] }): Target | undefined {
  if (!cls) return undefined;
  const groups = new Map(cls.groups.map((g) => [g.id, g]));
  const families = cls.families ?? [];
  const count = (gids: string[]) => gids.reduce((n, id) => n + (groups.get(id)?.clashIds.length ?? 0), 0);
  const fam = ids.familyId ? families.find((f) => f.id === ids.familyId) : undefined;
  if (fam) return { kind: "family", id: fam.id, label: sanitizeModelText(fam.title, 120), clashCount: fam.uniqueClashCount, groupCount: fam.groupIds.length };
  const gids = ids.groupIds.filter((g) => groups.has(g));
  if (gids.length === 1) {
    const g = groups.get(gids[0]!)!;
    return { kind: "group", id: g.id, label: sanitizeModelText(g.title, 120), clashCount: g.clashIds.length };
  }
  if (gids.length > 1) {
    // Several ubicaciones: their grupo when they all belong to one.
    const f = families.find((x) => gids.every((g) => x.groupIds.includes(g)));
    if (f) return { kind: "family", id: f.id, label: sanitizeModelText(f.title, 120), clashCount: count(gids), groupCount: gids.length };
    const g = groups.get(gids[0]!)!;
    return { kind: "group", id: g.id, label: sanitizeModelText(g.title, 120), clashCount: count(gids), groupCount: gids.length };
  }
  const cid = ids.clashIds.find((c) => cls.clashes.some((x) => x.id === c));
  if (cid) return { kind: "clash", id: cid, label: cid, clashCount: ids.clashIds.length };
  return undefined;
}

function proposalFields(p: ProposalRecord): Pick<C.ChatCard, "action" | "validity" | "title"> {
  const pl = p.payload;
  switch (pl.kind) {
    case "classification":
      return { action: pl.suggestedAction ?? "classify", validity: pl.validity };
    case "family_decision":
      return { action: pl.action, validity: pl.validity };
    case "status_change":
      return { action: pl.action };
    case "issue_draft":
      return { action: "issue", validity: "real", title: sanitizeModelText(pl.issue.title, 120) };
    case "group_action":
      return { action: "regroup", title: sanitizeModelText(proposalSummary(p), 160) };
    default:
      return { title: sanitizeModelText(proposalSummary(p), 160) };
  }
}

/** Card of one proposal / question id (undefined when it does not exist). */
export async function chatCard(coord: Coordinator, id: string, kind: "proposal" | "question", cache = new Map<string, ClassificationRecord | undefined>()): Promise<C.ChatCard | undefined> {
  const cls = async (testKey?: string) => {
    if (!testKey) return undefined;
    if (!cache.has(testKey)) cache.set(testKey, await coord.store.getClassification(testKey).catch(() => undefined));
    return cache.get(testKey);
  };
  if (kind === "question") {
    const q = await coord.questions.get(id);
    if (!q) return undefined;
    const view = questionView(q);
    const target = targetOf(await cls(q.testKey), { ...(q.familyId ? { familyId: q.familyId } : {}), groupIds: q.groupIds, clashIds: q.clashIds });
    return { id, kind: "question", title: sanitizeModelText(q.question, 300), state: q.state, ...(target ? { target } : {}), question: view };
  }
  const p = await coord.store.getProposal(id).catch(() => undefined);
  if (!p) return undefined;
  const familyId = p.payload.kind === "family_decision" ? p.payload.familyId : undefined;
  const target = targetOf(await cls(p.testKey), { ...(familyId ? { familyId } : {}), groupIds: p.target.groupIds, clashIds: p.target.clashIds });
  return { id, kind: p.kind, state: p.state, ...proposalFields(p), ...(target ? { target } : {}) };
}
