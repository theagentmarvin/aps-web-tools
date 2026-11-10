/**
 * M4 the meeting (F4): agenda (a server table, no LLM), meeting notes per grupo (family) /
 * ubicación (group), and saved viewer views. Local only; nothing goes to ACC.
 *
 *   .coordinator/meeting/<projectId>/<modelSetId>.json   { notes: MeetingNote[], views: SavedViewerView[] }
 */
import type * as C from "./api/contract";
import type { FamilyView } from "./families";
import type { Store } from "./store";
import { readJsonFile, writeJsonAtomic } from "./store/fs";
import type { GroupRecord } from "./store/types";
import { bareProjectId, CoordError } from "./util";

export const AGENDA_CAP = 15;
export const NOTE_MAX = 2000;
export const VIEW_MAX_BYTES = 20 * 1024;

interface MeetingFile {
  notes: C.MeetingNote[];
  views: C.SavedViewerView[];
}

export class MeetingStore {
  constructor(private readonly store: Store) {}

  path(projectId: string, modelSetId: string): string {
    const seg = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
    return this.store.path("meeting", seg(bareProjectId(projectId)), `${seg(modelSetId)}.json`);
  }

  async load(projectId: string, modelSetId: string): Promise<MeetingFile> {
    return (await readJsonFile<MeetingFile>(this.path(projectId, modelSetId))) ?? { notes: [], views: [] };
  }

  async mutate<T>(projectId: string, modelSetId: string, fn: (f: MeetingFile) => T): Promise<T> {
    return this.store.withLock(async () => {
      const f = await this.load(projectId, modelSetId);
      const r = fn(f);
      await writeJsonAtomic(this.path(projectId, modelSetId), f);
      return r;
    });
  }
}

/** Human note text: control characters removed, length checked. Stored verbatim otherwise (untrusted). */
export function cleanNote(text: string): string {
  // eslint-disable-next-line no-control-regex
  const t = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (t.length > NOTE_MAX) throw new CoordError("validation_error", `La nota supera ${NOTE_MAX} caracteres.`);
  return t;
}

export interface AgendaInput {
  version: number;
  baseVersion?: number;
  testKey: string;
  families: readonly FamilyView[];
  groups: readonly GroupRecord[];
  change: (g: GroupRecord) => C.ChangeKind;
  /** Still needs a human (engine gate, not decided, not inherited). */
  needsHuman: (g: GroupRecord) => boolean;
  issues: readonly C.IssueCheck[];
  cap?: number;
}

/** Agenda per responsible discipline, fixed order; each family / issue appears once (first kind wins). */
export function buildAgenda(input: AgendaInput): C.AgendaPayload {
  const cap = input.cap ?? AGENDA_CAP;
  const gById = new Map(input.groups.map((g) => [g.id, g]));
  const used = new Set<string>();
  const byDisc = new Map<string, Record<C.AgendaKind, C.AgendaItem[]>>();
  const bucket = (d: string) => {
    let b = byDisc.get(d);
    if (!b) byDisc.set(d, (b = { regresion: [], p1_pendiente: [], incidencia: [], nuevo: [], confirmar_resuelta: [] }));
    return b;
  };
  const famItem = (f: FamilyView, kind: C.AgendaKind, gs: GroupRecord[], reason: string): C.AgendaItem => ({
    kind,
    familyId: f.id,
    groupIds: gs.map((g) => g.id),
    title: f.title,
    priority: Math.min(...gs.map((g) => g.band)) as C.Priority,
    reason,
    counts: { instances: gs.length, clashes: gs.reduce((n, g) => n + (g.uniqueClashCount ?? g.clashIds.length), 0) },
  });
  const disc = (f: FamilyView) => f.decision?.status === "approved" ? f.decision.responsibleDiscipline : f.proposed.responsibleDiscipline;
  const fams = input.families.filter((f) => f.bucket !== "non_issue");
  const members = (f: FamilyView) => f.groupIds.map((id) => gById.get(id)).filter((g): g is GroupRecord => !!g);

  // 1. Regressions.
  for (const f of fams) {
    const gs = members(f).filter((g) => input.change(g) === "reappeared");
    if (!gs.length) continue;
    used.add(f.id);
    bucket(disc(f)).regresion.push(famItem(f, "regresion", gs, `Reapareció en v${input.version}: ${gs.length} ubicación(es).`));
  }
  // 2. P1 families still pending.
  for (const f of fams) {
    if (used.has(f.id)) continue;
    const gs = members(f).filter((g) => g.band === 1 && input.needsHuman(g));
    if (!gs.length) continue;
    used.add(f.id);
    bucket(disc(f)).p1_pendiente.push(famItem(f, "p1_pendiente", gs, `P1 sin decidir: ${gs.length} ubicación(es).`));
  }
  // 3. Issues: says resolved but clashes remain, stuck P1, overdue.
  for (const c of input.issues) {
    const why = c.verdict === "dice_resuelta" ? `ACC la marca resuelta y siguen ${c.existing} interferencias.` : c.stuck ? `P1 sin avance hace ${c.stuckCycles} ciclos.` : c.overdue && c.verdict !== "resuelta" ? `Vencida (${c.dueDate ?? "?"}), quedan ${c.existing}.` : undefined;
    if (!why) continue;
    used.add(`issue:${c.issueId}`);
    bucket(c.discipline).incidencia.push({ kind: "incidencia", ...(c.familyId ? { familyId: c.familyId } : {}), groupIds: c.groupIds, issueId: c.issueId, title: c.title, priority: c.priority ?? 2, reason: why, counts: { clashes: c.existing + c.resolved, existing: c.existing, resolved: c.resolved } });
  }
  // 4. New grupos (Qué cambió) still pending.
  for (const f of fams) {
    if (used.has(f.id)) continue;
    const gs = members(f).filter((g) => input.change(g) === "new" && input.needsHuman(g));
    if (!gs.length) continue;
    used.add(f.id);
    bucket(disc(f)).nuevo.push(famItem(f, "nuevo", gs, `Nueva: ${gs.length} ubicación(es).`));
  }
  // 5. Resolved verdicts to confirm (F2).
  for (const c of input.issues) {
    if (c.verdict !== "resuelta" || c.decision || used.has(`issue:${c.issueId}`)) continue;
    bucket(c.discipline).confirmar_resuelta.push({ kind: "confirmar_resuelta", ...(c.familyId ? { familyId: c.familyId } : {}), groupIds: c.groupIds, issueId: c.issueId, title: c.title, priority: c.priority ?? 3, reason: "Resuelta en el modelo: confirmar y mover en ACC.", counts: { clashes: c.resolved, existing: 0, resolved: c.resolved } });
  }

  const order: C.AgendaKind[] = ["regresion", "p1_pendiente", "incidencia", "nuevo", "confirmar_resuelta"];
  const sortItems = (xs: C.AgendaItem[]) => xs.sort((a, b) => a.priority - b.priority || b.counts.clashes - a.counts.clashes || a.title.localeCompare(b.title));
  const disciplines: C.AgendaDiscipline[] = [...byDisc].map(([discipline, b]) => {
    const all = order.flatMap((k) => sortItems(b[k]));
    const n = (k: C.AgendaKind) => b[k].length;
    return {
      discipline,
      items: all.slice(0, cap),
      more: Math.max(0, all.length - cap),
      // Only what is there, singular/plural right: "ALC: 6 P1 pendientes, 1 reaparecida."
      summary: `${discipline}: ${
        (
          [
            [n("regresion"), "reaparecida", "reaparecidas"],
            [n("p1_pendiente"), "P1 pendiente", "P1 pendientes"],
            [n("incidencia"), "incidencia a revisar", "incidencias a revisar"],
            [n("nuevo"), "nueva", "nuevas"],
            [n("confirmar_resuelta"), "resuelta por confirmar", "resueltas por confirmar"],
          ] as Array<[number, string, string]>
        )
          .filter(([c]) => c > 0)
          .map(([c, one, many]) => `${c} ${c === 1 ? one : many}`)
          .join(", ") || "sin temas"
      }.`,
    };
  });
  const weight = (d: C.AgendaDiscipline) => d.items.filter((i) => i.kind === "regresion" || i.kind === "p1_pendiente").length;
  disciplines.sort((a, b) => weight(b) - weight(a) || b.items.length + b.more - (a.items.length + a.more) || a.discipline.localeCompare(b.discipline));
  return { testId: input.testKey, version: input.version, ...(input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {}), cap, disciplines };
}
