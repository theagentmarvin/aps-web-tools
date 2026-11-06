/** Load errors for rule files. The loader fails closed on any issue. */

export type RuleFile = "discipline-matrix" | "classification-rules" | "priority-scoring" | "holidays";

export interface LoadIssue {
  file: RuleFile;
  /** Dotted/bracketed path inside the file, e.g. `rules[12].when.a.elementClass.inSet`. */
  path: string;
  message: string;
}

export class RulesLoadError extends Error {
  readonly issues: readonly LoadIssue[];
  constructor(issues: readonly LoadIssue[]) {
    const head = issues.slice(0, 10).map((i) => `${i.file}.yaml: ${i.path || "<root>"}: ${i.message}`);
    const more = issues.length > 10 ? `\n… and ${issues.length - 10} more` : "";
    super(`Rule files failed to load (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n${head.join("\n")}${more}`);
    this.name = "RulesLoadError";
    this.issues = issues;
  }
}

/** Format a zod/our path array as `a.b[3].c`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out;
}

export function joinPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}
