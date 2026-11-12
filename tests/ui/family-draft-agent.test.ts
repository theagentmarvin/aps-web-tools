/**
 * Bug fix (docs/ux/agent-human-loop-proposal.md P1): when the agent proposed a family decision, the
 * panel showed the agent's rationale next to the ENGINE's values, and «Aceptar propuesta» accepted the
 * engine's. The draft now takes the pending agent proposal's typed values; a coordinator edit still wins
 * and an approved decision is never overridden by a proposal.
 */
import { beforeAll, describe, expect, it } from "vitest";

const STORE_MODULE: string = "../../src/features/triage/store";
/* eslint-disable @typescript-eslint/no-explicit-any */
let mod: any;

const family = (extra: Record<string, unknown> = {}) => ({
  id: "F-abc1234567",
  proposed: { validity: "real", action: "create_issue", responsibleDiscipline: "CLI", band: 1 },
  pendingProposals: [] as Array<{ id: string; createdAt: string; rationale: string; payload: Record<string, unknown> }>,
  ...extra,
});

function storeWith(f: unknown) {
  const s = new mod.TriageStore({} as never, { filters: {}, sort: "priority", q: "", view: "groups" });
  s.state.families = new Map([[(f as { id: string }).id, f]]);
  return s;
}

beforeAll(async () => {
  mod = await import(/* @vite-ignore */ STORE_MODULE);
});

describe("familyDraft uses the agent proposal's values", () => {
  it("engine values when no agent proposal", () => {
    expect(storeWith(family()).familyDraft("F-abc1234567")).toMatchObject({ validity: "real", action: "create_issue", responsibleDiscipline: "CLI" });
  });

  it("agent payload values when an agent proposal is pending (what is shown = what is accepted)", () => {
    const f = family({
      pendingProposals: [{ id: "P-1", createdAt: "2026-11-11T10:00:00Z", rationale: "Contacto sin penetración.", payload: { kind: "family_decision", familyId: "F-abc1234567", validity: "tolerated", action: "mark_reviewed", responsibleDiscipline: "EST", issueMode: "family" } }],
    });
    const s = storeWith(f);
    expect(s.familyDraft("F-abc1234567")).toMatchObject({ validity: "tolerated", action: "mark_reviewed", responsibleDiscipline: "EST" });
    // A coordinator correction wins over the agent.
    s.setFamilyDraft("F-abc1234567", { validity: "real", action: "create_issue" });
    expect(s.familyDraft("F-abc1234567")).toMatchObject({ validity: "real", action: "create_issue", responsibleDiscipline: "EST" });
  });

  it("ignores malformed payload fields and never overrides an approved decision", () => {
    const bad = family({ pendingProposals: [{ id: "P-2", createdAt: "x", rationale: "", payload: { validity: "maybe", action: 3, responsibleDiscipline: "" } }] });
    expect(storeWith(bad).familyDraft("F-abc1234567")).toMatchObject({ validity: "real", action: "create_issue", responsibleDiscipline: "CLI" });
    const decided = family({
      decision: { status: "approved", validity: "needs_info", action: "escalate", responsibleDiscipline: "ARQ" },
      pendingProposals: [{ id: "P-3", createdAt: "x", rationale: "", payload: { validity: "tolerated", action: "mark_reviewed" } }],
    });
    expect(storeWith(decided).familyDraft("F-abc1234567")).toMatchObject({ validity: "needs_info", action: "escalate", responsibleDiscipline: "ARQ" });
    expect(mod.agentFamilyValues(bad)).toEqual({ proposalId: "P-2" });
  });
});
