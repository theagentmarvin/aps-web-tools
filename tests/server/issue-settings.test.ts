/**
 * G4 (family issue content + issue type), G5 (discipline → ACC assignee, human override, agent
 * parity by proposal) and G11 (ACC deep link). Fixtures only; nothing is written to ACC.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accIssueUrl } from "../../core/issues";
import { solutionText } from "../../core/families";
import { assigneesFromUsers } from "../../server/aps/admin";
import { familyIssueContent } from "../../server/families";
import { pickDefaultIssueType } from "../../server/issue-settings";
import type { Coordinator } from "../../server/coordinator";
import type { AssignedGroupCreate } from "../../server/aps/types";
import { acceptGroups, CoordinatorUi, HUMAN, ingest, makeCoord, makeLiveLike, MODEL_SET_ID, tempHome } from "./helpers";

const P = "demo-proyecto";
const TYPE = "11111111-2222-4333-8444-555555555555";
const SUB = "11111111-2222-4333-8444-666666666666";

describe("G11 · ACC deep link", () => {
  it("builds the Build issue URL without the b. prefix; undefined for non-ACC ids", () => {
    const pid = "b.0f5e1d2c-3b4a-4958-8776-655443322110";
    const iid = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    expect(accIssueUrl(pid, iid)).toBe(`https://acc.autodesk.com/build/issues/projects/0f5e1d2c-3b4a-4958-8776-655443322110/issues?issueId=${iid}&preview=true`);
    expect(accIssueUrl(pid.slice(2), iid)).toBe(accIssueUrl(pid, iid));
    expect(accIssueUrl("b.demo-proyecto", iid)).toBeUndefined();
    expect(accIssueUrl(pid, "103")).toBeUndefined();
    expect(accIssueUrl(pid, `${iid}"><script>`)).toBeUndefined();
  });
});

describe("G4 · family issue content", () => {
  const view = { id: "F-ada6a7374a", title: 'CAL-hidrónica Ø22–54 invaden el fondo de vigas 12" x 18" · bajar ≤100 mm', pair: ["CLI", "EST"] as [string, string], evidence: { penetrationMm: { min: 35, max: 86 }, sizeHistogram: [] } };
  const inst = (level: string, n: number) => ({ levels: [level], uniqueClashCount: n, rawClashCount: n });
  const dec = { validity: "real" as const, action: "create_issue" as const, responsibleDiscipline: "CLI", secondaryDiscipline: "EST", solutionOption: "Bajar penetración + 25 mm verificando altura de cielo", issueMode: "family" as const };

  it("uses the ubicación template, current wording, no internal id in the title", () => {
    const c = familyIssueContent(view, dec, [inst("Nivel 101", 8), inst("Nivel 201", 12), inst("Nivel 301", 8)], { band: 2, dueDate: "2026-11-17", ruleIds: ["EST-005"], modelSetVersion: 42, clashCount: 28 });
    // 104 characters with the levels: the level part is dropped first (issue guide drop order).
    expect(c.title).toBe('[P2][CLI×EST] CAL-hidrónica Ø22–54 invaden el fondo de vigas 12" x 18" · bajar ≤100 mm');
    expect(c.title).not.toContain("F-");
    expect(familyIssueContent({ ...view, title: "Ductos CLI-retorno bajo vigas" }, dec, [inst("Nivel 101", 1), inst("Nivel 301", 1)], { band: 2, dueDate: "2026-11-17", ruleIds: [], clashCount: 2 }).title).toBe("[P2][CLI×EST] Niveles 101-301 · Ductos CLI-retorno bajo vigas");
    expect(c.location).toBe("Niveles 101-301");
    const d = c.description;
    expect(d.split("\n").map((l) => l.split(":")[0])).toEqual(["PROBLEMA", "UBICACIÓN", "POR QUÉ", "ACCIÓN (CLI)", "CONSULTAR", "PLAZO", "REF"]);
    expect(d).toContain("3 ubicaciones y 28 interferencias; penetración máx. 86 mm.");
    expect(d).toContain("Nivel 101: 1 ubic. (8 interf.) · Nivel 201: 1 ubic. (12 interf.)");
    expect(d).toContain("1. Bajar el ducto ~111 mm (verificar altura de cielo) en todas las ubicaciones.");
    expect(d).not.toMatch(/penetración \+ 25 mm/);
    expect(d).toContain("sujeta a aprobación del calculista");
    expect(d).toContain("CONSULTAR: EST (calculista).");
    expect(d).toContain("PLAZO: 17-11-2026.");
    expect(d).toContain("REF: Grupo F-ada6a7374a · 28 interferencias vinculadas · EST-005 · conjunto v42");
  });

  it("stays within ACC limits (title ≤ 100 with chunk suffix, description ≤ 1000) with many levels", () => {
    const long = { ...view, title: "Tuberías gravitacionales ALC-servidas Ø41–105 cruzan sin pasada losas 3\" LW Concrete on 2\" Metal Deck · pasada en losa" };
    const many = Array.from({ length: 60 }, (_, i) => inst(`Nivel ${i + 1}`, 3));
    const c = familyIssueContent(long, { ...dec, typicalDetail: { name: "Pasada tipo losa", note: "camisa Ø+50, sello cortafuego" } }, many, { band: 1, dueDate: "2026-11-17", ruleIds: ["EST-009", "EST-002"], clashCount: 1000, suffix: " (1/2)", followUp: true });
    expect(c.title.length).toBeLessThanOrEqual(100);
    expect(c.title.endsWith(" (1/2)")).toBe(true);
    expect(c.description.length).toBeLessThanOrEqual(1000);
    expect(c.description).toMatch(/y \d+ niveles más/);
    expect(c.description).toContain("PLAZO: ");
  });

  it("never states a structural opening is approved", () => {
    expect(solutionText("Pasada aprobada por el calculista y modelada por EST")).not.toMatch(/aprobada por/);
    expect(solutionText("Desviar bajo la viga")).toBe("Desviar bajo la viga");
  });
});

describe("G4/G5 · helpers", () => {
  it("picks Coordinación / Clash only when unambiguous", () => {
    const types = [
      { id: "t1", title: "Calidad", subtypes: [{ id: "s0", title: "Observación" }] },
      { id: "t2", title: "Coordinación", subtypes: [{ id: "s1", title: "Clash" }, { id: "s2", title: "Diseño" }] },
    ];
    expect(pickDefaultIssueType(types)).toEqual({ typeId: "t2", subtypeId: "s1", label: "Coordinación / Clash" });
    expect(pickDefaultIssueType([...types, { id: "t3", title: "Coordination", subtypes: [{ id: "s3", title: "Interferencia" }] }])).toBeUndefined();
    expect(pickDefaultIssueType([types[0]!])).toBeUndefined();
  });

  it("derives companies, roles and active users from ACC project members", () => {
    const a = assigneesFromUsers([
      { id: "1", autodeskId: "AUTH1", name: "Persona Uno", companyId: "co-1", companyName: "Clima SpA", roles: [{ id: "r-1", name: "Especialista Clima" }] },
      { id: "2", autodeskId: "AUTH2", name: "Persona Dos", companyId: "co-1", companyName: "Clima SpA", roles: [], status: "pending" },
    ]);
    expect(a.map((x) => `${x.kind}:${x.id}`)).toEqual(["company:co-1", "role:r-1", "user:AUTH1"]);
  });
});

describe("G4/G5 · batches carry the issue type and the mapped ACC assignee (fixtures)", () => {
  let cleanup: () => void;
  let coord: Coordinator;
  let ui: CoordinatorUi;
  let k42: string;
  beforeAll(async () => {
    let home: string;
    ({ home, cleanup } = tempHome());
    coord = makeCoord(home);
    ui = new CoordinatorUi(coord);
    k42 = await ingest(coord, 42);
  });
  afterAll(() => cleanup());

  it("project page settings: issue types (GET) and the effective default", async () => {
    const types = await ui.issueTypes(P);
    expect(types[0]).toMatchObject({ title: "Coordinación", subtypes: expect.arrayContaining([expect.objectContaining({ title: "Clash" })]) });
    const s = await ui.issueSettings(P);
    expect(s.issueType).toBeNull();
    expect(s.effectiveIssueType).toMatchObject({ label: "Coordinación / Clash" });
    expect(s.codes.map((c) => c.code)).toContain("CLI");
  });

  it("the mapping reaches the dry-run body as assignedTo/assignedToType; no name in the issue text; override per issue", async () => {
    const page = await ui.proposals(k42, undefined, 1000);
    const real = page.items.filter((p) => p.fields.action.value.createIssue && p.issueDraft);
    expect(real.length).toBeGreaterThan(0);
    const disc = real[0]!.fields.owner.value;
    await ui.setIssueAssignee(P, disc, { id: "co-demo-mep", type: "company", label: "Instalaciones Demo Ltda." }, HUMAN);
    await acceptGroups(ui, k42, [real[0]!.targetId]);
    const b = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: k42 }, HUMAN);
    const item = b.items.find((i) => i.groupId === real[0]!.targetId && i.mcOperation === "clash.assign")!;
    const body = item.accNew as AssignedGroupCreate;
    expect(body).toMatchObject({ assignedTo: "co-demo-mep", assignedToType: "Company" });
    expect(body.description).not.toContain("Instalaciones Demo");
    expect(body.title).not.toContain("Instalaciones Demo");
    expect(item.issue).toMatchObject({ assigneeId: "co-demo-mep", assigneeType: "company", assigneeLabel: "Instalaciones Demo Ltda.", issueTypeLabel: "Coordinación / Clash" });
    expect(item.issue!.linkClashIds).toHaveLength(body.clashes.length);
    // override at approval: a role instead of the company, then no assignee at all
    let after = await ui.updateIssue(b.id, item.id, { assigneeId: "role-cli", assigneeType: "role", assigneeLabel: "Especialista Clima" });
    expect(after.items.find((i) => i.id === item.id)!.accNew).toMatchObject({ assignedTo: "role-cli", assignedToType: "Role" });
    after = await ui.updateIssue(b.id, item.id, { assigneeId: "" });
    const cleared = after.items.find((i) => i.id === item.id)!;
    expect((cleared.accNew as AssignedGroupCreate).assignedTo).toBeUndefined();
    expect(cleared.issue!.assigneeId).toBeUndefined();
    await ui.updateIssue(b.id, item.id, { assigneeId: "co-demo-mep", assigneeType: "company" });
    // the dry run sends the assignee as ACC metadata
    await ui.approve(b.id, { confirmWord: "APLICAR", excludedItemIds: [], demo: true }, HUMAN);
    const dry = await ui.apply(b.id, {}, { type: "user", id: HUMAN.id, name: HUMAN.name });
    expect(JSON.stringify(dry.requests.map((r) => r.body))).toContain('"assignedTo":"co-demo-mep"');
  });

  it("agent parity: get_issue_settings masks user names; propose_issue_responsible only proposes; a human accepts it", async () => {
    await coord.setActiveContext({ projectId: P, modelSetId: MODEL_SET_ID });
    await ui.setIssueAssignee(P, "EST", { id: "AUTHUSER01", type: "user", label: "Nombre Apellido" }, HUMAN);
    const read = await coord.getIssueSettings({});
    expect(JSON.stringify(read)).not.toContain("Nombre Apellido");
    expect(read.assignees.find((a) => a.discipline === "EST")).toMatchObject({ id: "AUTHUSER01", type: "user", label: "usuario ACC" });
    expect(read.candidates.length).toBeGreaterThan(0);

    const p = await coord.proposeIssueResponsible({ discipline: "ELE", assignee: { id: "role-ele", type: "role" }, rationale: "ELE responde como rol en ACC." });
    expect(p.kind).toBe("issue_settings");
    let s = await ui.issueSettings(P);
    expect(s.assignees.some((a) => a.discipline === "ELE")).toBe(false);
    expect(s.pendingProposals.map((x) => x.id)).toContain(p.proposalId);
    await expect(coord.proposeIssueResponsible({ discipline: "ELE", assignee: { id: "nope", type: "role" }, rationale: "x" })).rejects.toThrow(/no es un responsable/);

    s = await ui.decideIssueSettingsProposal(P, p.proposalId, "accept", HUMAN);
    expect(s.assignees.find((a) => a.discipline === "ELE")).toMatchObject({ id: "role-ele", type: "role", label: "Especialista Eléctrico" });
    expect(s.pendingProposals).toHaveLength(0);
    const audit = await ui.audit({ action: "issue_settings.assignee_set", limit: 10 });
    expect(audit.items.length).toBeGreaterThan(0);
  });
});

describe("G4 · unknown ACC issue type is chosen at approval", () => {
  it("excluded with a conflict until a human picks the type on the issue", async () => {
    const t = tempHome();
    try {
      const coord = makeLiveLike(t.home);
      Object.defineProperty(coord.source, "listIssueTypes", { value: async () => [] });
      const ui = new CoordinatorUi(coord);
      const key = await ingest(coord, 42);
      const page = await ui.proposals(key, undefined, 1000);
      const real = page.items.find((p) => p.fields.action.value.createIssue && p.issueDraft)!;
      await acceptGroups(ui, key, [real.targetId]);
      const b = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: key }, HUMAN);
      const item = b.items.find((i) => i.groupId === real.targetId && i.mcOperation === "clash.assign")!;
      expect(item.excluded).toBe(true);
      expect(item.conflict?.reason).toMatch(/^Falta el tipo/);
      const after = await ui.updateIssue(b.id, item.id, { issueType: TYPE, issueSubtype: SUB, issueTypeLabel: "Coordinación / Clash" });
      const fixed = after.items.find((i) => i.id === item.id)!;
      expect(fixed.conflict).toBeUndefined();
      expect(fixed.excluded).toBe(false);
      expect(fixed.accNew).toMatchObject({ issueTypeId: TYPE, issueSubTypeId: SUB });
      expect(fixed.issue!.issueTypeLabel).toBe("Coordinación / Clash");
    } finally {
      t.cleanup();
    }
  });
});
