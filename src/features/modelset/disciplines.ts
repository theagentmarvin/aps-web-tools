/**
 * Discipline helpers for the model set page: source labels, the reclassify
 * round-trip (grid or job), suggested rules, DisciplineConfig normalisation.
 */
import type { TFunction, TKey } from "~/i18n";
import type { CoordinatorApi } from "~/lib/api";
import {
  UNASSIGNED,
  type ClashGrid,
  type DisciplineConfig,
  type DisciplineRuleInput,
  type DisciplineSuggestion,
  type GridDocument,
  type ProjectDisciplines,
  type SetDisciplineRequest,
} from "~/lib/api/types";

export function isUnassigned(d: GridDocument): boolean {
  return d.discipline === UNASSIGNED || d.disciplineSource === "unassigned";
}

/** "asignada por ti", "por regla DR-1", "por elementos (87 %)", "Sin asignar"… */
export function sourceLabel(t: TFunction, d: GridDocument, pct: (r: number) => string): string {
  switch (d.disciplineSource) {
    case "assignment":
      return t("disc.source.assignment");
    case "rule":
      return t("disc.source.rule", { rule: d.ruleId ?? "" });
    case "matrix":
      return t("disc.source.matrix");
    case "elements":
      return t("disc.source.elements", { pct: d.disciplineShare !== undefined ? pct(d.disciplineShare) : "—" });
    default:
      return t("disc.source.unassigned");
  }
}

export function suggestedRule(d: GridDocument, discipline: string): DisciplineRuleInput {
  const value = d.suggestedToken ?? d.fileName.replace(/\.[a-z0-9]+$/i, "").split(/[ _-]/)[0] ?? d.fileName;
  // A token found in the folder path but not in the file name is a folder rule.
  const tok = value.toLowerCase();
  const inName = d.fileName.toLowerCase().includes(tok);
  const inFolder = (d.folderPath ?? "").toLowerCase().includes(tok);
  return { discipline, field: !inName && inFolder ? "folder" : "fileName", match: "contains", value };
}

/**
 * PUT the discipline; when the server answers with a reclassification job,
 * wait for it and then fetch the regrouped grid.
 */
export async function assignDiscipline(
  api: CoordinatorApi,
  projectId: string,
  modelSetId: string,
  doc: Pick<GridDocument, "lineageUrn">,
  req: SetDisciplineRequest,
  test: string | undefined,
): Promise<ClashGrid> {
  const res = await api.setDocumentDiscipline(projectId, modelSetId, doc.lineageUrn, req, test);
  if (!("jobId" in res)) return res;
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    const j = await api.getIngestJob(res.jobId);
    if (j.phase === "failed") throw new Error(j.error ?? j.message);
    if (j.phase === "done") break;
  }
  return api.getClashGrid(projectId, modelSetId, test);
}

export function ruleText(t: TFunction, r: DisciplineRuleInput): string {
  return t("disc.ruleText", { field: t(`disc.ruleField.${r.field}` as TKey), match: t(`disc.match.${r.match}` as TKey), value: r.value, discipline: r.discipline });
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Agent discipline_mapping proposal payload → UI suggestion (payload shape is tolerant). */
export function parseSuggestion(p: DisciplineConfig["pendingProposals"][number]): DisciplineSuggestion {
  const pl = p.payload ?? {};
  const rawRule = (pl.rule ?? pl.createRule) as Record<string, unknown> | undefined;
  const discipline = str(pl.discipline) ?? str(rawRule?.discipline) ?? "";
  const lineageUrn = str(pl.lineageUrn);
  return {
    id: p.id,
    summary: p.summary,
    rationale: p.rationale,
    discipline,
    lineageUrns: strs(pl.lineageUrns).length ? strs(pl.lineageUrns) : lineageUrn ? [lineageUrn] : [],
    fileNames: strs(pl.fileNames).length ? strs(pl.fileNames) : str(pl.fileName) ? [str(pl.fileName)!] : [],
    rule: rawRule
      ? {
          discipline: str(rawRule.discipline) ?? discipline,
          field: (str(rawRule.field) as DisciplineRuleInput["field"]) ?? "fileName",
          match: (str(rawRule.match) as DisciplineRuleInput["match"]) ?? "contains",
          value: str(rawRule.value) ?? str(rawRule.token) ?? "",
        }
      : undefined,
    confidence: typeof pl.confidence === "number" ? pl.confidence : undefined,
  };
}

export function normaliseDisciplines(c: DisciplineConfig): ProjectDisciplines {
  return {
    version: c.version,
    disciplines: (c.codes ?? []).filter((x) => x.code !== UNASSIGNED).map((x) => ({ code: x.code, es: x.label, en: x.label })),
    rules: (c.rules ?? []).map((r) => ({ id: r.id, discipline: r.discipline, field: r.field, match: r.match, value: r.value })),
    suggestions: (c.pendingProposals ?? []).map(parseSuggestion),
  };
}
