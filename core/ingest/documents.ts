/**
 * Clash documents (+ optional model set version) → {@link ModelDocument}[].
 *
 * research §2 and §8.8: match `documents[].urn === documentVersions[].versionUrn`
 * EXACTLY (never strip `?version=`). ALL documents are kept (fixes legacy §8.3).
 */
import type { ModelDocument } from "../types";
import { base64UrlEncode } from "./base64url";
import type { RawClashDocument, RawDocumentVersion } from "./raw";

/** Last segment of a URN, used only when no file name is known. */
function fallbackName(urn: string): string {
  const noQuery = urn.split("?")[0];
  return noQuery.slice(noQuery.lastIndexOf(":") + 1) || urn;
}

/**
 * Pick the model set entry for a clash document. Exact URN match first; when a
 * URN appears for several viewables, disambiguate by `viewableName`.
 */
export function findDocumentVersion(
  doc: RawClashDocument,
  documentVersions: readonly RawDocumentVersion[],
): RawDocumentVersion | undefined {
  const sameUrn = documentVersions.filter((dv) => dv.versionUrn === doc.urn);
  if (sameUrn.length <= 1) return sameUrn[0];
  return sameUrn.find((dv) => dv.viewableName === doc.viewableName) ?? sameUrn[0];
}

export function buildModelDocuments(
  rawDocs: readonly RawClashDocument[],
  documentVersions: readonly RawDocumentVersion[] = [],
): ModelDocument[] {
  return rawDocs
    .map((doc): ModelDocument => {
      const dv = findDocumentVersion(doc, documentVersions);
      return {
        id: doc.id,
        urn: doc.urn,
        viewableName: doc.viewableName,
        lineageUrn: dv?.documentLineage?.lineageUrn,
        // research §4: prefer originalSeedFileVersionUrn; versionUrn equals it for ACC `File` items.
        seedVersionUrn: dv ? (dv.originalSeedFileVersionUrn ?? dv.versionUrn) : undefined,
        displayName: dv?.originalSeedFileVersionName ?? dv?.displayName ?? fallbackName(doc.urn),
        viewableGuid: dv?.viewableGuid,
        viewerUrn: dv?.bubbleUrn ? base64UrlEncode(dv.bubbleUrn) : undefined,
        documentStatus: dv?.documentStatus,
        matchedModelSet: dv !== undefined,
        discipline: null,
        disciplineSource: "unassigned",
      };
    })
    .sort((a, b) => a.id - b.id);
}
