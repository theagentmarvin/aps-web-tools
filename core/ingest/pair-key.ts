/**
 * Element-pair identity used as the cross-version fallback key.
 *
 * docs/domain/clash-triage-methodology.md "Clash memory": identity is
 * `sortedPair(externalIdL, externalIdR)`, falling back to a model-file scoped
 * id when the UniqueId is missing. The fallback uses the STABLE object id
 * (`loid`/`roid`, stable per seed-file lineage, research §3.2) rather than the
 * viewer dbId, which changes between seed versions.
 */
import type { ClashSide, ElementProps, ModelDocument, NormalizedClash } from "../types";

export const PAIR_KEY_SEPARATOR = "|";

/** Resolve the element of one clash side (documentId + viewer dbId). */
export type ElementLookup = (documentId: number, viewerDbId: number) => ElementProps | undefined;

/** Build a lookup from per-document tables (documentId → lmvId → props). */
export function elementLookupFromTables(
  tables: ReadonlyMap<number, ReadonlyMap<number, ElementProps>>,
): ElementLookup {
  return (documentId, viewerDbId) => tables.get(documentId)?.get(viewerDbId);
}

/** externalId, else `<lineageUrn>:<objectId>`, else undefined. */
export function sideToken(side: ClashSide, element?: ElementProps, doc?: ModelDocument): string | undefined {
  if (element?.externalId) return element.externalId;
  const modelFile = element?.modelFile ?? doc?.lineageUrn;
  return modelFile ? `${modelFile}:${side.objectId}` : undefined;
}

export function pairKeyOf(a: string, b: string): string {
  return a <= b ? `${a}${PAIR_KEY_SEPARATOR}${b}` : `${b}${PAIR_KEY_SEPARATOR}${a}`;
}

/** Side tokens of a pairKey (inverse of {@link pairKeyOf}). */
export function pairKeyTokens(pairKey: string): string[] {
  return pairKey.split(PAIR_KEY_SEPARATOR);
}

/**
 * Return copies of the clashes with `pairKey` filled in. A clash keeps
 * `pairKey` undefined when either side has neither externalId nor lineage.
 */
export function attachPairKeys(
  clashes: readonly NormalizedClash[],
  documents: readonly ModelDocument[],
  lookup: ElementLookup,
): NormalizedClash[] {
  const docs = new Map(documents.map((d) => [d.id, d]));
  return clashes.map((c) => {
    const l = sideToken(c.left, lookup(c.left.documentId, c.left.viewerDbId), docs.get(c.left.documentId));
    const r = sideToken(c.right, lookup(c.right.documentId, c.right.viewerDbId), docs.get(c.right.documentId));
    return l && r ? { ...c, pairKey: pairKeyOf(l, r) } : { ...c };
  });
}
