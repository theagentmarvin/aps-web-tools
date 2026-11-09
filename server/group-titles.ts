/**
 * Group identity and titles on real models.
 *
 * Root causes found on a real ACC model set (5,549 clashes → 319 groups, 44
 * titles shared by 231 groups; no clash belonged to two groups):
 *  1. Legitimate splits with the same label: one group per hub element (e.g. ten
 *     different 12"×18" beams on the same level, each crossed by 8 pipes). The
 *     engine title names the TYPE and the level, not the element. → the title
 *     now carries the distinguishing key (discipline pair when it differs,
 *     else the element's Revit id or mark).
 *  2. The same physical element published twice: an MEP model whose published
 *     view includes the linked structural model. Linked elements arrive with
 *     externalId `<linkInstanceUid>/<elementUid>`, so beam B clashed once as
 *     "STRUCTURAL file → B" and once as "MEP file → link/B": twin groups with
 *     identical titles and members. → {@link normalizeLinkedExternalIds} keys
 *     linked elements by their own uid, so the engine's G0 dedupe merges the
 *     twin clashes into one (both MC clash ids are kept).
 */
import type { ElementProps } from "../core/types";
import type { ClashRecord, GroupRecord } from "./store/types";

/** Revit linked element externalId: `<36-char uid>-<8 hex>/<element uid>`. */
const LINKED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}\/(.+)$/i;

export function linkedElementUid(externalId: string | undefined): string | undefined {
  const m = externalId ? LINKED.exec(externalId) : null;
  return m ? m[1] : undefined;
}

/** Copies of the elements with linked externalIds reduced to the element's own uid (raw keeps the original). */
export function normalizeLinkedExternalIds(elements: readonly ElementProps[]): ElementProps[] {
  return elements.map((e) => {
    const uid = linkedElementUid(e.externalId);
    return uid ? { ...e, externalId: uid, raw: { ...e.raw, "__coord/linkedExternalId": e.externalId ?? null } } : e;
  });
}

/** Number of linked-model elements per document (hygiene: linked model published inside another model). */
export function linkedElementCounts(elements: readonly ElementProps[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of elements) {
    const orig = (e.raw?.["__coord/linkedExternalId"] as string | undefined) ?? e.externalId;
    if (e.documentId !== undefined && linkedElementUid(orig)) out.set(e.documentId, (out.get(e.documentId) ?? 0) + 1);
  }
  return out;
}

export interface TitleContext {
  clashById: ReadonlyMap<string, ClashRecord>;
  elementByRef: ReadonlyMap<string, ElementProps>;
  /** externalId → side ref (E-doc:dbId) of the hub element, when the engine named one. */
  hubRef: (g: GroupRecord) => string | undefined;
}

function descriptor(g: GroupRecord, ctx: TitleContext): string | undefined {
  const ref =
    ctx.hubRef(g) ??
    (() => {
      const rep = g.representativeClashId ? ctx.clashById.get(g.representativeClashId) : undefined;
      if (!rep) return undefined;
      const side = rep.a.discipline === "SIN" ? rep.a : rep.b.discipline === "SIN" ? rep.b : rep.a;
      return side.ref;
    })();
  if (!ref) return undefined;
  const el = ctx.elementByRef.get(ref);
  if (el?.mark) return `marca ${el.mark}`;
  if (el?.elementId) return `id ${el.elementId}`;
  return ref;
}

/**
 * Make titles unique within a test, stating the distinguishing key: the
 * discipline pair when it differs inside the colliding set, then the element
 * (mark or Revit id), then an ordinal as a last resort. Deterministic.
 */
export function disambiguateTitles(groups: GroupRecord[], ctx: TitleContext): void {
  const byTitle = new Map<string, GroupRecord[]>();
  for (const g of groups) byTitle.set(g.title, [...(byTitle.get(g.title) ?? []), g]);
  for (const [, set] of byTitle) {
    if (set.length < 2) continue;
    const pairs = new Set(set.map((g) => g.disciplinePair));
    for (const g of set) {
      const parts: string[] = [];
      if (pairs.size > 1) parts.push(g.disciplinePair);
      const d = descriptor(g, ctx);
      if (d) parts.push(d);
      if (parts.length) g.title = `${g.title} · ${parts.join(" · ")}`;
    }
    // Still identical (same element seen twice, missing ids): ordinal.
    const again = new Map<string, GroupRecord[]>();
    for (const g of set) again.set(g.title, [...(again.get(g.title) ?? []), g]);
    for (const [, s] of again) {
      if (s.length < 2) continue;
      s.sort((a, b) => (a.id < b.id ? -1 : 1)).forEach((g, i) => (g.title = `${g.title} (${i + 1}/${s.length})`));
    }
  }
}
