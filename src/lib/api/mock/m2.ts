/**
 * Mock M2 data: inherited decisions (F1) and coordinator questions (X3),
 * derived deterministically from the generated groups.
 */
import type { AgentQuestion, FamilyGroup, InheritedDecision, TestRun } from "../types";

export interface M2Data {
  baseVersion?: number;
  questions: AgentQuestion[];
}

const SOURCES: InheritedDecision["source"][] = ["human", "family", "acc"];

/** Mutates groups (inherited, questionIds) and returns the questions. */
export function applyM2(test: TestRun, groups: FamilyGroup[], firstTest: boolean): M2Data {
  if (firstTest) return { questions: [] };
  const base = test.modelSetVersion - 1;
  const at = new Date(Date.now() - 7 * 86400000).toISOString();
  let k = 0;
  groups.forEach((g, i) => {
    // Unchanged ubicaciones decided on the base version: carried forward.
    const unchanged = g.change === "unchanged";
    const changedWithDecision = g.change === "changed" && i % 4 === 0;
    if ((unchanged && i % 3 === 0) || changedWithDecision) {
      const source = SOURCES[k++ % 3];
      const effect = g.validity === "real" ? "issue" : g.validity === "false_positive" ? "close" : "none";
      g.inherited = {
        fromVersion: base,
        source,
        decision: source === "acc" ? (effect === "close" ? "closed" : "assigned") : source === "family" ? (effect === "issue" ? "create_issue" : effect === "close" ? "close" : "mark_reviewed") : "accept",
        validity: g.validity,
        effect,
        decidedAt: at,
        decidedBy: source === "human" ? "Camila Rojas" : undefined,
        ref: source === "family" ? `${g.familyId ?? "F-?"} v1` : source === "acc" ? `ACC-${g.id}` : `D-${g.id}`,
        // Pilot fix: a decision carried onto changed / reappeared clashes is only a proposal to confirm.
        ...(changedWithDecision ? { needsConfirmation: true } : {}),
      };
    }
  });

  const pick = (pred: (g: FamilyGroup) => boolean, skip = 0) => groups.filter(pred)[skip];
  const qUnchanged = pick((g) => g.change === "unchanged" && !g.inherited && g.validity === "needs_info") ?? pick((g) => g.change === "unchanged" && !g.inherited);
  // The action question sits in a grupo with ≥ 5 ubicaciones, so answering it needs an explicit confirmation (> 3).
  const famSize = (g: FamilyGroup) => groups.filter((x) => x.familyId && x.familyId === g.familyId).length;
  const qChanged = pick((g) => g.change === "changed" && !g.inherited && g !== qUnchanged && famSize(g) >= 5) ?? pick((g) => g.change === "changed" && !g.inherited && g !== qUnchanged);
  const qOther = pick((g) => g.change === "new" && g !== qUnchanged && g !== qChanged, 2);
  const now = new Date(Date.now() - 3600_000).toISOString();
  const questions: AgentQuestion[] = [];
  type QuestionInput = Omit<AgentQuestion, "id" | "testKey" | "version" | "groupIds" | "clashIds" | "state" | "createdBy" | "createdAt" | "affectedGroups"> & { groupIds?: string[] };
  const add = (g: FamilyGroup | undefined, input: QuestionInput) => {
    const { groupIds, ...q } = input;
    if (!g) return;
    const id = `Q-${String(questions.length + 1).padStart(3, "0")}`;
    const ids = groupIds ?? [g.id];
    // Structured options (pilot fix): the server says what each option decides; the UI never parses text.
    questions.push({ id, testKey: test.id, version: test.modelSetVersion, familyId: g.familyId, groupIds: ids, clashIds: g.clashIds.slice(0, 5), state: "open", createdBy: "agent", createdAt: now, affectedGroups: ids.length, ...q });
    for (const gid of ids.slice(1)) {
      const other = groups.find((x) => x.id === gid);
      if (other) other.questionIds = [...(other.questionIds ?? []), id];
    }
    g.questionIds = [...(g.questionIds ?? []), id];
  };
  add(qUnchanged, {
    kind: "validity",
    question: "No hay propiedades suficientes para saber si el ducto pasa por una pasada prevista. ¿Es una interferencia real?",
    options: [
      { label: "Sí, es real", validity: "real" },
      { label: "No, hay pasada prevista (falso positivo)", validity: "false_positive" },
      { label: "Tolerable en obra", validity: "tolerated" },
    ],
  });
  add(qChanged, {
    kind: "action",
    question: "La penetración subió desde la versión anterior. ¿Creo una incidencia o lo dejo como revisado?",
    options: [
      { label: "Crear incidencia", action: "create_issue" },
      { label: "Marcar revisada", action: "mark_reviewed" },
      { label: "Posponer a la reunión", action: "postpone" },
    ],
    // Decides 5 ubicaciones of the same grupo: needs an explicit confirmation (confirmCount).
    groupIds: qChanged && qChanged.familyId ? [qChanged, ...groups.filter((x) => x.familyId === qChanged.familyId && x.id !== qChanged.id)].slice(0, 5).map((x) => x.id) : undefined,
  });
  add(qOther, {
    kind: "other",
    question: "¿Quién es el responsable de las escalerillas en el núcleo de ascensores? El modelo no indica la especialidad.",
  });
  return { baseVersion: base, questions };
}
