/**
 * Regressions for the M1–M4 reviews (docs/domain/pilot-readiness-review.md + the security review).
 * Each block ports a confirmed proof of concept; it must now fail to exploit.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { accIndexOf, detectScopeChanges } from "../../server/cycle";
import { datesInQuote, quoteContainsDate, redactContacts } from "../../server/meeting";
import { pathSegment } from "../../server/store";
import { doc } from "../engine/helpers";
import { HUMAN, ingest, makeCoord, MODEL_SET_ID, tempHome } from "./helpers";

const P = "demo-proyecto";
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

async function approveAllFamilies(testKey: string, filter: (f: Awaited<ReturnType<CoordinatorUi["families"]>>["families"][number]) => boolean = () => true) {
  for (const f of (await ui.families(testKey)).families) {
    if (f.state !== "sin_decidir" || !filter(f)) continue;
    await ui.decideFamily(f.id, { testId: testKey, decision: "approve", spotChecked: f.groupIds.slice(0, 3), acknowledgeValidityChanges: true }, HUMAN).catch(() => undefined);
  }
}

describe("#1 family decisions across versions (PoC fam / batch)", () => {
  it("a family decision of v41 never silently decides a changed or engine-gated v42 instance", async () => {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const gate = new Map((await coord.requireClassified(k42)).cls.groups.map((g) => [g.id, g.reviewState]));
    await approveAllFamilies(k41);
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    const fam = tri.groups.filter((g) => g.inherited?.source === "family");
    expect(fam.length).toBeGreaterThan(0);
    for (const g of fam) {
      if (g.change !== "unchanged" || gate.get(g.id) === "needs_review") {
        expect(g.inherited!.needsConfirmation).toBe(true);
        expect(g.reviewState).not.toBe("decided");
      }
    }
  });

  it("v42 batch close items never carry real / needs_info / changed instances, nor a carried spot-check", async () => {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    await approveAllFamilies(k41, (f) => f.proposed.validity !== "real");
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    const byId = new Map(tri.groups.map((g) => [g.id, g]));
    const b = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: k42 }, HUMAN).catch(() => undefined);
    for (const i of (b?.items ?? []).filter((x) => x.familyId && x.mcOperation === "clash.close")) {
      expect(i.viewedInViewer).toBe(false);
      for (const gid of i.groupIds ?? []) {
        const g = byId.get(gid)!;
        expect(["real", "needs_info"]).not.toContain(g.validity);
        expect(g.change).toBe("unchanged");
      }
    }
  });
});

describe("#2 ACC state per version and on the unique clash (PoC acc)", () => {
  it("re-ingesting the older version does not change what the newer version reads", async () => {
    await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const sum = async () => (await coord.issueChecksFor(k42)).checks.map((c) => `${c.issueId}:${c.verdict}:${c.existing}/${c.resolved}`);
    const before = await sum();
    await ingest(coord, 41, false); // cached path re-reads ACC for v41
    expect(await sum()).toEqual(before);
  });

  it("a unique clash is ACC-decided when ANY of its raw ids is (linked copies)", () => {
    const ledger = {
      schema: 1,
      modelSetId: "m",
      versions: [11],
      accSync: { "11": { at: "", assignedGroups: 1, closedGroups: 0, issues: 1 } },
      entries: { "1": { id: "1", firstSeen: 11, lastSeen: 11, seenIn: [11], states: [], accByVersion: { "11": { status: "assigned", groupId: "ag", issueId: "i", version: 11 } } } },
    } as never;
    const idx = accIndexOf(ledger, [{ id: "1", pairKey: "a|b" }, { id: "2", pairKey: "a|b" }, { id: "3", pairKey: "a|b" }, { id: "4", pairKey: "c|d" }], 11);
    expect([...idx.keys()].sort()).toEqual(["1", "2", "3"]);
    // another version, or a version never synced, reads nothing
    expect(accIndexOf(ledger, [{ id: "1", pairKey: "a|b" }], 10).size).toBe(0);
  });

  it("an unsynced version shows its issues as no_verificable and never writes the verdict history", async () => {
    const k41 = await ingest(coord, 41);
    await ingest(coord, 42);
    await coord.ledger.withLedger(`b.${P}`, MODEL_SET_ID, (l) => {
      delete l.accSync!["41"];
      return l;
    });
    const c = await coord.issueChecksFor(k41);
    expect(c.checks.length).toBeGreaterThan(0);
    for (const x of c.checks) {
      expect(x.verdict).toBe("no_verificable");
      expect(x.reason).toMatch(/ACC sin sincronizar/);
    }
    const st = await coord.issueChecks.load(`b.${P}`, MODEL_SET_ID);
    expect(st.verdicts["41"]).toBeUndefined();
  });
});

describe("#3 no personal data in ACC bodies", () => {
  it("dry-run bodies of family and group items never contain the decider's or approver's name", async () => {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    void k41;
    const fams = (await ui.families(k42)).families;
    const real = fams.find((f) => f.proposed.validity === "real" && !f.validityMix.tolerated && !f.validityMix.false_positive && f.instanceCount <= 5)!;
    const tol = fams.find((f) => f.proposed.validity === "tolerated" && !f.validityMix.real)!;
    await ui.decideFamily(real.id, { testId: k42, decision: "approve", spotChecked: real.groupIds.slice(0, 3) }, HUMAN);
    await ui.decideFamily(tol.id, { testId: k42, decision: "approve", spotChecked: tol.groupIds.slice(0, 3) }, HUMAN);
    const b = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: k42 }, HUMAN);
    await ui.approve(b.id, { confirmWord: "APLICAR", excludedItemIds: [], demo: true }, HUMAN);
    const dry = await ui.apply(b.id, {}, { type: "user", id: HUMAN.id, name: HUMAN.name });
    const bodies = JSON.stringify(dry.requests.map((r) => r.body));
    expect(bodies.length).toBeGreaterThan(100);
    for (const n of [HUMAN.name, ...HUMAN.name.split(" ")]) expect(bodies).not.toContain(n);
    expect(bodies).toContain("Decisión de coordinación v1");
  });
});

describe("#4 the agenda shows follow-ups first", () => {
  it("issue follow-ups lead each discipline, carry #displayId, include no_verificable with a reason, and never count in the cap", async () => {
    const k41 = await ingest(coord, 41);
    await coord.issueChecksFor(k41);
    const k42 = await ingest(coord, 42);
    const a = await coord.agendaFor(k42, 1);
    const issues = a.disciplines.flatMap((d) => d.items.filter((i) => i.kind === "incidencia"));
    const ids = issues.map((i) => i.issueId);
    for (const n of [2, 4, 5, 6]) expect(ids).toContain(`0b6c1f00-0000-4000-8000-00000000i00${n}`);
    for (const i of issues) expect(i.displayId).toBeGreaterThan(100);
    for (const d of a.disciplines) {
      const k = d.items.map((i) => i.kind);
      const firstOther = k.findIndex((x) => x !== "incidencia");
      if (firstOther >= 0) expect(k.slice(firstOther)).not.toContain("incidencia");
      expect(d.items.filter((i) => i.kind !== "incidencia").length).toBeLessThanOrEqual(1);
    }
    const rem = await ui.reminders(k42);
    expect(rem.flatMap((r) => r.issueIds)).toContain("0b6c1f00-0000-4000-8000-00000000i004");
    expect(rem.map((r) => r.text).join("\n")).toMatch(/el problema se movió/);
  });
});

describe("#5 group titles count the group's own clashes", () => {
  it("every '(N interf.)' and 'por N' / 'vs N' count in a title matches the group", async () => {
    for (const v of [41, 42] as const) {
      const k = await ingest(coord, v);
      const { cls } = await coord.requireClassified(k);
      for (const g of cls.groups) {
        const n = g.uniqueClashCount ?? g.clashIds.length;
        const m = /\((\d+) interf\.\)/.exec(g.title);
        if (m) expect(Number(m[1]), g.title).toBe(n);
        const by = /\b(?:por|vs) (\d+) /.exec(g.title);
        if (by && g.engineStrategy.startsWith("hub")) expect(Number(by[1]), g.title).toBe(n);
      }
    }
  });
});

describe("#6 questions decide only from structured options (PoC misc)", () => {
  it("free text decides nothing; > 3 groups need confirmCount; > 20 groups are refused; answers stay out of the learning loop", async () => {
    await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    const real = tri.groups.filter((g) => !g.acc && !g.inherited && g.validity === "real").map((g) => g.id);
    await expect(coord.askCoordinator({ testKey: k42, groupIds: real.slice(0, 21), question: "¿Son reales estas interferencias?", kind: "validity" })).rejects.toThrow();
    await expect(coord.askCoordinator({ testKey: k42, groupIds: real.slice(0, 2), question: "¿Es real?", options: [{ label: "Sí", action: "close" }], kind: "validity" })).rejects.toThrow(/validez/);
    const q = await coord.askCoordinator({ testKey: k42, groupIds: real.slice(0, 5), question: "¿El ducto del eje 4 en N3 es real?", options: [{ label: "Es real", validity: "real" }, { label: "Falso positivo", validity: "false_positive" }], kind: "validity" });
    // the free text that fooled the old text parser now only becomes the stored answer
    const qText = await coord.askCoordinator({ testKey: k42, groupIds: real.slice(5, 6), question: "¿Es real esta otra?", options: [{ label: "Es real", validity: "real" }], kind: "validity" });
    const a0 = await ui.answerQuestion(qText.questionId, { answer: "No, no es falso positivo: es real" }, HUMAN);
    expect(a0.decisionIds).toBeUndefined();
    await expect(ui.answerQuestion(q.questionId, { optionIndex: 1, reasonCode: "R01" }, HUMAN)).rejects.toThrow(/confirmCount=5/);
    const fb0 = (await coord.listFeedback({ aggregate: "none", limit: 100 } as never)) as { total?: number };
    const a = await ui.answerQuestion(q.questionId, { optionIndex: 1, reasonCode: "R01", confirmCount: 5 }, HUMAN);
    expect(a.decisionIds).toHaveLength(5);
    const recs = (await coord.store.listDecisions()).filter((d) => a.decisionIds!.includes(d.id));
    expect(recs.every((d) => d.source === "question")).toBe(true);
    const fb1 = (await coord.listFeedback({ aggregate: "none", limit: 100 } as never)) as { total?: number };
    expect(fb1.total ?? 0).toBe(fb0.total ?? 0);
  });
});

describe("#7 dueDateQuote must contain the date", () => {
  it("parses common Spanish date forms and refuses quotes without the date", async () => {
    expect(datesInQuote("se acordó para el 20-11-2026")).toContainEqual({ y: 2026, m: 11, d: 20 });
    expect(datesInQuote("antes del 15 de enero de 2027")).toContainEqual({ y: 2027, m: 1, d: 15 });
    expect(quoteContainsDate("entrega el 5/12", "2026-12-05")).toBe(true);
    expect(quoteContainsDate("fecha 2027-01-15 confirmada", "2027-01-15")).toBe(true);
    expect(quoteContainsDate("Camila revisa el detalle", "2027-01-15")).toBe(false);
    await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const fam = (await ui.families(k42)).families.find((f) => f.proposed.validity === "real")!;
    await coord.putMeetingNote(k42, "family", fam.id, "Camila revisa el detalle con el calculista.", HUMAN);
    const base = { testKey: k42, familyId: fam.id, validity: "real" as const, action: "create_issue" as const, rationale: "Según reunión." };
    await expect(coord.proposeFamilyDecision({ ...base, dueDate: "2027-01-15", dueDateQuote: "Camila" })).rejects.toThrow(/10 caracteres/);
    await expect(coord.proposeFamilyDecision({ ...base, dueDate: "2027-01-15", dueDateQuote: "Camila revisa el detalle" })).rejects.toThrow(/no contiene la fecha/);
  });
});

describe("#8 inheritance trusts only existing decisions", () => {
  it("a forged human ref in the ledger is not inherited", async () => {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const g42 = (await ui.triage(P, MODEL_SET_ID, k42)).groups.find((g) => !g.acc && !g.inherited && g.change === "unchanged")!;
    const { cls } = await coord.requireClassified(k42);
    await coord.ledger.withLedger(`b.${P}`, MODEL_SET_ID, (l) => {
      for (const id of g42.clashIds.map((c) => c.replace(/^C-/, ""))) {
        const c = cls.clashes.find((x) => x.id === id)!;
        l.entries[id]!.decision = { source: "human", ref: "d-forged", decision: "accept", effect: "none", decidedAtVersion: 41, testKey: k41, decidedAt: new Date().toISOString(), penetrationMm: c.penetrationMm, elementTypes: [c.a.type ?? c.a.category, c.b.type ?? c.b.category].sort().join("|") };
      }
      return l;
    });
    expect((await ui.triage(P, MODEL_SET_ID, k42)).groups.find((g) => g.id === g42.id)!.inherited).toBeUndefined();
  });
});

describe("#9 #10 #11 #13 #14 (low)", () => {
  it("path segments refuse '..'", () => {
    expect(() => pathSegment("..")).toThrow();
    expect(() => pathSegment("../x")).toThrow();
    expect(pathSegment("b.demo-proyecto")).toBe("b.demo-proyecto");
  });

  it("≥ 80 % of a small document's clashes gone at once is a scope change", () => {
    const docs = [doc(0, "A.rvt"), doc(1, "B.rvt")].map((d) => ({ ...d, lineageUrn: `lin-${d.id}` }));
    const mk = (id: string) => ({ id, left: { documentId: 0, objectId: 1, viewerDbId: 1 }, right: { documentId: 1, objectId: 2, viewerDbId: 2 } });
    const prev = ["1", "2", "3", "4", "5"].map(mk) as never[];
    const s = detectScopeChanges({ viewName: "V", documents: docs as never, clashes: prev }, { viewName: "V", documents: docs as never }, { resolved: ["1", "2", "3", "4"], element_deleted: [] });
    expect(s.changes.map((c) => c.kind)).toContain("mass_resolution");
  });

  it("closedInAccWhileReal is surfaced when ACC closed a real group", async () => {
    await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const g = (await ui.triage(P, MODEL_SET_ID, k42)).groups.find((x) => !x.acc && x.validity === "real")!;
    await coord.ledger.withLedger(`b.${P}`, MODEL_SET_ID, (l) => {
      for (const id of g.clashIds.map((c) => c.replace(/^C-/, ""))) l.entries[id]!.accByVersion = { ...(l.entries[id]!.accByVersion ?? {}), "42": { status: "closed", groupId: "cg-x", reason: "VALID_INTERFACE", version: 42 } };
      return l;
    });
    const after = (await ui.triage(P, MODEL_SET_ID, k42)).groups.find((x) => x.id === g.id)!;
    expect(after.closedInAccWhileReal).toBe(true);
    expect(after.acc?.status).toBe("closed");
  });

  it("notes store the author id only; the agent copy masks emails and phones; aliases resolve", async () => {
    const k42 = await ingest(coord, 42);
    const fams = (await ui.families(k42)).families.filter((f) => f.state === "sin_decidir" && f.instanceCount >= 2);
    const [a, b] = fams.slice(-2);
    await ui.mergeFamilies({ testId: k42, from: a!.id, into: b!.id }, HUMAN);
    await coord.putMeetingNote(k42, "family", a!.id, "Llamar a juan.perez@empresa.cl o al +56 9 1234 5678 antes del 20-11-2026.", HUMAN);
    const raw = JSON.stringify(await coord.meeting.load(`b.${P}`, MODEL_SET_ID));
    expect(raw).not.toContain(HUMAN.name);
    const rows = (await coord.listMeetingNotes({ testKey: k42, familyId: b!.id, limit: 10 })).rows;
    expect(rows).toHaveLength(1);
    const text = (rows[0]![3] as { untrusted: string }).untrusted;
    expect(text).toContain("[correo]");
    expect(text).toContain("[teléfono]");
    expect(text).not.toMatch(/@empresa/);
    expect(redactContacts("sin datos")).toBe("sin datos");
    // the date quote follows the alias too
    const ok = await coord.proposeFamilyDecision({ testKey: k42, familyId: b!.id, validity: b!.proposed.validity === "real" ? "real" : b!.proposed.validity, action: b!.proposed.validity === "real" ? "create_issue" : "escalate", dueDate: "2026-11-20", dueDateQuote: "antes del 20-11-2026", rationale: "Acuerdo." });
    expect(ok.proposalId).toBeTruthy();
  });
});
