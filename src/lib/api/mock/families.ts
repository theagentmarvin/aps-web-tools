/**
 * Mock "F1 familias" step (docs/domain/solution-families-proposal.md §2, §5.4):
 * derives solution families from the generated groups so the tree, the family
 * panel and the approval guard can be exercised offline. Deterministic.
 *
 * Simplified signature: problemType | hostKey | moverClass | systemClass | relation.
 * Validity is NOT part of it (it is the decision), so mixed families appear.
 */
import { categoryNoun } from "~/lib/category-names";
import { PROBLEM_TYPES } from "~/lib/problem-types";
import type { Clash, ClashGroup, FamilyAction, FamilyGroup, Priority, ProblemTypeCode, Proposal, TriageFamily, Validity } from "../types";
import { fakeHash } from "./reports";
import { familyM1 } from "./m1";

const STRUCT = new Set(["Structural Framing", "Floors", "Structural Columns", "Structural Foundations"]);
const EQUIP = new Set(["Mechanical Equipment", "Plumbing Fixtures", "Electrical Equipment", "Specialty Equipment"]);
const GRAVITY = new Set(["ALC", "ALL", "SAN"]);

/** Host/mover rank (§2.1): higher = host. */
function rank(c: Clash["a"]): number {
  if (c.discipline === "EST" || STRUCT.has(c.category)) return 100;
  if (EQUIP.has(c.category)) return 95;
  if (/Pipe/.test(c.category) && GRAVITY.has(c.discipline)) return 90;
  if (c.discipline === "ARQ") return 85;
  if (/Duct|Air Terminal/.test(c.category)) return 60;
  if (/Pipe|Sprinkler/.test(c.category)) return 40;
  return 30;
}

function moverClass(category: string, discipline: string): string {
  if (/Pipe/.test(category)) return GRAVITY.has(discipline) ? "tub_grav" : "tub_pres";
  if (/Duct|Air Terminal/.test(category)) return "ducto";
  if (/Cable|Conduit|Lighting|Electrical/.test(category)) return "elec";
  return category;
}

function problemTypeFor(host: Clash["a"], g: ClashGroup, mover: Clash["a"]): ProblemTypeCode {
  if (g.nature === "duplicate") return "PT12";
  if (g.ruleIds.some((r) => r.startsWith("HYG"))) return "PT13";
  if (g.nature === "clearance") return "PT10";
  switch (host.category) {
    case "Structural Framing":
      return g.penetrationMaxMm >= 200 ? "PT01" : "PT02";
    case "Floors":
      return /Duct/.test(mover.category) ? "PT04" : g.penetrationMaxMm > 150 ? "PT04" : "PT05";
    case "Structural Columns":
      return "PT03";
    case "Structural Foundations":
      return "PT07";
    case "Walls":
      return host.discipline === "EST" ? "PT06" : "PT11";
    case "Ceilings":
    case "Doors":
    case "Windows":
    case "Stairs":
      return "PT11";
  }
  if (EQUIP.has(host.category)) return "PT09";
  if (/Pipe|Duct|Cable|Conduit/.test(host.category)) return "PT08";
  return "PT00";
}

function relationFor(pt: ProblemTypeCode, penMax: number): string {
  if (pt === "PT01" || pt === "PT02") return penMax <= 100 ? "desplazar≤100" : penMax <= 250 ? "desplazar101–250" : "desplazar>250";
  if (pt === "PT04") return "vertical";
  if (pt === "PT05") return penMax <= 100 ? "horiz_pend·desplazar≤100" : "horiz_pend·desplazar>100";
  if (pt === "PT07") return "fundación";
  if (pt === "PT09") return "contacto_equipo";
  if (pt === "PT08") return "cruce";
  return "atraviesa";
}

const VERB: Partial<Record<ProblemTypeCode, string>> = {
  PT01: "atraviesan el alma de",
  PT02: "invaden la franja inferior de",
  PT03: "atraviesan",
  PT04: "cruzan sin pasada",
  PT05: "quedan embebidas en",
  PT06: "atraviesan",
  PT07: "tocan",
  PT08: "cruzan",
  PT09: "chocan con",
  PT10: "invaden la holgura de",
  PT11: "interfieren con",
  PT12: "duplican",
  PT13: "sin información en",
};

const HINT: Partial<Record<ProblemTypeCode, string>> = {
  PT01: "pasada o desvío",
  PT02: "bajar ≤100 mm",
  PT03: "desviar",
  PT04: "pasada tipo",
  PT05: "bajar al entretecho",
  PT06: "pasada aprobada",
  PT08: "mueve la de menor jerarquía",
  PT09: "revisar conexión",
};

function title(pt: ProblemTypeCode, host: Clash["a"], mover: Clash["a"], hostType: string | undefined, relation: string): string {
  const movers = categoryNoun(mover.category, 2, "es");
  const hostNoun = categoryNoun(host.category, 2, "es");
  const hostTxt = hostType && !hostType.toLowerCase().startsWith(categoryNoun(host.category, 1, "es").toLowerCase()) ? `${hostNoun} ${hostType}` : hostType ? `${hostNoun} ${hostType.replace(/^S+s/, "")}` : hostNoun;
  const base = `${movers.charAt(0).toUpperCase()}${movers.slice(1)} ${mover.discipline} ${VERB[pt] ?? "interfieren con"} ${hostTxt}`;
  const shift = /desplazar(.*)$/.exec(relation)?.[1];
  const hint = (pt === "PT01" || pt === "PT02") && shift ? `bajar ${shift} mm` : HINT[pt];
  return hint ? `${base} · ${hint}` : base;
}

function familyAction(v: Validity, pt: ProblemTypeCode): FamilyAction {
  if (pt === "PT12" || pt === "PT13") return "hygiene_issue";
  return v === "real" ? "create_issue" : v === "false_positive" ? "close" : v === "tolerated" ? "mark_reviewed" : "escalate";
}

function levelNum(level: string | undefined): number {
  const m = /(-?\d+)/.exec(level ?? "");
  return m ? Number(m[1]) : 0;
}

/** Derive families; returns them plus the groups with the new §5.3 fields. */
export function deriveFamilies(groups: ClashGroup[], clashes: Clash[], proposals: Proposal[]): { families: TriageFamily[]; groups: FamilyGroup[] } {
  const byGroup = new Map<string, Clash[]>();
  for (const c of clashes) byGroup.set(c.groupId, [...(byGroup.get(c.groupId) ?? []), c]);
  const proposalOf = new Map(proposals.map((p) => [p.targetId, p]));

  interface Acc {
    sig: string;
    pt: ProblemTypeCode;
    host: Clash["a"];
    mover: Clash["a"];
    hostKey: string;
    mClass: string;
    relation: string;
    groups: FamilyGroup[];
  }
  const fams = new Map<string, Acc>();
  const out: FamilyGroup[] = [];

  for (const g of groups) {
    const first = byGroup.get(g.id)?.[0];
    if (!first) {
      out.push({ ...g });
      continue;
    }
    const [host, mover] = rank(first.a) >= rank(first.b) ? [first.a, first.b] : [first.b, first.a];
    const pt = problemTypeFor(host, g, mover);
    const typed = host.category === "Structural Framing" || host.category === "Floors" || host.category === "Walls";
    const hostKey = typed ? `${host.category}:${host.type ?? ""}` : host.category;
    const mClass = moverClass(mover.category, mover.discipline);
    const relation = relationFor(pt, g.penetrationMaxMm);
    const sig = [pt, hostKey, mClass, mover.discipline, relation].join(" | ");
    const fg: FamilyGroup = {
      ...g,
      problemType: pt,
      signature: sig,
      uniqueClashCount: g.clashIds.length,
      hostLevelLabel: host.category === "Structural Framing" && g.location?.level ? `Entretecho bajo ${g.location.level} (viga ${g.location.level})` : undefined,
      inheritance: { state: "none" },
    };
    out.push(fg);
    const acc = fams.get(sig) ?? { sig, pt, host, mover, hostKey, mClass, relation, groups: [] };
    acc.groups.push(fg);
    fams.set(sig, acc);
  }

  const families: TriageFamily[] = [];
  for (const acc of fams.values()) {
    const id = `F-${fakeHash(acc.sig).replace(/[^0-9a-f]/g, "").padEnd(10, "0").slice(0, 10)}`;
    const mix: Partial<Record<Validity, number>> = {};
    let clashesN = 0;
    for (const g of acc.groups) {
      g.familyId = id;
      mix[g.validity] = (mix[g.validity] ?? 0) + g.clashIds.length;
      clashesN += g.clashIds.length;
    }
    const validities = Object.keys(mix) as Validity[];
    const hasReal = !!mix.real;
    // Non-real families with no real twin go to "No es problema" (PT14), hygiene/duplicates to the model-set bucket.
    const pt: ProblemTypeCode = !hasReal && !mix.needs_info && acc.pt !== "PT12" && acc.pt !== "PT13" ? "PT14" : acc.pt;
    const bucket = pt === "PT12" || pt === "PT13" ? "model_set" : pt === "PT14" ? "non_issue" : "pair";
    const proposedValidity = hasReal ? "real" : validities.sort((a, b) => (mix[b] ?? 0) - (mix[a] ?? 0))[0];
    const owners = new Map<string, number>();
    for (const g of acc.groups) {
      const o = proposalOf.get(g.id)?.fields.owner.value ?? acc.mover.discipline;
      owners.set(o, (owners.get(o) ?? 0) + g.clashIds.length);
    }
    const responsible = [...owners].sort((a, b) => b[1] - a[1])[0]?.[0] ?? acc.mover.discipline;
    const other = responsible === acc.host.discipline ? acc.mover.discipline : acc.host.discipline;
    const levels = [...new Set(acc.groups.map((g) => g.location?.level).filter((l): l is string => !!l))].sort((a, b) => levelNum(a) - levelNum(b));
    const tags: TriageFamily["tags"] = [];
    if (acc.groups.length >= 3 && levels.length >= 2) tags.push("tipico");
    if (validities.length > 1) tags.push("validez_mixta");
    if (pt === "PT04" && acc.mClass === "ducto") tags.push("orientacion_por_confirmar");
    if (!acc.mover.system) tags.push("sin_sistema");
    if (pt === "PT14") for (const g of acc.groups) g.problemType = "PT14";
    const pens = acc.groups.flatMap((g) => [g.penetrationMinMm, g.penetrationMaxMm]);
    const sizes = new Map<string, number>();
    for (const g of acc.groups) for (const c of byGroup.get(g.id) ?? []) {
      const m = rank(c.a) >= rank(c.b) ? c.b : c.a;
      const k = m.sizeHint ?? m.type ?? "—";
      sizes.set(k, (sizes.get(k) ?? 0) + 1);
    }
    const f: TriageFamily = {
      id,
      signature: acc.sig,
      parts: { problemType: pt, hostClass: acc.host.category, hostType: acc.hostKey.split(":")[1] || undefined, moverClass: acc.mClass, systemClass: acc.mover.discipline, sizeBand: "—", relation: acc.relation },
      title: title(pt, acc.host, acc.mover, acc.hostKey.split(":")[1] || undefined, acc.relation),
      problemTypeName: PROBLEM_TYPES.find((x) => x.code === pt)?.nameEs ?? pt,
      bucket,
      pair: [responsible, other],
      groupIds: acc.groups.sort((a, b) => a.priority - b.priority || b.clashIds.length - a.clashIds.length).map((g) => g.id),
      instanceCount: acc.groups.length,
      uniqueClashCount: clashesN,
      rawClashCount: clashesN,
      levels,
      validityMix: mix,
      proposed: { validity: proposedValidity, action: familyAction(proposedValidity, pt), responsibleDiscipline: responsible, secondaryDiscipline: other, band: Math.min(...acc.groups.map((g) => g.priority)) as Priority },
      exceptions: [],
      tags,
      state: "sin_decidir",
      counts: { exceptions: 0, pendingInherited: 0, inherited: 0 },
      validityConflicts: [],
      mergedFrom: [],
      evidence: { penetrationMm: { min: Math.min(...pens), max: Math.max(...pens) }, sizeHistogram: [...sizes].map(([size, count]) => ({ size, count })).sort((x, y) => y.count - x.count).slice(0, 8) },
      instances: [],
      pendingProposals: [],
    };
    refreshFamily(f, new Map(acc.groups.map((g) => [g.id, g])));
    families.push(f);
  }
  // The payload has no orientation (proposal §1): make sure one slab family exercises the "orientación por confirmar" tag.
  if (!families.some((f) => f.tags.includes("orientacion_por_confirmar"))) {
    const slab = families.find((f) => f.parts.problemType === "PT04" || f.parts.problemType === "PT05");
    if (slab) slab.tags.push("orientacion_por_confirmar");
  }
  families.sort((a, b) => b.instanceCount - a.instanceCount || b.uniqueClashCount - a.uniqueClashCount || a.id.localeCompare(b.id));
  return { families, groups: out };
}

/** Recompute the derived parts of a family view (instances, counts, state, validity conflicts) from its groups. */
export function refreshFamily(f: TriageFamily, groups: Map<string, FamilyGroup>): TriageFamily {
  const inst = f.groupIds.map((id) => groups.get(id)).filter((g): g is FamilyGroup => !!g);
  f.instances = inst.map((g) => ({
    groupId: g.id,
    title: g.title,
    levels: g.location?.level ? [g.location.level] : [],
    hostLevelLabel: g.hostLevelLabel,
    validity: g.validity,
    band: g.priority,
    uniqueClashCount: g.uniqueClashCount ?? g.clashIds.length,
    rawClashCount: g.clashIds.length,
    delta: g.delta,
    inheritance: g.inheritance ?? { state: "none" },
  }));
  f.counts = {
    exceptions: inst.filter((g) => g.inheritance?.state === "exception").length,
    pendingInherited: inst.filter((g) => g.inheritance?.state === "inherited_pending").length,
    inherited: inst.filter((g) => g.inheritance?.state === "inherited").length,
  };
  f.state = !f.decision ? "sin_decidir" : f.decision.status === "rejected" ? "rechazada" : "decidida";
  const target = f.decision?.status === "approved" ? f.decision.validity : f.proposed.validity;
  f.validityConflicts = inst.filter((g) => g.validity !== target).map((g) => ({ groupId: g.id, title: g.title, from: g.validity, to: target }));
  familyM1(f, groups);
  return f;
}
