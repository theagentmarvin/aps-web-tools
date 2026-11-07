/** Helpers for server tests: a fixture-mode Coordinator in a temp `.coordinator`. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema, effectiveLevelOf, type AutonomyLevel, type LoadedConfig } from "../../server/config";
import { Coordinator } from "../../server/coordinator";
import { CoordinatorUi, type HumanUser } from "../../server/coordinator-ui";
import { FixtureSource, FIXTURE_PROJECT_ID } from "../../server/source/fixtures";
import type { Decision } from "../../server/api/contract";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const MODEL_SET_ID = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
export const TEST_V41 = "14820aef-b213-4fa2-a313-9135ac138630";
export const TEST_V42 = "15820c82-999d-4953-a89d-97c09f9da2c5";
export const HUMAN: HumanUser = { id: "u-camila", name: "Camila Rojas" };

export function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "coord-test-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function testConfig(overrides: Record<string, unknown> = {}, level: AutonomyLevel = 1): LoadedConfig {
  const config = ConfigSchema.parse({ ...overrides, approver: { name: "Camila Rojas" } });
  return { config, configuredLevel: level, effectiveLevel: effectiveLevelOf(level), sources: ["test"] };
}

export function makeCoord(home: string, opts: { config?: LoadedConfig; now?: () => number } = {}): Coordinator {
  return new Coordinator({
    root: ROOT,
    home,
    dataSource: "fixtures",
    source: new FixtureSource({ home }),
    config: opts.config ?? testConfig(),
    now: opts.now,
  });
}

/** Ingest (+ classify) a fixture test version. */
export async function ingest(coord: Coordinator, version: 41 | 42, classify = true): Promise<string> {
  const r = await coord.ingest({ projectId: FIXTURE_PROJECT_ID, modelSetId: MODEL_SET_ID, testId: version === 41 ? TEST_V41 : TEST_V42 });
  if (classify) await coord.classify({ testKey: r.testKey });
  return r.testKey;
}

let n = 0;
/** Accept the UI proposal of each given group as a human. */
export async function acceptGroups(ui: CoordinatorUi, testKey: string, groupIds: string[], kind: Decision["kind"] = "accept"): Promise<void> {
  const page = await ui.proposals(testKey, undefined, 1000);
  const decisions: Decision[] = groupIds.map((g) => {
    const p = page.items.find((x) => x.targetId === g)!;
    return {
      id: `d-${Date.now()}-${n++}-${g}`,
      proposalId: p.id,
      targetType: "group",
      targetId: g,
      testId: testKey,
      modelSetId: MODEL_SET_ID,
      projectId: "demo-proyecto",
      kind,
      changes: [],
      ...(kind === "reject" || kind === "correct" ? { reasonCode: "R01" as const } : {}),
      viewedInViewerMs: 2000,
      decidedAt: new Date().toISOString(),
      userId: "ignored",
      userName: "ignored",
    };
  });
  await ui.saveDecisions(decisions, HUMAN);
}

export { CoordinatorUi, FIXTURE_PROJECT_ID };
