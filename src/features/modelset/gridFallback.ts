/**
 * Until the server exposes GET …/clash-grid (and /disciplines), build the
 * grid client-side from the triage payload of a cached test, so the model
 * set page already works against live data. Used only on a 404.
 */
import { ApiError, type CoordinatorApi } from "~/lib/api";
import type { ClashGrid, Discipline, GridCell, GridDocument, ProjectDisciplines, TestRunInfo } from "~/lib/api/types";
import { normaliseDisciplines } from "./disciplines";

function isMissingEndpoint(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export async function loadGrid(api: CoordinatorApi, projectId: string, modelSetId: string, test: string | undefined, tests: TestRunInfo[] | undefined): Promise<ClashGrid> {
  try {
    return await api.getClashGrid(projectId, modelSetId, test);
  } catch (err) {
    if (!isMissingEndpoint(err)) throw err;
    return gridFromTriage(api, projectId, modelSetId, test, tests ?? (await api.getTestsOverview(projectId, modelSetId)).tests);
  }
}

async function gridFromTriage(api: CoordinatorApi, projectId: string, modelSetId: string, test: string | undefined, tests: TestRunInfo[]): Promise<ClashGrid> {
  const run = test ? tests.find((r) => r.id === test || r.accTestId === test) : tests.find((r) => r.cached);
  if (!run) throw new ApiError("Prueba no encontrada", 404, "not_found");
  if (!run.cached) return { accTestId: run.accTestId, modelSetVersion: run.modelSetVersion, state: "none", documents: [], cells: [] };
  const p = await api.getTriage(projectId, modelSetId, run.id);
  const groups = new Map(p.groups.map((g) => [g.id, g]));
  const proposals = new Map(p.proposals.map((x) => [x.targetId, x]));
  const cells = new Map<string, GridCell & { gs: Set<string> }>();
  // Distinct groups per document (a group may span several pairs, so cell sums would overcount).
  const docGroups = new Map<number, Set<string>>();
  const docClashes = new Map<number, number>();
  for (const c of p.clashes) {
    for (const id of new Set([c.a.documentId, c.b.documentId])) {
      docGroups.set(id, (docGroups.get(id) ?? new Set<string>()).add(c.groupId));
      docClashes.set(id, (docClashes.get(id) ?? 0) + 1);
    }
    const a = Math.min(c.a.documentId, c.b.documentId);
    const b = Math.max(c.a.documentId, c.b.documentId);
    const k = `${a}:${b}`;
    const cell = cells.get(k) ?? { a, b, clashes: 0, groups: 0, real: 0, p1: 0, needsReview: 0, newSinceLast: 0, gs: new Set<string>() };
    cell.clashes++;
    if (c.delta === "new") cell.newSinceLast++;
    cell.gs.add(c.groupId);
    cells.set(k, cell);
  }
  const list: GridCell[] = [...cells.values()].map(({ gs, ...cell }) => {
    for (const gid of gs) {
      const g = groups.get(gid);
      const pr = proposals.get(gid);
      if ((pr?.fields.validity.value ?? g?.validity) === "real") cell.real++;
      if ((pr?.fields.priority.value ?? g?.priority) === 1) cell.p1++;
      if (g?.reviewState === "needs_review") cell.needsReview++;
    }
    return { ...cell, groups: gs.size };
  });
  const documents: GridDocument[] = p.test.documents.map((d) => {
    const [fileName, viewName] = d.name.split(" · ");
    return {
      documentId: d.documentId,
      lineageUrn: d.urn,
      fileName: fileName ?? d.name,
      viewName: viewName ?? "",
      discipline: d.discipline && d.discipline !== "UNK" ? d.discipline : "SIN",
      disciplineSource: d.discipline && d.discipline !== "UNK" ? "matrix" : "unassigned",
      clashes: docClashes.get(d.documentId) ?? 0,
      groups: docGroups.get(d.documentId)?.size ?? 0,
    };
  });
  return { testKey: p.test.id, accTestId: p.test.accTestId, modelSetVersion: p.test.modelSetVersion, state: "classified", documents, cells: list };
}

/** Codes from rules/discipline-matrix.yaml, used only when GET /disciplines is missing. */
const FALLBACK: Discipline[] = [
  ["ARQ", "Arquitectura", "Architecture"],
  ["EST", "Estructura", "Structure"],
  ["CLI", "Climatización", "HVAC"],
  ["CAL", "Calefacción", "Heating"],
  ["SAN", "Sanitarias", "Plumbing"],
  ["AP", "Agua potable", "Domestic water"],
  ["ALC", "Alcantarillado", "Sanitary drainage"],
  ["ALL", "Aguas lluvias", "Storm drainage"],
  ["ELE", "Electricidad", "Electrical"],
  ["CORR", "Corrientes débiles", "Low voltage"],
  ["INC", "Protección contra incendio", "Fire protection"],
  ["GAS", "Gas", "Gas"],
  ["ASC", "Ascensores", "Elevators"],
  ["CIV", "Urbanización / obras civiles", "Civil / site"],
  ["FAC", "Fachada", "Facade"],
  ["INT", "Interiorismo", "Interiors"],
].map(([code, es, en]) => ({ code, es, en }));

export async function loadDisciplines(api: CoordinatorApi, projectId: string): Promise<ProjectDisciplines> {
  try {
    const d = normaliseDisciplines(await api.getProjectDisciplines(projectId));
    return d.disciplines.length ? d : { ...d, disciplines: FALLBACK };
  } catch (err) {
    if (!isMissingEndpoint(err)) throw err;
    return { disciplines: FALLBACK, rules: [], suggestions: [], unsupported: true };
  }
}
