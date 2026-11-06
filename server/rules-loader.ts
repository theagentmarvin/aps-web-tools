/**
 * Node-only loader for the rule files. The engine itself (core/rules) is pure
 * and takes parsed objects or YAML strings.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuleSet, type CompiledRuleSet } from "../core/rules/load";

/** Repository `rules/` directory (resolved from this file). */
export const DEFAULT_RULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "rules");

export interface RulesFiles {
  dir?: string;
  matrix?: string;
  classification?: string;
  scoring?: string;
  holidays?: string | null;
}

/**
 * Read and compile the rule set. Throws RulesLoadError (with file + path for
 * every issue) when anything is invalid.
 */
export function loadRulesFromDisk(files: RulesFiles = {}): CompiledRuleSet {
  const dir = files.dir ?? DEFAULT_RULES_DIR;
  const read = (p: string) => readFileSync(path.isAbsolute(p) ? p : path.join(dir, p), "utf8");
  const holidaysFile = files.holidays === null ? undefined : (files.holidays ?? "holidays-cl.yaml");
  const holidaysPath = holidaysFile && (path.isAbsolute(holidaysFile) ? holidaysFile : path.join(dir, holidaysFile));
  return loadRuleSet({
    matrix: read(files.matrix ?? "discipline-matrix.yaml"),
    classification: read(files.classification ?? "classification-rules.yaml"),
    scoring: read(files.scoring ?? "priority-scoring.yaml"),
    ...(holidaysPath && existsSync(holidaysPath) ? { holidays: readFileSync(holidaysPath, "utf8") } : {}),
  });
}
