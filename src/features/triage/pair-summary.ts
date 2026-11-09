/**
 * Decision-first summary of a group or clash: sides normalised to the group's
 * discipline pair (A = pair[0]), the "mover" side (who moves), the host side,
 * and the facts the one-line header needs.
 */
import type { Clash, ClashGroup, ElementInfo, Proposal } from "~/lib/api/types";

export interface SideFacts {
  side: "a" | "b";
  discipline: string;
  /** Distinct elements on this side (by ref). */
  elements: ElementInfo[];
  /** Most frequent category on this side (undefined when mixed with no majority). */
  category?: string;
  /** Element shown in the evidence strip. */
  representative: ElementInfo;
}

export interface PairSummary {
  a: SideFacts;
  b: SideFacts;
  /** Side whose discipline is proposed to move (responsible). */
  mover: SideFacts;
  host: SideFacts;
  /** Clashes with sides normalised so `a` is pair[0]. */
  clashes: { id: string; a: ElementInfo; b: ElementInfo; distanceMm: number }[];
  penetrationMaxMm: number;
  level?: string;
}

/** Orient a clash so its `a` element belongs to `aDiscipline` when possible. */
function orient(c: Clash, aDiscipline: string | undefined) {
  const swap = !!aDiscipline && c.a.discipline !== aDiscipline && c.b.discipline === aDiscipline;
  return swap ? { id: c.id, a: c.b, b: c.a, distanceMm: c.distanceMm } : { id: c.id, a: c.a, b: c.b, distanceMm: c.distanceMm };
}

function sideFacts(side: "a" | "b", els: ElementInfo[]): SideFacts {
  const byRef = new Map<string, ElementInfo>();
  for (const e of els) if (!byRef.has(e.ref)) byRef.set(e.ref, e);
  const elements = [...byRef.values()];
  const counts = new Map<string, number>();
  for (const e of elements) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  const [top, n] = [...counts].sort((x, y) => y[1] - x[1])[0] ?? [undefined, 0];
  const category = top && n / Math.max(1, elements.length) >= 0.5 ? top : undefined;
  return {
    side,
    discipline: elements[0]?.discipline ?? "",
    elements,
    category,
    representative: elements.find((e) => e.category === category) ?? elements[0],
  };
}

export function summarizePair(members: Clash[], group: ClashGroup | undefined, proposal: Proposal | undefined, focus?: Clash): PairSummary | null {
  if (!members.length) return null;
  const aDisc = group?.pair[0] ?? members[0].a.discipline;
  const clashes = members.map((c) => orient(c, aDisc));
  const a = sideFacts("a", clashes.map((c) => c.a));
  const b = sideFacts("b", clashes.map((c) => c.b));
  a.discipline = group?.pair[0] ?? a.discipline;
  b.discipline = group?.pair[1] ?? b.discipline;
  if (focus) {
    const f = orient(focus, aDisc);
    a.representative = f.a;
    b.representative = f.b;
  }
  const owner = proposal?.fields.owner.value;
  const mover = owner === a.discipline && owner !== b.discipline ? a : owner === b.discipline && owner !== a.discipline ? b : a.elements.length > b.elements.length ? a : b;
  const host = mover === a ? b : a;
  const penetrationMaxMm = group ? group.penetrationMaxMm : Math.max(0, ...clashes.map((c) => -c.distanceMm));
  return {
    a,
    b,
    mover,
    host,
    clashes,
    penetrationMaxMm,
    level: host.representative?.level ?? group?.location?.level ?? members[0].level,
  };
}

/** First sentence of the rationale, cut to `max` characters. */
export function oneLine(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const first = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  return first.length <= max ? first : `${first.slice(0, max - 1).trimEnd()}…`;
}
