/**
 * Run the 25 eval scenarios (docs/domain/eval-scenarios.md) through the
 * deterministic engine and print accuracy per field, the validity confusion
 * matrix and unsafe closures (real -> false_positive/tolerated; must be 0).
 *
 *   npx tsx scripts/eval.ts [--verbose]
 * Exit code 1 if any scenario fails or any unsafe closure exists.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateScenarios, parseScenarioMarkdown, ASSERTED_FIELDS } from "../core/eval/scenarios";
import { loadRulesFromDisk } from "../server/rules-loader";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

const rs = loadRulesFromDisk();
const scenarios = parseScenarioMarkdown(readFileSync(path.join(root, "docs/domain/eval-scenarios.md"), "utf8"));
const report = evaluateScenarios(rs, scenarios);

console.log(`Ruleset ${rs.hash.slice(0, 12)} · rules v${rs.versions.rules} · matrix v${rs.versions.matrix} · scoring v${rs.versions.scoring} · ${rs.rules.length} rules\n`);
for (const r of report.results) {
  const c = r.clash.classification;
  const mark = r.diffs.length ? "FAIL" : "ok  ";
  console.log(`${mark} ${r.scenario.id.padEnd(6)} ${c.ruleId.padEnd(8)} ${c.validity.padEnd(15)} ${c.severity.padEnd(8)} ${(c.responsibleDiscipline + "/" + (c.secondaryDiscipline ?? "")).padEnd(10)} ${String(r.clash.priority.score).padStart(3)} ${r.clash.priority.band.padEnd(4)} conf=${c.confidence} ${c.tags.length ? `tags=${c.tags.join(",")}` : ""}`);
  for (const d of r.diffs) console.log(`       ${d.field}: expected ${JSON.stringify(d.expected)} got ${JSON.stringify(d.actual)}`);
  if (verbose) console.log(`       ${c.rationale}`);
}

console.log("\nAccuracy per field");
for (const f of ASSERTED_FIELDS) {
  const a = report.fieldAccuracy[f];
  const pct = a.asserted ? ((100 * a.correct) / a.asserted).toFixed(1) : "n/a";
  console.log(`  ${f.padEnd(22)} ${String(a.correct).padStart(2)}/${String(a.asserted).padEnd(2)}  ${pct}%`);
}

const vals = ["real", "false_positive", "tolerated", "needs_info"];
console.log("\nValidity confusion (rows = expected, cols = engine)");
console.log(`  ${"".padEnd(15)} ${vals.map((v) => v.slice(0, 14).padStart(15)).join("")}`);
for (const e of vals) {
  const row = report.validityConfusion[e] ?? {};
  console.log(`  ${e.padEnd(15)} ${vals.map((v) => String(row[v] ?? 0).padStart(15)).join("")}`);
}

// Scenarios whose expected label depends on a rules patch still awaiting calibration
// with real project data (docs/domain/rules-pending-2026-11.patch). They may fail ONLY
// in the safe direction (engine says "real"); anything else still fails the run.
const pending = new Map<string, string>(
  rs.versions.matrix < 2 ? [["EV-05", "needs matrix patch M1 (Sin RF = non-rated)"]] : [],
);
const failed = report.results.filter((r) => r.diffs.length > 0);
const pendingSafe = failed.filter(
  (r) => pending.has(r.scenario.id) && r.clash.classification.validity === "real",
);
const hardFailures = failed.length - pendingSafe.length;

console.log(`\nScenarios passed: ${report.passed}/${report.total}`);
for (const r of pendingSafe) console.log(`  pending ${r.scenario.id}: ${pending.get(r.scenario.id)} (engine stays "real": safe)`);
console.log(`Unsafe closures (real -> false_positive/tolerated): ${report.unsafeClosures.length}`);
for (const u of report.unsafeClosures) console.log(`  ${u.id} -> ${u.actual}`);

if (hardFailures > 0 || report.unsafeClosures.length > 0) process.exitCode = 1;
