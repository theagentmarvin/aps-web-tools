/**
 * Read-only what-if for the 2026-11 engine review (docs/domain/engine-review-2026-11.md).
 * Runs the fixture v42 test through the engine with (a) current rules + current
 * review policy and (b) a candidate rules patch (applied to a temp copy, never to
 * rules/) + the proposed review policy, and prints review-load metrics.
 *
 *   COORD_DATA_SOURCE=fixtures COORDINATOR_HOME=$(mktemp -d) npx tsx scripts/review/simulate.ts <candidate.patch> [out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCoordination } from "../../core/pipeline";
import type { ClashGroup } from "../../core/group";
import { DEFAULT_REVIEW_POLICY, type ReviewPolicy } from "../../core/group/review";
import { moverSideOf } from "../../core/classified";
import { Coordinator } from "../../server/coordinator";
import { loadRules } from "../../server/engine";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const patchPath = process.argv[2];
const outPath = process.argv[3];
const truth = JSON.parse(readFileSync(resolve(root, "tests/fixtures/fixture-truth.json"), "utf8"));
const coord = new Coordinator({ root });

const PROPOSED: ReviewPolicy = {
  autoAccept: { real: 0.75, false_positive: 0.88, duplicate: 0.9, tolerance: 0.85 },
  reviewFloor: 0.55,
  alwaysReview: { severity: ["critical"], minClashCount: 150, unmatched: true, rulesConflict: true },
  bulkClosureMax: 50,
};

/** Mirrors the proposed core/group/index.ts trigger (structural opening). */
function structuralOpening(g: ClashGroup): boolean {
  const closable = g.validity === "false_positive" || g.validity === "tolerated";
  return g.tags.includes("pasada_estructural") && (closable || g.rootCause === "missing_opening");
}

type Row = { id: string; strategy: string; n: number; validity: string; rules: string; sev: string; conf: number; review: boolean; reasons: string[]; patterns: Record<string, number>; title: string; meetingKey: string };

async function run(label: string, rulesDir: string | undefined, policy: ReviewPolicy, extra: boolean) {
  const { test } = await coord.loadTest();
  const raw = await coord.loadRaw(test);
  const res = runCoordination({ clashes: raw.clashes, elements: raw.elements, documents: raw.documents, rules: loadRules(rulesDir), options: { review: policy } });
  const byKey = new Map(res.classified.map((c) => [c.key, c]));
  const rows: Row[] = res.groups.map((g) => {
    const reasons = [...g.reviewReasons];
    if (extra && structuralOpening(g)) reasons.push("pasada en estructura (calculista)");
    const patterns: Record<string, number> = {};
    for (const id of g.mcClashIds) patterns[truth.patterns[id] ?? "?"] = (patterns[truth.patterns[id] ?? "?"] ?? 0) + 1;
    const first = byKey.get(g.memberKeys[0]!)!;
    const [, other] = moverSideOf(first);
    // "Meeting item": what a coordinator would put on one agenda line.
    const meetingKey = g.validity === "real" && ["run", "zone", "single", "hub-mover", "hub-fixed"].includes(g.strategy)
      ? ["real", g.levels.join(","), g.responsibleDiscipline, other.discipline, other.elementClass, g.severity].join("|")
      : g.id;
    return { id: g.id, strategy: g.strategy, n: g.mcClashIds.length, validity: g.validity, rules: g.ruleIds.join(","), sev: g.severity, conf: g.confidence, review: reasons.length > 0, reasons, patterns, title: g.title, meetingKey };
  });
  // Unsafe closures vs fixture truth: real patterns closed.
  const REAL = new Set(["real_duct_beam", "real_pipe_beam", "real_tray_duct", "real_inc_pipe_duct", "real_pipe_wall", "real_pipe_slab_no_sleeve"]);
  let unsafe = 0;
  let unsafeAuto = 0;
  for (const r of rows) {
    if (r.validity !== "false_positive" && r.validity !== "tolerated") continue;
    for (const [p, n] of Object.entries(r.patterns)) if (REAL.has(p)) { unsafe += n; if (!r.review) unsafeAuto += n; }
  }
  const reasons: Record<string, number> = {};
  for (const r of rows) if (r.review) for (const x of r.reasons) { const k = x.replace(/[0-9.]+ < /, "x < "); reasons[k] = (reasons[k] ?? 0) + 1; }
  const meeting = new Map<string, Row[]>();
  for (const r of rows) meeting.set(r.meetingKey, [...(meeting.get(r.meetingKey) ?? []), r]);
  const meetingReview = [...meeting.values()].filter((rs) => rs.some((r) => r.review)).length;
  const summary = {
    label,
    groups: rows.length,
    needsReview: rows.filter((r) => r.review).length,
    reviewClashes: rows.filter((r) => r.review).reduce((n, r) => n + r.n, 0),
    meetingItems: meeting.size,
    meetingItemsNeedingReview: meetingReview,
    unsafeClosedRealClashes: unsafe,
    unsafeClosedAndAutoOk: unsafeAuto,
    reasons,
    byStrategy: res.stats.groups.byStrategy,
    byValidity: res.stats.byValidity,
    topRules: res.stats.topRules,
  };
  console.log(JSON.stringify(summary));
  return { summary, rows };
}

const v42 = truth.tests["42"];
await coord.ingest({ projectId: "b.demo-proyecto", testId: truth.tests["41"] });
await coord.ingest({ projectId: "b.demo-proyecto", testId: v42 });
const out: Record<string, unknown> = {};
out.current = await run("current rules + current policy", undefined, DEFAULT_REVIEW_POLICY, false);
out.policyOnly = await run("current rules + proposed policy", undefined, PROPOSED, true);
if (patchPath) {
  const dir = await coord.candidateRulesDir(Promise.resolve(readFileSync(patchPath, "utf8")));
  out.rulesOnly = await run("candidate rules + current policy", dir, DEFAULT_REVIEW_POLICY, false);
  out.proposed = await run("candidate rules + proposed policy", dir, PROPOSED, true);
  const ev = await coord.evaluateRuleset({ candidatePatch: readFileSync(patchPath, "utf8"), suites: ["eval_scenarios", "fixtures"] });
  out.eval = ev;
  console.log(JSON.stringify(ev).slice(0, 3000));
}
if (outPath) writeFileSync(outPath, JSON.stringify(out, null, 1));
