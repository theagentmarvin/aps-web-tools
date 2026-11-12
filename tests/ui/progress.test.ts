/**
 * G2 (coordinator journey 2026-11): "Aprobar grupo" (family) decisions count in the workspace
 * progress. Before, 6 family approvals showed "0/156" and "Enviar 0 a aprobación" (disabled).
 */
import { describe, expect, it } from "vitest";
import { computeProgress, type ProgressFamily } from "../../src/features/triage/progress";

type Inst = ProgressFamily["instances"][number];
const inst = (groupId: string, state: Inst["inheritance"]["state"] = "inherited"): Inst =>
  ({ groupId, title: groupId, levels: [], validity: "real", band: 2, uniqueClashCount: 1, rawClashCount: 1, delta: "new", inheritance: { state } }) as Inst;
const fam = (id: string, instances: Inst[], opts: { status?: "approved" | "rejected"; action?: string; pendingSend?: number } = {}): ProgressFamily =>
  ({
    id,
    instances,
    ...(opts.status ? { decision: { status: opts.status, action: opts.action ?? "create_issue" } } : {}),
    ...(opts.pendingSend !== undefined ? { pendingSend: opts.pendingSend } : {}),
  }) as ProgressFamily;

const ids = ["g1", "g2", "g3", "g4", "g5", "g6"];

describe("computeProgress", () => {
  it("family approvals alone: done counts inherited instances and ready counts the families to send", () => {
    const p = computeProgress({
      ids,
      latest: new Map(),
      families: [fam("F-a", [inst("g1"), inst("g2")], { status: "approved", pendingSend: 2 }), fam("F-b", [inst("g3"), inst("g4", "inherited_pending")], { status: "approved", pendingSend: 1 })],
    });
    expect(p).toMatchObject({ done: 3, total: 6, ready: 2 });
    expect(p.breakdown.family).toBe(3);
  });

  it("a sent family (pendingSend 0) is done but not ready; a rejected family decides nothing", () => {
    const p = computeProgress({
      ids,
      latest: new Map(),
      families: [fam("F-a", [inst("g1")], { status: "approved", pendingSend: 0 }), fam("F-b", [inst("g2")], { status: "rejected" }), fam("F-c", [inst("g3", "none")])],
    });
    expect(p).toMatchObject({ done: 1, ready: 0 });
  });

  it("group decisions: only unbatched accept / correct are ready; covered groups go with the family", () => {
    const latest = new Map([
      ["g1", { kind: "accept" as const }],
      ["g2", { kind: "correct" as const, batchId: "L-1" }],
      ["g3", { kind: "reject" as const }],
      ["g4", { kind: "postpone" as const }],
      ["g5", { kind: "accept" as const }],
    ]);
    const p = computeProgress({ ids, latest, families: [fam("F-a", [inst("g5"), inst("g6")], { status: "approved", pendingSend: 2 })] });
    // g1 ready; g5 covered by F-a; F-a ready once
    expect(p.ready).toBe(2);
    // g1, g2, g3 own + g5 own (accept) + g6 via family
    expect(p.done).toBe(5);
    expect(p.breakdown).toEqual({ accepted: 2, corrected: 1, rejected: 1, postponed: 1, family: 1 });
  });

  it("an escalated family produces no ACC write: it never covers a group's own decision nor counts as ready", () => {
    const latest = new Map([["g1", { kind: "accept" as const }]]);
    const p = computeProgress({ ids, latest, families: [fam("F-a", [inst("g1"), inst("g2")], { status: "approved", action: "escalate", pendingSend: 0 })] });
    expect(p.ready).toBe(1);
    expect(p.done).toBe(2);
  });

  it("a postponed group stays pending even when a family covers it", () => {
    const latest = new Map([["g1", { kind: "postpone" as const }]]);
    const p = computeProgress({ ids, latest, families: [fam("F-a", [inst("g1")], { status: "approved", pendingSend: 1 })] });
    expect(p.done).toBe(0);
    expect(p.ready).toBe(1);
  });

  it("manual (clash) mode ignores families", () => {
    const p = computeProgress({ ids: ["c1", "c2"], latest: new Map([["c1", { kind: "accept" as const }]]), families: [fam("F-a", [inst("c2")], { status: "approved", pendingSend: 1 })], manual: true });
    expect(p).toMatchObject({ done: 1, ready: 1 });
  });
});
