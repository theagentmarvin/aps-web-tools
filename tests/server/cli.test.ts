import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveBatch } from "../../server/approval";
import { approvalChannelBlocked, main } from "../../server/cli";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { acceptGroups, HUMAN, ingest, makeCoord, MODEL_SET_ID, tempHome } from "./helpers";

let home: string;
let cleanup: () => void;
const saved = { ...process.env };

beforeEach(() => {
  ({ home, cleanup } = tempHome());
  process.env.COORDINATOR_HOME = home;
  process.env.COORD_DATA_SOURCE = "fixtures";
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
  cleanup();
});

async function run(args: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => ((out += String(s)), true));
  const code = await main(args);
  vi.restoreAllMocks();
  return { code, out };
}

describe("CLI", () => {
  it("approve is refused under Claude Code or without a TTY", () => {
    expect(approvalChannelBlocked({ CLAUDECODE: "1" }, true)).toMatch(/Claude Code/);
    expect(approvalChannelBlocked({}, false)).toMatch(/TTY/);
    expect(approvalChannelBlocked({}, true)).toBeUndefined();
  });

  it("`approve` exits non-zero when CLAUDECODE is set and creates nothing", async () => {
    process.env.CLAUDECODE = "1";
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await main(["approve", "L-2026-11-06-01"]);
    errSpy.mockRestore();
    expect(code).toBe(2);
  });

  it("verify-approval --json: ok only for a valid approval, read-only otherwise", async () => {
    const coord = makeCoord(home);
    const ui = new CoordinatorUi(coord);
    const key = await ingest(coord, 42);
    const views = (await ui.proposals(key, undefined, 1000)).items.filter((v) => v.fields.action.value.setStatus === "closed").slice(0, 2);
    await acceptGroups(ui, key, views.map((v) => v.targetId));
    const b = await ui.sendToApproval({ projectId: "demo-proyecto", modelSetId: MODEL_SET_ID, testId: key }, HUMAN);

    const before = await run(["verify-approval", b.id, "--json"]);
    expect(before.code).toBe(1);
    expect(JSON.parse(before.out)).toMatchObject({ valid: false, reason: "not_approved" });
    expect(await coord.store.getApproval(b.id)).toBeUndefined();

    await approveBatch({ store: coord.store, source: coord.source, config: coord.config, effectiveLevel: 1 }, b.id, { ...HUMAN, channel: "cli" });
    const after = await run(["verify-approval", b.id, "--json"]);
    expect(after.code).toBe(0);
    expect(JSON.parse(after.out)).toMatchObject({ valid: true, batchId: b.id, approvedBy: HUMAN.name, proposalCount: expect.any(Number) });
    expect(JSON.parse(after.out).expiresAt).toMatch(/^\d{4}-/);

    const missing = await run(["verify-approval", "L-2000-01-01-01", "--json"]);
    expect(missing.code).toBe(1);
  });
});
