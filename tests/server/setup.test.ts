import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../server/cli";
import { installStatus, runSetup, setupCheck, unifiedDiff } from "../../server/setup";
import { ROOT, tempHome } from "./helpers";

let root: string;
let cleanup: () => void;
const saved = { ...process.env };
const DEV_MARKER = ["harness", "dev"].join("-");
const ENV_FILE = [".env", "local"].join(".");

beforeEach(() => {
  ({ home: root, cleanup } = tempHome());
  mkdirSync(join(root, "server", "templates"), { recursive: true });
  for (const f of ["mcp.json", "coordinator.config.json"]) writeFileSync(join(root, "server", "templates", f), readFileSync(join(ROOT, "server", "templates", f)));
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
  cleanup();
});

function io(answers: string[] = []) {
  const lines: string[] = [];
  return { lines, io: { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s), ask: async () => answers.shift() ?? "" } };
}

describe("setup", () => {
  it("is refused under Claude Code (CLAUDECODE exists, even empty) and without a TTY", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.CLAUDECODE = "";
    expect(await main(["setup"])).toBe(2);
    delete process.env.CLAUDECODE;
    expect(await main(["setup"])).toBe(2); // vitest's stdin is not a TTY
    errSpy.mockRestore();
  });

  it("--check is read-only, allowed under Claude Code, and writes nothing", async () => {
    process.env.CLAUDECODE = "1";
    const before = existsSync(join(ROOT, ".mcp.json"));
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => ((out += String(s)), true));
    const code = await main(["setup", "--check"]);
    vi.restoreAllMocks();
    expect([0, 1]).toContain(code);
    expect(out).toContain("Estado de instalación");
    expect(existsSync(join(ROOT, ".mcp.json"))).toBe(before);
  });

  it("--check fails when the harness dev marker exists, passes on a complete install", () => {
    writeFileSync(join(root, ".mcp.json"), readFileSync(join(root, "server", "templates", "mcp.json")));
    writeFileSync(join(root, "coordinator.config.json"), readFileSync(join(root, "server", "templates", "coordinator.config.json")));
    writeFileSync(join(root, ENV_FILE), "VITE_APS_CLIENT_ID=a\nAPS_CLIENT_SECRET=b\nVITE_APS_CALLBACK_URL=http://localhost:3000/auth/callback\n");
    const home = join(root, ".coordinator");
    const a = io();
    expect(setupCheck(root, a.io, home)).toBe(0);
    expect(a.lines.join("\n")).not.toMatch(/=a|=b/); // never prints values
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, DEV_MARKER), "");
    const b = io();
    expect(setupCheck(root, b.io, home)).toBe(1);
    expect(installStatus(root, home).harnessDev).toBe(true);
  });

  it("installs templates, asks before replacing, installs harness-staging only after INSTALAR and audits hashes", async () => {
    writeFileSync(join(root, "coordinator.config.json"), '{"language":"en"}\n');
    mkdirSync(join(root, "harness-staging", "hooks"), { recursive: true });
    writeFileSync(join(root, "harness-staging", "hooks", "guard.mjs"), "export default 1;\n");
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "hooks.test.ts"), "");
    const audits: Array<Record<string, unknown>> = [];
    const first = io(["n", "nope"]);
    await runSetup({ root, io: first.io, audit: async (d) => void audits.push(d), runHookTests: () => 0 });
    expect(existsSync(join(root, ".mcp.json"))).toBe(true);
    expect(readFileSync(join(root, "coordinator.config.json"), "utf8")).toContain('"en"'); // kept (answered n)
    expect(first.lines.join("\n")).toContain("+++ server/templates/coordinator.config.json");
    expect(existsSync(join(root, ".claude", "hooks", "guard.mjs"))).toBe(false); // not INSTALAR
    expect(audits).toHaveLength(0);

    const second = io(["s", "INSTALAR"]);
    const code = await runSetup({ root, io: second.io, audit: async (d) => void audits.push(d), runHookTests: () => 0 });
    expect(readFileSync(join(root, ".claude", "hooks", "guard.mjs"), "utf8")).toBe("export default 1;\n");
    expect(readFileSync(join(root, "coordinator.config.json"), "utf8")).toBe(readFileSync(join(root, "server", "templates", "coordinator.config.json"), "utf8"));
    expect(audits).toHaveLength(1);
    expect(String(audits[0]!.hashes)).toContain("hooks/guard.mjs");
    expect(code).toBe(1); // no env file yet → manual steps pending
    expect(second.lines.join("\n")).toContain("passkey-enroll");
  });

  it("unifiedDiff marks additions and removals", () => {
    const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "x", "y");
    expect(d).toContain("-b");
    expect(d).toContain("+B");
  });
});
