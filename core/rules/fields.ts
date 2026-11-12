/**
 * Field names the matcher DSL knows (classification-rules.yaml §4). Anything
 * else in a matcher is a load error. Derived flags are added dynamically from
 * the matrix `derivedFlags` list.
 */

/** Raw element fields (Model Properties / MC documents, normalized). */
export const ELEMENT_RAW_FIELDS = [
  "externalId", "elementId", "documentId", "modelFile", "documentName", "category", "family", "type", "name", "level",
  "systemClassification", "systemType", "systemName", "diameterMm", "outsideDiameterMm", "widthMm", "heightMm",
  "thicknessMm", "insulationThicknessMm", "material", "workset", "phaseCreated", "phaseDemolished", "fireRating",
  "structural", "orientation", "modelAgeDays",
] as const;

/** Element fields derived by the engine from the discipline matrix. */
export const ELEMENT_DERIVED_FIELDS = [
  "modelDiscipline", "discipline", "disciplineGroup", "categoryDiscipline", "sizeMm", "elementClass", "moveRank",
] as const;

export const CLASH_FIELDS = [
  "distanceMm", "penetrationMm", "penetrationRatio", "status", "toleranceHardMm", "clearanceMm", "withinTolerance",
  "clearanceViolation", "sameDocument", "sameModelFile", "sameOriginFile", "sameExternalId", "sameSystemName", "sameFamily", "sameType",
  "sameCategory", "sameDiscipline", "sameLevel", "nestedRelation", "coveredBySleeve",
] as const;

export type ElementRawField = (typeof ELEMENT_RAW_FIELDS)[number];
export type ClashField = (typeof CLASH_FIELDS)[number];

/** Numeric element fields (used to validate refs and coerce inputs). */
export const ELEMENT_NUMERIC_FIELDS = new Set<string>([
  "diameterMm", "outsideDiameterMm", "widthMm", "heightMm", "thicknessMm", "insulationThicknessMm", "modelAgeDays",
  "sizeMm", "moveRank",
]);
