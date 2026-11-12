/**
 * Regrouping proposals (propose_group_action: move_groups, detach_clashes, merge_families,
 * split_family). The agent only proposes; a human applies them in the UI with the existing
 * family merge (aliases) / detach (detached instances) mechanics. Validation runs at proposal time
 * and again at apply time against the current families.
 */
import type { ClassificationRecord } from "./store/types";
import { CLOSABLE } from "./engine";
import type { FamilyView, ModelSetFamilies } from "./families";
import { assertFamilyInTest } from "./families";
import { CoordError, sha256 } from "./util";

export const REGROUP_TYPES = ["move_groups", "detach_clashes", "merge_families", "split_family"] as const;
export type RegroupType = (typeof REGROUP_TYPES)[number];

export type RegroupAction =
  | { type: "move_groups"; groupIds: string[]; toFamilyId?: string; newFamilyLabel?: string }
  | { type: "detach_clashes"; clashIds: string[]; newGroupLabel?: string }
  | { type: "merge_families"; familyIds: string[] }
  | { type: "split_family"; familyId: string; groupPartitions: string[][] };

export function isRegroup(a: { type: string }): boolean {
  return (REGROUP_TYPES as readonly string[]).includes(a.type);
}

const closable = (v: string | undefined) => !!v && (CLOSABLE as readonly string[]).includes(v);
/** Validity the family will be closed / handled with: the approved decision, else the engine's proposal. */
const familyValidity = (f: FamilyView) => (f.decision?.status === "approved" ? f.decision.validity : f.proposed.validity);
const hasReal = (f: FamilyView) => (f.validityMix.real ?? 0) > 0 || familyValidity(f) === "real";

/** One planned mutation of the model set's family state. */
export interface RegroupPlan {
  aliases: Record<string, string>;
  detached: Record<string, string>;
  labels: Record<string, string>;
  targetIds: string[];
}

/** Validate a regroup action against the current families; returns what applying it would change. */
export function planRegroup(a: RegroupAction, cls: ClassificationRecord, views: readonly FamilyView[], seed: string): RegroupPlan {
  const famOfGroup = new Map(views.flatMap((f) => f.groupIds.map((g) => [g, f] as const)));
  const gById = new Map(cls.groups.map((g) => [g.id, g]));
  const newId = (i: number) => `F-M${sha256(`${seed}|${i}`).slice(0, 9)}`;
  const plan: RegroupPlan = { aliases: {}, detached: {}, labels: {}, targetIds: [] };
  const needGroups = (ids: string[]) => {
    const missing = ids.filter((g) => !gById.has(g));
    if (missing.length) throw new CoordError("not_found", `Grupos inexistentes: ${missing.slice(0, 5).join(", ")}`);
    const noFam = ids.filter((g) => !famOfGroup.has(g));
    if (noFam.length) throw new CoordError("validation_error", `Grupos sin familia: ${noFam.slice(0, 5).join(", ")}`);
  };
  switch (a.type) {
    case "move_groups": {
      if (!!a.toFamilyId === !!a.newFamilyLabel) throw new CoordError("validation_error", "Indica toFamilyId o newFamilyLabel (solo uno).");
      needGroups(a.groupIds);
      if (a.toFamilyId) {
        const to = assertFamilyInTest(views, a.toFamilyId);
        const already = a.groupIds.filter((g) => famOfGroup.get(g)!.id === to.id);
        if (already.length) throw new CoordError("validation_error", `Ya pertenecen a ${to.id}: ${already.slice(0, 5).join(", ")}`);
        const real = a.groupIds.filter((g) => gById.get(g)!.validity === "real");
        if (real.length && closable(familyValidity(to))) throw new CoordError("validation_error", `No se puede mover un grupo real (${real.slice(0, 3).join(", ")}) a ${to.id}, que es ${familyValidity(to)} (cerrable).`);
        for (const g of a.groupIds) plan.detached[g] = to.id;
        plan.targetIds.push(to.id, ...a.groupIds);
      } else {
        const id = newId(0);
        for (const g of a.groupIds) plan.detached[g] = id;
        plan.labels[id] = a.newFamilyLabel!;
        plan.targetIds.push(id, ...a.groupIds);
      }
      return plan;
    }
    case "detach_clashes": {
      const ids = [...new Set(a.clashIds.map((c) => c.replace(/^C-/, "")))];
      const byId = new Map(cls.clashes.map((c) => [c.id, c]));
      const missing = ids.filter((c) => !byId.has(c));
      if (missing.length) throw new CoordError("not_found", `Clashes inexistentes: ${missing.slice(0, 5).join(", ")}`);
      const groups = [...new Set(ids.map((c) => byId.get(c)!.groupId))];
      needGroups(groups);
      // Families are made of whole groups (ubicaciones): a partial group cannot be moved on its own.
      const sel = new Set(ids);
      const partial = groups.filter((g) => !gById.get(g)!.clashIds.every((c) => sel.has(c)));
      if (partial.length) {
        throw new CoordError(
          "validation_error",
          `Los clashes no cubren grupos completos (${partial.slice(0, 3).join(", ")}). Separa ubicaciones completas o propone un split del grupo.`,
          "Usa move_groups con los grupos completos o la acción split para dividir un grupo.",
        );
      }
      const id = newId(0);
      for (const g of groups) plan.detached[g] = id;
      if (a.newGroupLabel) plan.labels[id] = a.newGroupLabel;
      plan.targetIds.push(id, ...groups);
      return plan;
    }
    case "merge_families": {
      const fams = [...new Map(a.familyIds.map((id) => assertFamilyInTest(views, id)).map((f) => [f.id, f])).values()];
      if (fams.length < 2) throw new CoordError("validation_error", "Indica al menos dos familias distintas.");
      const [into, ...from] = fams as [FamilyView, ...FamilyView[]];
      const decided = from.filter((f) => f.decision?.status === "approved");
      if (decided.length) throw new CoordError("invalid_state", `${decided.map((f) => f.id).join(", ")} ya tiene una decisión; la primera familia (${into.id}) es la que se conserva.`);
      if (closable(familyValidity(into))) {
        const real = from.filter(hasReal);
        if (real.length) throw new CoordError("validation_error", `No se puede fusionar ${real.map((f) => f.id).join(", ")} (con grupos reales) en ${into.id}, que es ${familyValidity(into)} (cerrable).`);
      }
      for (const f of from) plan.aliases[f.id] = into.id;
      plan.targetIds.push(into.id, ...from.map((f) => f.id));
      return plan;
    }
    case "split_family": {
      const f = assertFamilyInTest(views, a.familyId);
      const all = a.groupPartitions.flat();
      if (new Set(all).size !== all.length) throw new CoordError("validation_error", "Un grupo aparece en más de una parte.");
      const outside = all.filter((g) => !f.groupIds.includes(g));
      if (outside.length) throw new CoordError("validation_error", `Grupos fuera de ${f.id}: ${outside.slice(0, 5).join(", ")}`);
      // The first part keeps the family (with any group not listed); each other part becomes a new family.
      a.groupPartitions.slice(1).forEach((part, i) => {
        const id = newId(i + 1);
        for (const g of part) plan.detached[g] = id;
        plan.targetIds.push(id);
      });
      plan.targetIds.unshift(f.id);
      return plan;
    }
  }
}

/** Apply a plan to the family state (inside FamilyDecisionStore.update). */
export function applyPlan(st: ModelSetFamilies, plan: RegroupPlan, by: string, at: string): void {
  for (const [from, into] of Object.entries(plan.aliases)) st.aliases[from] = into;
  for (const [g, familyId] of Object.entries(plan.detached)) st.detached[g] = { familyId, by, at };
  if (Object.keys(plan.labels).length) st.labels = { ...(st.labels ?? {}), ...plan.labels };
}

export function regroupSummary(a: RegroupAction): string {
  switch (a.type) {
    case "move_groups": return `mover ${a.groupIds.length} ubicación(es) a ${a.toFamilyId ?? "una familia nueva"}`;
    case "detach_clashes": return `separar ${a.clashIds.length} clash(es) en un grupo nuevo`;
    case "merge_families": return `fusionar ${a.familyIds.slice(1).join(", ")} en ${a.familyIds[0]}`;
    case "split_family": return `dividir ${a.familyId} en ${a.groupPartitions.length} familias`;
  }
}
