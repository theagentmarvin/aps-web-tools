/**
 * Read-only review dump (BIM coordination specialist review, 2026-11).
 * Ingests + classifies fixture v41 and v42 in a temp COORDINATOR_HOME and writes
 * groups, clashes, review reasons and issue drafts to the JSON path in argv[2].
 *   COORD_DATA_SOURCE=fixtures COORDINATOR_HOME=$(mktemp -d) npx tsx scripts/review/dump.ts out.json
 */
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator } from "../../server/coordinator";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const out = process.argv[2] ?? "review-dump.json";
const truth = JSON.parse(readFileSync(resolve(root, "tests/fixtures/fixture-truth.json"), "utf8"));
const coord = new Coordinator({ root });
const res: Record<string, unknown> = {};
for (const v of ["41", "42"]) {
  const ing = await coord.ingest({ projectId: "b.demo-proyecto", testId: truth.tests[v] });
  const cls = await coord.classify({ testKey: ing.testKey });
  const { cls: rec } = await coord.requireClassified(ing.testKey);
  res[v] = { ingest: ing, classify: cls, record: rec };
}
writeFileSync(out, JSON.stringify(res, null, 1));
console.log("written", out);
