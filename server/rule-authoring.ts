/**
 * Rule authoring (text level): the pure helpers behind rule-change suggestions of every kind
 * (new · calibrate · edit · retire · restore). They never write rules/: they turn the CURRENT
 * rule files into candidate texts and a unified diff, which becomes an ordinary `rule_change`
 * proposal (propuesta → aprobada → publicada with passkey + no-regression gate).
 *
 * Precedence (first match wins) is decided here, not by the author:
 *  - calibrate / edit replace the rule's block IN PLACE (its position never changes);
 *  - new goes at the END of its section (id prefix → HYG > DUP > FP > SEI > TOL > CLR > NI >
 *    INC > ELV > EST > AE > MA > MM), always before DEF-999;
 *  - retire moves the rule to rules/classification-rules.archive.yaml (the Biblioteca: the
 *    loader never reads it) with the ids that preceded it in its section;
 *  - restore puts it back after the nearest of those ids still active (else at the start of its
 *    section), again before DEF-999.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ACTIVE_FILE = "classification-rules.yaml";
export const ARCHIVE_FILE = "classification-rules.archive.yaml";
export const FALLBACK_RULE = "DEF-999";
export const RULE_ID_RE = /^[A-Z]{2,4}-\d{3}$/;

export type RuleChangeKind = "new" | "calibrate" | "edit" | "retire" | "restore";
export const RULE_CHANGE_KINDS: readonly RuleChangeKind[] = ["new", "calibrate", "edit", "retire", "restore"];

/** Raw rule exactly as in the YAML. */
export interface RawRule {
  id: string;
  name: string;
  nameEs?: string;
  when: Record<string, unknown>;
  then: Record<string, unknown> & { validity: string; severity: string; suggestedAction: string; responsibleDiscipline: string; confidence: number; rationale: string; humanReview?: boolean };
}

/** Section order of the file (id prefix). Unknown prefixes go with the real-clash rules. */
export const SECTION_ORDER = ["HYG", "DUP", "FP", "SEI", "TOL", "CLR", "NI", "INC", "ELV", "EST", "AE", "MA", "MM"] as const;

export function sectionOf(id: string): string {
  return id.split("-")[0] ?? "";
}

function sectionRank(id: string): number {
  if (id === FALLBACK_RULE) return 1000;
  const i = (SECTION_ORDER as readonly string[]).indexOf(sectionOf(id));
  return i < 0 ? SECTION_ORDER.length : i;
}

/** Next free id with that prefix, over the active AND archived ids. */
export function nextFreeId(prefix: string, taken: Iterable<string>): string {
  const used = new Set([...taken].filter((id) => sectionOf(id) === prefix).map((id) => Number(id.split("-")[1])));
  for (let n = 1; n < 1000; n++) if (!used.has(n)) return `${prefix}-${String(n).padStart(3, "0")}`;
  throw new Error(`no free id for ${prefix}`);
}

// ── YAML flow serialisation (same style as the hand-written file) ────────────

const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n"]);

export function flow(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return PLAIN.test(v) && !RESERVED.has(v.toLowerCase()) ? v : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(flow).join(", ")}]`;
  if (typeof v === "object") {
    const e = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!e.length) return "{}";
    return `{ ${e.map(([k, x]) => `${PLAIN.test(k) ? k : JSON.stringify(k)}: ${flow(x)}`).join(", ")} }`;
  }
  throw new Error(`cannot serialise ${typeof v}`);
}

const WHEN_ORDER = ["clash", "a", "b", "both"];
const THEN_ORDER = ["validity", "nature", "rootCause", "responsibleDiscipline", "secondaryDiscipline", "severity", "confidence", "suggestedAction", "humanReview", "tags", "rationale"];

function ordered(o: Record<string, unknown>, order: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of order) if (o[k] !== undefined) out[k] = o[k];
  for (const k of Object.keys(o)) if (!(k in out) && o[k] !== undefined) out[k] = o[k];
  return out;
}

/** Lines of one rule as an item of the `rules:` list (2-space list indent, as in the file). */
export function serializeRule(r: RawRule): string[] {
  const lines = [`  - id: ${r.id}`, `    name: ${flow(r.name)}`];
  if (r.nameEs) lines.push(`    nameEs: ${flow(r.nameEs)}`);
  const when = ordered(r.when ?? {}, WHEN_ORDER);
  if (!Object.keys(when).length) lines.push("    when: {}");
  else {
    lines.push("    when:");
    for (const [k, v] of Object.entries(when)) lines.push(`      ${k}: ${flow(v)}`);
  }
  const { rationale, ...rest } = ordered(r.then, THEN_ORDER) as RawRule["then"];
  const head = flow(rest).replace(/ \}$/, "");
  lines.push(`    then: ${head},`, `            rationale: ${flow(rationale)} }`);
  return lines;
}

// ── Active file: blocks, replace, remove, insert ────────────────────────────

const ID_LINE = /^ {2}- id: ([A-Z]{2,4}-\d{3})\s*$/;

export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

interface Block {
  id: string;
  start: number;
  /** Exclusive, trailing blank lines excluded. */
  end: number;
}

/** Rule blocks of the active file, in file order (annotations excluded). */
export function ruleBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  const annotations = lines.findIndex((l) => /^annotations:/.test(l));
  const limit = annotations < 0 ? lines.length : annotations;
  for (let i = 0; i < limit; i++) {
    const m = ID_LINE.exec(lines[i]!);
    if (!m) continue;
    let k = i + 1;
    while (k < limit && !/^ {2}- id: /.test(lines[k]!) && !/^#/.test(lines[k]!) && !/^\S/.test(lines[k]!)) k++;
    let end = k;
    while (end > i + 1 && lines[end - 1]!.trim() === "") end--;
    out.push({ id: m[1]!, start: i, end });
  }
  return out;
}

function parseRulesOf(text: string): RawRule[] {
  const doc = parseYaml(text) as { rules?: RawRule[] } | null;
  return doc?.rules ?? [];
}

function insertBlock(lines: string[], ruleLines: string[], rank: number, precededBy: string[] = []): string[] {
  const blocks = ruleBlocks(lines);
  const fallback = blocks.find((b) => b.id === FALLBACK_RULE);
  let at: number | undefined;
  for (const p of precededBy) {
    const b = blocks.find((x) => x.id === p && x.id !== FALLBACK_RULE);
    if (b) {
      at = b.end;
      break;
    }
  }
  if (at === undefined) {
    // End of its section (new) or start of it (restore with no anchor left): after the last
    // rule ranked strictly before (restore) / at most equal (new).
    const before = blocks.filter((b) => b.id !== FALLBACK_RULE && (precededBy.length ? sectionRank(b.id) < rank : sectionRank(b.id) <= rank));
    const last = before[before.length - 1];
    if (last) at = last.end;
    else {
      const first = blocks[0];
      if (!first) throw new Error("rules file has no rules");
      const out = [...lines];
      out.splice(first.start, 0, ...ruleLines, "");
      return out;
    }
  }
  if (fallback && at > fallback.start) at = fallback.start - 1;
  const out = [...lines];
  out.splice(at, 0, "", ...ruleLines);
  return out;
}

export function replaceRuleInText(text: string, rule: RawRule): string {
  const lines = normalizeText(text).split("\n");
  const b = ruleBlocks(lines).find((x) => x.id === rule.id);
  if (!b) throw new Error(`La regla ${rule.id} no está activa.`);
  lines.splice(b.start, b.end - b.start, ...serializeRule(rule));
  return lines.join("\n");
}

export function insertNewRuleInText(text: string, rule: RawRule): string {
  const lines = normalizeText(text).split("\n");
  if (ruleBlocks(lines).some((b) => b.id === rule.id)) throw new Error(`Ya existe una regla ${rule.id}.`);
  if (rule.id === FALLBACK_RULE) throw new Error("DEF-999 es la regla de respaldo: no se crea ni se mueve.");
  return insertBlock(lines, serializeRule(rule), sectionRank(rule.id)).join("\n");
}

// ── Archive (Biblioteca) ─────────────────────────────────────────────────────

export interface ArchiveEntry {
  id: string;
  section: string;
  /** Ids that preceded it in its section when retired, nearest first. */
  precededBy: string[];
  retiredAt: string;
  reason?: string;
  rule: RawRule;
}

const ArchiveSchema = z.object({
  version: z.number().int().positive(),
  retired: z
    .array(
      z.object({
        id: z.string().regex(RULE_ID_RE),
        section: z.string(),
        precededBy: z.array(z.string()).default([]),
        retiredAt: z.string(),
        reason: z.string().optional(),
        rule: z.object({ id: z.string(), name: z.string(), nameEs: z.string().optional(), when: z.record(z.string(), z.unknown()), then: z.record(z.string(), z.unknown()) }).passthrough(),
      }),
    )
    .default([]),
});

/** Archive entries; an empty / missing file is an empty Biblioteca. Throws on a malformed file. */
export function parseArchive(text: string | undefined): ArchiveEntry[] {
  if (!text || !text.trim()) return [];
  const doc = parseYaml(text);
  if (doc === null || doc === undefined) return [];
  return ArchiveSchema.parse(doc).retired as unknown as ArchiveEntry[];
}

export function serializeArchive(entries: ArchiveEntry[]): string {
  const out = [
    "# =============================================================================",
    "# classification-rules.archive.yaml — Biblioteca de reglas retiradas.",
    "# El motor NO lee este archivo. Se escribe solo al publicar una sugerencia",
    "# «Retirar» o «Restaurar» (passkey + evaluación); no editar a mano.",
    "# precededBy = reglas que la precedían en su sección (para restaurar la precedencia).",
    "# =============================================================================",
    "version: 1",
    entries.length ? "retired:" : "retired: []",
  ];
  for (const e of entries) {
    out.push(`  - id: ${e.id}`, `    section: ${flow(e.section)}`, `    precededBy: ${flow(e.precededBy)}`, `    retiredAt: ${flow(e.retiredAt)}`);
    if (e.reason) out.push(`    reason: ${flow(e.reason)}`);
    out.push("    rule:", `      id: ${e.rule.id}`, `      name: ${flow(e.rule.name)}`);
    if (e.rule.nameEs) out.push(`      nameEs: ${flow(e.rule.nameEs)}`);
    out.push(`      when: ${flow(ordered(e.rule.when ?? {}, WHEN_ORDER))}`, `      then: ${flow(ordered(e.rule.then, THEN_ORDER))}`);
  }
  return out.join("\n") + "\n";
}

export interface RuleFiles {
  active: string;
  archive: string;
}

/** Retire rules: remove their blocks from the active file and append them to the archive. */
export function retireRules(files: RuleFiles, ids: string[], meta: { at: string; reason?: string }): RuleFiles {
  const uniq = [...new Set(ids)];
  if (!uniq.length) throw new Error("Indica al menos una regla a retirar.");
  if (uniq.includes(FALLBACK_RULE)) throw new Error("DEF-999 es la regla de respaldo (revisión humana): no se retira.");
  const lines = normalizeText(files.active).split("\n");
  const blocks = ruleBlocks(lines);
  const missing = uniq.filter((id) => !blocks.some((b) => b.id === id));
  if (missing.length) throw new Error(`No están activas: ${missing.join(", ")}`);
  const raw = new Map(parseRulesOf(files.active).map((r) => [r.id, r]));
  const archive = parseArchive(files.archive);
  for (const id of uniq) {
    const i = blocks.findIndex((b) => b.id === id);
    const precededBy = blocks
      .slice(0, i)
      .filter((b) => sectionOf(b.id) === sectionOf(id))
      .map((b) => b.id)
      .reverse();
    const rule = raw.get(id);
    if (!rule) throw new Error(`No se pudo leer la regla ${id}.`);
    archive.push({ id, section: sectionOf(id), precededBy, retiredAt: meta.at, ...(meta.reason ? { reason: meta.reason } : {}), rule });
  }
  // Remove bottom-up so indices stay valid; also drop the blank separator line before each block.
  for (const b of [...blocks].filter((x) => uniq.includes(x.id)).sort((x, y) => y.start - x.start)) {
    const from = b.start > 0 && lines[b.start - 1]!.trim() === "" ? b.start - 1 : b.start;
    lines.splice(from, b.end - from);
  }
  return { active: lines.join("\n"), archive: serializeArchive(archive) };
}

/** Restore archived rules to their original precedence. */
export function restoreRules(files: RuleFiles, ids: string[]): RuleFiles {
  const uniq = [...new Set(ids)];
  if (!uniq.length) throw new Error("Indica al menos una regla a restaurar.");
  const archive = parseArchive(files.archive);
  let lines = normalizeText(files.active).split("\n");
  const active = new Set(ruleBlocks(lines).map((b) => b.id));
  // Restore in original order so a restored rule can anchor the next one.
  const entries = uniq.map((id) => {
    const e = archive.filter((x) => x.id === id).pop();
    if (!e) throw new Error(`${id} no está en la Biblioteca.`);
    if (active.has(id)) throw new Error(`${id} ya está activa (hay otra regla con ese id).`);
    return e;
  });
  entries.sort((x, y) => x.precededBy.length - y.precededBy.length || sectionRank(x.id) - sectionRank(y.id));
  for (const e of entries) {
    const rule = { ...e.rule, id: e.id } as RawRule;
    lines = insertBlock(lines, serializeRule(rule), sectionRank(e.id), e.precededBy.length ? e.precededBy : ["__none__"]);
  }
  const keep = archive.filter((x) => !uniq.includes(x.id));
  return { active: lines.join("\n"), archive: keep.length || files.archive.trim() ? serializeArchive(keep) : "" };
}

// ── Thresholds (numbers in the conditions) ────────────────────────────────────

export interface Threshold {
  /** Dotted path inside `when`, e.g. "a.sizeMm.gte" or "clash.penetrationMm.between.1". */
  path: string;
  block: string;
  field: string;
  op: string;
  value: number;
}

const NUM_OPS = ["eq", "gt", "gte", "lt", "lte"];

export function thresholdsOf(rule: Pick<RawRule, "when">): Threshold[] {
  const out: Threshold[] = [];
  for (const [block, m] of Object.entries(rule.when ?? {})) {
    if (!m || typeof m !== "object") continue;
    for (const [field, v] of Object.entries(m as Record<string, unknown>)) {
      if (field === "anyOf" || field === "not") continue;
      if (typeof v === "number") out.push({ path: `${block}.${field}`, block, field, op: "eq", value: v });
      else if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [op, x] of Object.entries(v as Record<string, unknown>)) {
          if (NUM_OPS.includes(op) && typeof x === "number") out.push({ path: `${block}.${field}.${op}`, block, field, op, value: x });
          if (op === "between" && Array.isArray(x)) x.forEach((n, i) => typeof n === "number" && out.push({ path: `${block}.${field}.between.${i}`, block, field, op: i === 0 ? "gte" : "lte", value: n }));
        }
      }
    }
  }
  return out;
}

/** Copy of the rule with one threshold changed; throws when the path is not a number of the rule. */
export function setThreshold<T extends Pick<RawRule, "when">>(rule: T, path: string, value: number): T {
  if (!Number.isFinite(value)) throw new Error(`Valor no numérico para ${path}`);
  if (!thresholdsOf(rule).some((t) => t.path === path)) throw new Error(`La regla no tiene el umbral ${path}`);
  const copy = structuredClone(rule);
  const parts = path.split(".");
  let cur: Record<string, unknown> = copy.when as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
  const last = parts[parts.length - 1]!;
  if (Array.isArray(cur)) (cur as unknown as number[])[Number(last)] = value;
  else cur[last] = value;
  return copy;
}

// ── Sides (for grouping by discipline pair) ──────────────────────────────────

const CLASS_GROUP: Record<string, string> = {
  STRUCTURE: "EST",
  MEP_DIST: "MEP",
  MEP_ANY: "MEP",
  ARCH_FIXED: "ARQ",
  structure_column: "EST",
  structure_framing: "EST",
  structure_foundation: "EST",
  structure_wall: "EST",
  structure_floor: "EST",
  structure_other: "EST",
  gravity_pipe: "MEP",
  duct_large: "MEP",
  duct: "MEP",
  cable_tray: "MEP",
  pipe_large: "MEP",
  pipe: "MEP",
  conduit: "MEP",
  flexible: "MEP",
  mep_equipment: "MEP",
  mep_terminal: "MEP",
  insulation: "MEP",
  fire_main: "INC",
  fire_branch: "INC",
  sprinkler: "INC",
  elevator: "ASC",
  arch_wall: "ARQ",
  arch_floor: "ARQ",
  door_window: "ARQ",
  curtain_wall: "ARQ",
  stairs: "ARQ",
  roof: "ARQ",
  railing: "ARQ",
  ceiling: "ARQ",
  furniture: "ARQ",
};

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

function unify(tokens: Array<string | null>): string | null {
  const t = [...new Set(tokens.filter((x): x is string => !!x))];
  if (!t.length) return null;
  if (t.length === 1) return t[0]!;
  if (t.every((x) => x === "MEP" || x === "INC")) return "MEP";
  return null;
}

/** Discipline / discipline-group token of one side matcher ("EST", "MEP", "CLI", "SAN/ALL"…); null = any. */
export function sideToken(m: unknown): string | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  const disc = [...asList(o.discipline), ...asList(o.disciplineGroup)];
  if (disc.length) return disc.join("/");
  const cls = o.elementClass;
  if (cls !== undefined) {
    if (cls && typeof cls === "object" && !Array.isArray(cls)) {
      const c = cls as Record<string, unknown>;
      if (typeof c.inSet === "string") return CLASS_GROUP[c.inSet] ?? null;
      return unify(asList(c.in ?? c.eq).map((x) => CLASS_GROUP[x] ?? null));
    }
    return unify(asList(cls).map((x) => CLASS_GROUP[x] ?? null));
  }
  if (o.isElevator === true) return "ASC";
  if (o.isStructural === true || o.isPostTensioned === true) return "EST";
  if (Array.isArray(o.anyOf)) return unify(o.anyOf.map(sideToken));
  return null;
}

/** [a, b] side tokens of a rule (both → same token on each side). */
export function ruleSides(r: Pick<RawRule, "when">): [string | null, string | null] {
  const w = r.when as Record<string, unknown>;
  const both = sideToken(w.both);
  return [sideToken(w.a) ?? both, sideToken(w.b) ?? both];
}

// ── Structural / life-safety policy (CLAUDE.md hard rules 3 and 4) ───────────

const POLICY_TOKENS = /structure_|STRUCTURE|isStructural|isPostTensioned|sprinkler|fire_main|fire_branch|elevator|isElevator|stairs|isFireRated|isFireDamper|isSeismicJoint|"(EST|INC|GAS|ASC)"/;

/** True when the conditions touch structure or life safety (static check of the matcher). */
export function touchesPolicyClass(r: Pick<RawRule, "when">): boolean {
  return POLICY_TOKENS.test(JSON.stringify(r.when ?? {}));
}

export const CLOSING = new Set(["false_positive", "tolerated"]);

// ── Unified diff ─────────────────────────────────────────────────────────────

/** Minimal unified diff of one file (LCS on lines, 3 lines of context). "" when equal. */
export function unifiedDiff(file: string, before: string, after: string): string {
  const a = normalizeText(before).split("\n");
  const b = normalizeText(after).split("\n");
  if (before === after) return "";
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * (m + 1) + j] = A[i] === B[j] ? dp[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(dp[(i + 1) * (m + 1) + j]!, dp[i * (m + 1) + j + 1]!);
  type Op = { t: " " | "-" | "+"; s: string };
  const ops: Op[] = a.slice(0, pre).map((s) => ({ t: " " as const, s }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      ops.push({ t: " ", s: A[i]! });
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i * (m + 1) + j + 1]! >= dp[(i + 1) * (m + 1) + j]!)) ops.push({ t: "+", s: B[j++]! });
    else ops.push({ t: "-", s: A[i++]! });
  }
  for (const s of a.slice(a.length - suf)) ops.push({ t: " ", s });
  const CTX = 3;
  const out = [`--- a/rules/${file}`, `+++ b/rules/${file}`];
  let k = 0;
  let oldLine = 1;
  let newLine = 1;
  const pos: Array<{ o: number; n: number }> = [];
  for (const op of ops) {
    pos.push({ o: oldLine, n: newLine });
    if (op.t !== "+") oldLine++;
    if (op.t !== "-") newLine++;
  }
  while (k < ops.length) {
    while (k < ops.length && ops[k]!.t === " ") k++;
    if (k >= ops.length) break;
    let start = Math.max(0, k - CTX);
    let end = k;
    // Extend while changes are closer than 2*CTX.
    for (;;) {
      while (end < ops.length && ops[end]!.t !== " ") end++;
      let next = end;
      while (next < ops.length && ops[next]!.t === " ") next++;
      if (next < ops.length && next - end <= 2 * CTX) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + CTX);
    const slice = ops.slice(start, stop);
    const oldLen = slice.filter((o) => o.t !== "+").length;
    const newLen = slice.filter((o) => o.t !== "-").length;
    const o0 = pos[start]!.o - (oldLen === 0 ? 1 : 0);
    const n0 = pos[start]!.n - (newLen === 0 ? 1 : 0);
    out.push(`@@ -${o0},${oldLen} +${n0},${newLen} @@`, ...slice.map((o) => `${o.t}${o.s}`));
    k = stop;
    start = stop;
  }
  return out.join("\n") + "\n";
}
