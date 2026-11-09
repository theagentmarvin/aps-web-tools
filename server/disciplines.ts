/**
 * Discipline of each model (document), decided by the coordinator.
 *
 * Production file naming is unknown, so detection is minimal and the user
 * defines the rest. Precedence per document:
 *   1. assignment  exact lineageUrn → discipline (project mapping)
 *   2. rule        first matching user rule (contains / startsWith / regex on
 *                  fileName | folder | viewName; case- and accent-insensitive)
 *   3. matrix      rules/discipline-matrix.yaml file-name patterns, ONLY when
 *                  config `disciplines.fileNameDetection` = "matrix" (default "off")
 *   4. elements    dominant element discipline when its share ≥ 80 %
 *   5. unassigned  "SIN" (Sin asignar)
 * Steps 1–3 also set the model discipline of the document's elements (the
 * engine then refines MEP elements by system). For 4–5 the engine runs in
 * strict naming-independent mode (category + unambiguous system only).
 *
 * Stored per project, versioned and audited:
 *   .coordinator/projects/<projectId>/disciplines.json
 * "UNK" is accepted as input and shown as "SIN".
 */
import { fileDiscipline } from "../core/enrich/element";
import type { CompiledRuleSet } from "../core/rules/load";
import { readJsonFile, writeJsonAtomic } from "./store/fs";
import type { Store } from "./store";
import { bareProjectId, CoordError, nowIso, sha256 } from "./util";

export const SIN = "SIN";
export const SIN_LABEL = "Sin asignar";
export const DOMINANT_SHARE = 0.8;

export type DisciplineSourceKind = "assignment" | "rule" | "matrix" | "elements" | "unassigned";

export interface DisciplineRule {
  id: string;
  match: "contains" | "startsWith" | "regex";
  value: string;
  field: "fileName" | "folder" | "viewName";
  discipline: string;
  createdBy: string;
  createdAt: string;
}

export interface ProjectDisciplines {
  version: number;
  /** lineageUrn → discipline code ("SIN" = explicitly unassigned). */
  assignments: Record<string, string>;
  rules: DisciplineRule[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface DocInfo {
  documentId: number;
  lineageUrn?: string;
  fileName: string;
  viewName: string;
  folder?: string;
}

export interface DocDiscipline {
  discipline: string;
  source: DisciplineSourceKind;
  ruleId?: string;
  share?: number;
}

/** Outputs never show UNK. */
export function outCode(code: string | undefined | null): string {
  return !code || code === "UNK" ? SIN : code;
}

/** Inputs accept UNK as SIN. */
export function inCode(code: string): string {
  const c = code.trim().toUpperCase();
  return c === "UNK" ? SIN : c;
}

export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function ruleMatches(rule: Pick<DisciplineRule, "match" | "value" | "field">, doc: DocInfo): boolean {
  const target = fold(rule.field === "fileName" ? doc.fileName : rule.field === "viewName" ? doc.viewName : doc.folder ?? "");
  const v = fold(rule.value);
  if (!v) return false;
  if (rule.match === "contains") return target.includes(v);
  if (rule.match === "startsWith") return target.startsWith(v);
  try {
    return new RegExp(rule.value, "i").test(rule.field === "fileName" ? fold(doc.fileName) : target) || new RegExp(rule.value, "i").test(target);
  } catch {
    return false;
  }
}

export function validCodes(rs: CompiledRuleSet): Array<{ code: string; label: string }> {
  return [
    ...[...rs.disciplines.values()].filter((d) => d.code !== "UNK").map((d) => ({ code: d.code, label: d.es })),
    { code: SIN, label: SIN_LABEL },
  ];
}

export function assertCode(rs: CompiledRuleSet, code: string): string {
  const c = inCode(code);
  if (c !== SIN && !rs.disciplines.has(c)) throw new CoordError("validation_error", `Disciplina desconocida: ${code}`);
  return c;
}

/** Model-level decision (steps 1–3); undefined when the elements must decide. */
export function modelLevelDiscipline(doc: DocInfo, cfg: ProjectDisciplines, rs: CompiledRuleSet, matrixOn: boolean): DocDiscipline | undefined {
  const a = doc.lineageUrn ? cfg.assignments[doc.lineageUrn] : undefined;
  if (a) return { discipline: a, source: "assignment" };
  const rule = cfg.rules.find((r) => ruleMatches(r, doc));
  if (rule) return { discipline: rule.discipline, source: "rule", ruleId: rule.id };
  if (matrixOn) {
    const d = fileDiscipline(rs, doc.fileName);
    if (d && d !== "UNK") return { discipline: d, source: "matrix" };
  }
  return undefined;
}

/** Final document discipline (steps 1–5) given element discipline counts for the document. */
export function resolveDocument(doc: DocInfo, cfg: ProjectDisciplines, rs: CompiledRuleSet, matrixOn: boolean, elementCounts: ReadonlyMap<string, number> | undefined): DocDiscipline {
  const m = modelLevelDiscipline(doc, cfg, rs, matrixOn);
  if (m) return m;
  const counts = [...(elementCounts ?? new Map()).entries()].filter(([c]) => c !== "UNK" && c !== SIN);
  const total = [...(elementCounts ?? new Map()).values()].reduce((n, x) => n + x, 0);
  const [best, n] = counts.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0] ?? [undefined, 0];
  const share = total ? n / total : 0;
  if (best && share >= DOMINANT_SHARE) return { discipline: best, source: "elements", share: Math.round(share * 1000) / 1000 };
  return { discipline: SIN, source: "unassigned", ...(total ? { share: Math.round(share * 1000) / 1000 } : {}) };
}

const GENERIC_TOKENS = new Set(["model", "modelo", "modeling", "modelado", "test", "prueba", "vol", "volumen", "rvt", "ifc", "nwc", "nwd", "copy", "copia", "central", "local", "detached", "final", "rev", "v1", "v2"]);

/**
 * Token to pre-fill "aplicar a archivos que contengan …": the ISO 19650 role
 * code when the name follows the pattern, else the first significant word
 * (letters only, ≥ 3 chars), shortened to 4 characters when longer than 6.
 * With `siblings` (the other file names of the model set), words shared by
 * every sibling (project code, "MOD"…) are skipped: the token is the word
 * that tells this file apart.
 */
export function suggestedToken(fileName: string, siblings: readonly string[] = []): string | undefined {
  const wordsOf = (name: string) =>
    name
      .replace(/\.[A-Za-z0-9]+$/, "")
      .split(/[^A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]+/)
      .filter((w) => /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(w) && (w.length >= 3 || /\d/.test(w)) && w.length >= 2 && !GENERIC_TOKENS.has(fold(w)));
  const base = fileName.replace(/\.[A-Za-z0-9]+$/, "");
  const fields = base.split("-");
  if (fields.length >= 7 && /^(m3|m2|mod|mo|md|dm)$/i.test(fields[4] ?? "")) return fields[5]!.toUpperCase();
  const words = wordsOf(fileName);
  const others = [...new Set(siblings.map(fold))].filter((s) => s !== fold(fileName)).map(wordsOf).map((ws) => new Set(ws.map(fold)));
  const shared = (w: string) => others.length > 0 && others.every((o) => o.has(fold(w)));
  const w = words.find((x) => !shared(x)) ?? words[0];
  if (!w) return undefined;
  return (w.length > 6 ? w.slice(0, 4) : w).toUpperCase();
}

export class DisciplineStore {
  constructor(private readonly store: Store) {}

  path(projectId: string): string {
    return this.store.path("projects", bareProjectId(projectId).replace(/[^A-Za-z0-9._-]/g, "_"), "disciplines.json");
  }

  async load(projectId: string): Promise<ProjectDisciplines> {
    return (await readJsonFile<ProjectDisciplines>(this.path(projectId))) ?? { version: 0, assignments: {}, rules: [] };
  }

  /** Versioned update + audit (before/after hashes). */
  async update(projectId: string, by: { id: string; name: string }, mutate: (cfg: ProjectDisciplines) => void, action: string, details: Record<string, string | number | boolean | null> = {}): Promise<ProjectDisciplines> {
    return this.store.withLock(async () => {
      const cur = await this.load(projectId);
      const before = sha256(JSON.stringify({ a: cur.assignments, r: cur.rules }));
      const next: ProjectDisciplines = JSON.parse(JSON.stringify(cur));
      mutate(next);
      next.version = cur.version + 1;
      next.updatedAt = nowIso(this.store.now());
      next.updatedBy = by.name;
      await writeJsonAtomic(this.path(projectId), next);
      await this.store.audit({
        actor: { type: "user", id: by.id, name: by.name },
        action,
        projectId,
        details: { ...details, version: next.version, before: before.slice(0, 16), after: sha256(JSON.stringify({ a: next.assignments, r: next.rules })).slice(0, 16) },
      });
      return next;
    });
  }
}
