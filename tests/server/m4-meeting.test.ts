/**
 * M4 (docs/PLAN-core-features-simplified.md §3 F4): agenda (server table), meeting notes,
 * the dueDate-quote rule on propose_family_decision, saved viewer views, and the eval CLI steps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgenda } from "../../server/meeting";
import type { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { HUMAN, ingest, makeCoord, MODEL_SET_ID, tempHome } from "./helpers";

let home: string;
let cleanup: () => void;
let coord: Coordinator;
let ui: CoordinatorUi;
beforeEach(() => {
  ({ home, cleanup } = tempHome());
  coord = makeCoord(home);
  ui = new CoordinatorUi(coord);
});
afterEach(() => cleanup());

describe("agenda", () => {
  it("per discipline, fixed order regresion → p1 → incidencia → nuevo → confirmar; each item once", async () => {
    const k41 = await ingest(coord, 41);
    await coord.issueChecksFor(k41);
    const k42 = await ingest(coord, 42);
    const a = await coord.agendaFor(k42);
    expect(a).toMatchObject({ testId: k42, version: 42, baseVersion: 41, cap: 15 });
    const order = ["incidencia", "regresion", "p1_pendiente", "nuevo", "confirmar_resuelta"];
    const kinds = new Set<string>();
    const seen = new Set<string>();
    for (const d of a.disciplines) {
      const idx = d.items.map((i) => order.indexOf(i.kind));
      expect(idx).toEqual([...idx].sort((x, y) => x - y));
      // Only non-zero kinds, singular/plural right ("ALC: 6 P1 pendientes, 1 reaparecida.").
      expect(d.summary).toMatch(new RegExp(`^${d.discipline}: (\\d+ [^,]+)(, \\d+ [^,]+)*\\.$|^${d.discipline}: sin temas\\.$`));
      expect(d.summary).not.toMatch(/\b0 /);
      expect(d.summary).not.toMatch(/\(s\)/);
      for (const i of d.items) {
        kinds.add(i.kind);
        const key = i.issueId ? `i:${i.issueId}` : `f:${i.familyId}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        expect(i.reason.length).toBeLessThan(120);
      }
    }
    expect(kinds).toContain("regresion"); // 13 reappeared clashes in the fixture
    expect(kinds).toContain("incidencia"); // dice_resuelta / stuck / overdue issues (M3 fixtures)
    // the resolved verdict to confirm is there when nothing is cut by the cap
    expect((await coord.agendaFor(k42, 200)).disciplines.flatMap((d) => d.items).some((i) => i.kind === "confirmar_resuelta" && i.issueId === "0b6c1f00-0000-4000-8000-00000000i003")).toBe(true);
    const inc = (await coord.agendaFor(k42, 200)).disciplines.flatMap((d) => d.items).filter((i) => i.kind === "incidencia").map((i) => i.issueId);
    expect(inc).toContain("0b6c1f00-0000-4000-8000-00000000i002");
    expect(inc).toContain("0b6c1f00-0000-4000-8000-00000000i006");
    // HTTP-shaped via the route method too
    expect((await coord.agendaFor(k42)).disciplines.length).toBe(a.disciplines.length);
  });

  it("caps each discipline with +N más", () => {
    const groups = Array.from({ length: 20 }, (_, i) => ({ id: `G-${String(i).padStart(10, "0")}`, band: 1, clashIds: ["x"], uniqueClashCount: 1 }));
    const families = groups.map((g, i) => ({ id: `F-${String(i).padStart(10, "0")}`, bucket: "pair", title: `Familia ${i}`, groupIds: [g.id], proposed: { responsibleDiscipline: "CLI" } }));
    const a = buildAgenda({ version: 2, testKey: "T-x", families: families as never, groups: groups as never, change: () => "unchanged", needsHuman: () => true, issues: [], cap: 15 });
    expect(a.disciplines).toHaveLength(1);
    expect(a.disciplines[0]!.items).toHaveLength(15);
    expect(a.disciplines[0]!.more).toBe(5);
    expect(a.disciplines[0]!.items.every((i) => i.kind === "p1_pendiente")).toBe(true);
  });
});

describe("meeting notes", () => {
  it("CRUD with revisions; validation; MCP returns them as untrusted text without author names", async () => {
    const k42 = await ingest(coord, 42);
    const fam = (await ui.families(k42)).families[0]!;
    const n1 = await coord.putMeetingNote(k42, "family", fam.id, "Se acordó revisar la pasada.", HUMAN);
    expect(n1).toMatchObject({ revision: 1, author: HUMAN.id, targetType: "family", targetId: fam.id, version: 42 });
    const n2 = await coord.putMeetingNote(k42, "family", fam.id, "Se acordó corregir para el 20-11-2026.\u0007", HUMAN);
    expect(n2.revision).toBe(2);
    expect(n2.text).toBe("Se acordó corregir para el 20-11-2026.");
    expect(n2.history).toHaveLength(1);
    await coord.putMeetingNote(k42, "group", fam.groupIds[0]!, "Ubicación: bajar 100 mm.", HUMAN);
    await expect(coord.putMeetingNote(k42, "family", "F-0000000000", "x", HUMAN)).rejects.toThrow(/no existe/);
    await expect(coord.putMeetingNote(k42, "group", fam.groupIds[0]!, "x".repeat(2001), HUMAN)).rejects.toThrow(/2000/);
    const notes = await coord.notesFor((await coord.store.getTest(k42))!);
    expect(notes).toHaveLength(2);
    const mcp = await coord.listMeetingNotes({ testKey: k42, familyId: fam.id, limit: 50 });
    expect(mcp.rows).toHaveLength(2); // the family note and its ubicación's note
    expect(mcp.rows[0]![3]).toHaveProperty("untrusted");
    expect(JSON.stringify(mcp)).not.toContain(HUMAN.name);
  });

  it("saved viewer view per family (≤ 20 KB, local)", async () => {
    const k42 = await ingest(coord, 42);
    const fam = (await ui.families(k42)).families[0]!;
    await expect(coord.getFamilyView(k42, fam.id)).rejects.toThrow(/Sin vista/);
    const cam = { position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], fov: 45 };
    await coord.saveFamilyView(k42, fam.id, cam, HUMAN);
    expect((await coord.getFamilyView(k42, fam.id)).camera).toEqual(cam);
    await expect(coord.saveFamilyView(k42, fam.id, { blob: "x".repeat(21 * 1024) }, HUMAN)).rejects.toThrow(/KB/);
  });
});

describe("propose_family_decision: dates only from the notes, never a closure of real", () => {
  it("dueDate requires a verbatim quote of the family's (or its ubicación's) note", async () => {
    const k42 = await ingest(coord, 42);
    const fams = (await ui.families(k42)).families;
    const real = fams.find((f) => (f.validityMix.real ?? 0) > 0 && f.instanceCount >= 2)!;
    const base = { testKey: k42, familyId: real.id, validity: "real" as const, action: "create_issue" as const, rationale: "Acuerdo de reunión." };
    await expect(coord.proposeFamilyDecision({ ...base, dueDate: "2026-11-20" })).rejects.toThrow(/dueDateQuote/);
    await expect(coord.proposeFamilyDecision({ ...base, dueDate: "2026-11-20", dueDateQuote: "20-11-2026" })).rejects.toThrow(/no aparece/);
    await coord.putMeetingNote(k42, "group", real.groupIds[1]!, "Corrige trazado para el 20-11-2026.", HUMAN);
    const ok = await coord.proposeFamilyDecision({ ...base, dueDate: "2026-11-20", dueDateQuote: "20-11-2026" });
    const p = (await coord.store.getProposal(ok.proposalId))!;
    expect(p.payload).toMatchObject({ dueDate: "2026-11-20", dueDateQuote: "20-11-2026" });
    await expect(coord.proposeFamilyDecision({ ...base, dueDate: "20/11/2026", dueDateQuote: "20-11-2026" })).rejects.toThrow(/AAAA-MM-DD/);
    // never a closure of a family with real members, whatever validity is claimed
    await expect(coord.proposeFamilyDecision({ ...base, validity: "false_positive", action: "close" })).rejects.toThrow(/no se cierra/);
    await expect(coord.proposeFamilyDecision({ ...base, validity: "real", action: "mark_reviewed" })).rejects.toThrow(/no se cierra/);
  });
});

describe("eval CLI steps (fixtures mode)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });
  async function run(args: string[]): Promise<{ code: number; out: string }> {
    const { main } = await import("../../server/cli");
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => ((out += String(s)), true));
    const code = await main(args);
    vi.restoreAllMocks();
    return { code, out };
  }

  it("ingest --version 41/42, classify --propose and seed-meeting-notes resolve {validity, rank} to real family ids", async () => {
    process.env.COORDINATOR_HOME = home;
    process.env.COORD_DATA_SOURCE = "fixtures";
    const i41 = await run(["ingest", "--version", "41"]);
    expect(i41.code).toBe(0);
    expect(JSON.parse(i41.out).modelSet.version).toBe(41);
    expect((await run(["classify", "--propose"])).code).toBe(0);
    const i42 = await run(["ingest", "--version", "42"]);
    expect(JSON.parse(i42.out).modelSet.version).toBe(42);
    expect((await run(["classify", "--propose"])).code).toBe(0);
    const seed = await run(["seed-meeting-notes", "evals/fixtures/acta-notes.json"]);
    expect(seed.code).toBe(0);
    const res = JSON.parse(seed.out) as { testKey: string; seeded: Array<{ id: string; familyId: string }> };
    expect(res.seeded.map((s) => s.id)).toEqual(["WN-01", "WN-02", "WN-03", "WN-04", "WN-05"]);
    for (const s of res.seeded) expect(s.familyId).toMatch(/^F-/);
    const c = makeCoord(home);
    const views = (await c.familyViewsFor(res.testKey)).views;
    expect(views.find((f) => f.id === res.seeded[2]!.familyId)!.proposed.validity).toBe("false_positive");
    expect(views.find((f) => f.id === res.seeded[0]!.familyId)!.proposed.validity).toBe("real");
    expect((await c.listMeetingNotes({ testKey: res.testKey, limit: 50 })).rows).toHaveLength(5);
  });

  it("seed-meeting-notes refuses outside fixtures mode", async () => {
    process.env.COORDINATOR_HOME = home;
    delete process.env.COORD_DATA_SOURCE;
    const r = await run(["seed-meeting-notes", "evals/fixtures/acta-notes.json"]).catch((e: Error) => ({ code: 1, out: e.message }));
    expect(r.code).not.toBe(0);
  });
});

void MODEL_SET_ID;
