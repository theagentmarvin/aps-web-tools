/**
 * Mock M4: the meeting agenda per responsible discipline, in the server's
 * fixed order (regresion → p1_pendiente → incidencia → nuevo →
 * confirmar_resuelta), notes on 2 items and one saved view. Deterministic.
 */
import type { AgendaDiscipline, AgendaItem, AgendaKind, FamilyGroup, IssueCheck, MeetingNote, Priority, SavedViewerView, TestRun, TriageFamily } from "../types";

const ORDER: AgendaKind[] = ["regresion", "p1_pendiente", "incidencia", "nuevo", "confirmar_resuelta"];
export const AGENDA_CAP = 8;

export function buildAgenda(
  test: TestRun,
  families: TriageFamily[],
  groups: FamilyGroup[],
  checks: IssueCheck[],
): { disciplines: AgendaDiscipline[]; notes: MeetingNote[]; views: SavedViewerView[] } {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const items: (AgendaItem & { discipline: string })[] = [];
  const used = new Set<string>();
  const famDisc = (f: TriageFamily) => f.proposed.responsibleDiscipline;
  const famPriority = (f: TriageFamily) => Math.min(...f.groupIds.map((g) => byId.get(g)?.priority ?? 4)) as Priority;
  const clashes = (ids: string[]) => ids.reduce((n, g) => n + (byId.get(g)?.clashIds.length ?? 0), 0);
  const count = (k: AgendaKind) => items.filter((i) => i.kind === k).length;
  const famItem = (f: TriageFamily, kind: AgendaKind, reason: string) => {
    items.push({ discipline: famDisc(f), kind, familyId: f.id, title: f.title, priority: famPriority(f), reason, counts: { instances: f.groupIds.length, clashes: clashes(f.groupIds) } });
    used.add(f.id);
  };

  for (const f of families) {
    const reappeared = f.groupIds.filter((g) => byId.get(g)?.change === "reappeared").length;
    if (reappeared && count("regresion") < 3) famItem(f, "regresion", `${reappeared} ubicaciones reaparecieron (estaban resueltas).`);
  }
  for (const f of families) if (!used.has(f.id) && famPriority(f) === 1 && !f.decision && count("p1_pendiente") < 4) famItem(f, "p1_pendiente", "P1 sin decisión de grupo.");
  for (const c of checks)
    if (c.verdict === "dice_resuelta" || (c.verdict === "sigue_abierta" && c.stuckCycles >= 2) || c.overdue)
      items.push({ discipline: c.discipline, kind: "incidencia", issueId: c.issueId, familyId: c.familyId, groupIds: c.groupIds, title: c.title, priority: c.priority ?? 3, reason: c.reason, counts: { clashes: c.existing, existing: c.existing, resolved: c.resolved } });
  for (const f of families) if (!used.has(f.id) && f.changeCounts?.new === f.groupIds.length && count("nuevo") < 3) famItem(f, "nuevo", "Grupo nuevo en esta versión.");
  for (const c of checks)
    if (c.verdict === "resuelta")
      items.push({ discipline: c.discipline, kind: "confirmar_resuelta", issueId: c.issueId, familyId: c.familyId, groupIds: c.groupIds, title: c.title, priority: c.priority ?? 4, reason: "Resuelta en el modelo: confirmar y mover a «En revisión» en ACC.", counts: { clashes: 0, existing: 0, resolved: c.resolved } });

  const byDisc = new Map<string, AgendaItem[]>();
  for (const { discipline, ...item } of items) byDisc.set(discipline, [...(byDisc.get(discipline) ?? []), item]);
  const disciplines: AgendaDiscipline[] = [...byDisc]
    .map(([discipline, list]) => {
      list.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.priority - b.priority);
      const n = (k: AgendaKind) => list.filter((i) => i.kind === k).length;
      const parts = [n("regresion") && `${n("regresion")} regresiones`, n("p1_pendiente") && `${n("p1_pendiente")} P1`, n("incidencia") && `${n("incidencia")} incidencias`, n("nuevo") && `${n("nuevo")} nuevos`, n("confirmar_resuelta") && `${n("confirmar_resuelta")} por confirmar`].filter(Boolean);
      return { discipline, summary: parts.join(" · "), items: list.slice(0, AGENDA_CAP), more: Math.max(0, list.length - AGENDA_CAP) };
    })
    .sort((a, b) => ORDER.indexOf(a.items[0].kind) - ORDER.indexOf(b.items[0].kind) || b.items.length - a.items.length);

  const at = new Date(Date.now() - 86400000).toISOString();
  const base = { testKey: test.id, version: test.modelSetVersion, author: "Camila Rojas", updatedAt: at, revision: 1 };
  const fam = items.find((i) => i.familyId && i.kind !== "incidencia");
  const issueGroup = items.find((i) => i.kind === "incidencia" && i.groupIds?.length);
  const notes: MeetingNote[] = [
    ...(fam?.familyId ? [{ ...base, targetType: "family" as const, targetId: fam.familyId, text: "CLI propone bajar el ducto 100 mm; ARQ revisa la altura de cielo antes del viernes." }] : []),
    ...(issueGroup?.groupIds?.[0] ? [{ ...base, targetType: "group" as const, targetId: issueGroup.groupIds[0], text: "El modelador dice que ya lo movió; pedir la versión nueva del modelo." }] : []),
  ];
  const views: SavedViewerView[] = fam?.familyId ? [{ testKey: test.id, familyId: fam.familyId, camera: { viewport: { eye: [10, 10, 10], target: [0, 0, 0] } }, savedBy: "Camila Rojas", savedAt: at }] : [];
  return { disciplines, notes, views };
}
