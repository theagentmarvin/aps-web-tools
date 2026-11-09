/**
 * Mock M3: issue checks (one per ACC issue linked to assigned groups) with
 * every verdict, an overdue one, one stuck 2 cycles, two disciplines, and a
 * reminder text per discipline. Deterministic.
 */
import type { DisciplineReminder, FamilyGroup, IssueCheck, IssueVerdict, Proposal, TestRun } from "../types";

const VERDICTS: IssueVerdict[] = ["dice_resuelta", "sigue_abierta", "avance", "resuelta", "no_verificable"];

const REASON: Record<IssueVerdict, (c: { existing: number; resolved: number }) => string> = {
  resuelta: (c) => `Las ${c.resolved} interferencias de la incidencia ya no aparecen y no hay nuevas en los mismos elementos.`,
  avance: (c) => `Quedan ${c.existing} de ${c.existing + c.resolved} interferencias; el resto se resolvió.`,
  sigue_abierta: (c) => `Las ${c.existing} interferencias siguen igual que en la versión anterior.`,
  dice_resuelta: (c) => `La incidencia está cerrada o en revisión en ACC, pero ${c.existing} interferencias siguen en el modelo.`,
  no_verificable: () => "El modelo responsable no tiene versión nueva desde que se creó la incidencia.",
};

export function buildIssueChecks(test: TestRun, groups: FamilyGroup[], proposals: Proposal[]): { checks: IssueCheck[]; reminders: DisciplineReminder[] } {
  const owner = new Map(proposals.map((p) => [p.targetId, p.fields.owner.value]));
  const byIssue = new Map<string, FamilyGroup[]>();
  for (const g of groups) if (g.acc?.status === "assigned" || g.acc?.status === "mixed") for (const id of g.acc.issueIds) byIssue.set(id, [...(byIssue.get(id) ?? []), g]);
  const checks: IssueCheck[] = [];
  let i = 0;
  for (const [issueId, gs] of byIssue) {
    const verdict = VERDICTS[i % VERDICTS.length];
    const total = gs.reduce((n, g) => n + g.clashIds.length, 0);
    const existing = verdict === "resuelta" ? 0 : verdict === "avance" ? Math.max(1, Math.round(total / 3)) : total;
    const resolved = verdict === "resuelta" ? total : verdict === "avance" ? total - existing : 0;
    // Two disciplines at least: alternate between the proposal owner and the pair's first discipline.
    const discipline = i % 2 === 0 ? (owner.get(gs[0].id) ?? gs[0].pair[0]) : gs[0].pair[0] === (owner.get(gs[0].id) ?? "") ? gs[0].pair[1] : gs[0].pair[0];
    const due = new Date(Date.now() + (i === 1 ? -5 : 7 + i) * 86400000).toISOString().slice(0, 10);
    checks.push({
      issueId,
      title: `[${gs[0].pair.join("×")}] ${gs[0].title}`.slice(0, 120),
      accStatus: verdict === "dice_resuelta" ? "in_review" : verdict === "resuelta" ? "open" : "open",
      dueDate: due,
      overdue: i === 1,
      familyId: gs[0].familyId,
      groupIds: gs.map((g) => g.id),
      discipline,
      existing,
      resolved,
      verdict,
      reason: REASON[verdict]({ existing, resolved }),
      evidence: `Verificación v${test.modelSetVersion} · incidencia ${issueId}\n${REASON[verdict]({ existing, resolved })}\nInterferencias: ${existing} siguen · ${resolved} resueltas (${total} en la incidencia).`,
      accGroupIds: gs.map((g) => `ACC-${g.id}`),
      checks: {
        // dice_resuelta: the problem moved (an element of the resolved set clashes again).
        displacement: verdict === "dice_resuelta" ? "blocked" : "ok",
        modelAge: verdict === "no_verificable" ? "stale" : "ok",
        scope: "ok",
      },
      stuckCycles: verdict === "sigue_abierta" ? 2 : 0,
      stuck: verdict === "sigue_abierta" && gs.some((g) => g.priority === 1),
      priority: Math.min(...gs.map((g) => g.priority)) as IssueCheck["priority"],
    });
    i++;
  }
  const byDisc = new Map<string, IssueCheck[]>();
  for (const c of checks) byDisc.set(c.discipline, [...(byDisc.get(c.discipline) ?? []), c]);
  const reminders: DisciplineReminder[] = [...byDisc].map(([discipline, cs]) => ({
    discipline,
    issueIds: cs.map((c) => c.issueId),
    counts: {
      total: cs.length,
      overdue: cs.filter((c) => c.overdue).length,
      diceResuelta: cs.filter((c) => c.verdict === "dice_resuelta").length,
      sigueAbierta: cs.filter((c) => c.verdict === "sigue_abierta").length,
      avance: cs.filter((c) => c.verdict === "avance").length,
    },
    text: [
      `Recordatorio de coordinación ${discipline} · v${test.modelSetVersion}`,
      ...cs.filter((c) => c.verdict !== "resuelta").map((c) => `· ${c.issueId}: ${c.existing} interferencias siguen${c.overdue ? " (vencida)" : ""}${c.stuckCycles >= 2 ? ` (sin avance ${c.stuckCycles} ciclos)` : ""}`),
      `Resueltas: ${cs.filter((c) => c.verdict === "resuelta").map((c) => c.issueId).join(", ") || "—"}.`,
    ].join("\n"),
  }));
  return { checks, reminders };
}
