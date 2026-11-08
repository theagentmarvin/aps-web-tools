import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../server/cli";
import { Coordinator } from "../../server/coordinator";
import { apsTokenPath, coordinatorAuthConfig } from "../../server/secure/aps-paths";
import { LiveSource } from "../../server/source/live";
import { ROOT, tempHome } from "./helpers";

let home: string;
let cleanup: () => void;
const saved = { ...process.env };
beforeEach(() => {
  ({ home, cleanup } = tempHome());
  process.env.COORDINATOR_HOME = home;
  process.env.VITE_APS_CLIENT_ID = "test-client-id";
  delete process.env.COORD_DATA_SOURCE;
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
  cleanup();
});

describe("APS token location", () => {
  it("CLI login and the MCP/API coordinator use the same token file", () => {
    const cliPath = coordinatorAuthConfig(ROOT).tokenPath; // what `coordinator login` uses
    const coord = new Coordinator({ root: ROOT });
    expect(coord.source).toBeInstanceOf(LiveSource);
    const mcpPath = (coord.source as LiveSource).auth!.config.tokenPath;
    expect(mcpPath).toBe(cliPath);
    expect(cliPath).toBe(apsTokenPath());
    expect(cliPath.startsWith(join(home, "secret"))).toBe(true);
  });

  it("no server file resolves the APS auth config except through server/secure/aps-paths.ts", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(ROOT, "server"));
    walk(join(ROOT, "src", "lib", "server"));
    const offenders = files
      .map((f) => relative(ROOT, f).split(sep).join("/"))
      .filter((f) => !["server/aps/auth.ts", "server/secure/aps-paths.ts"].includes(f))
      .filter((f) => /resolveAuthConfig\(|browser-session\.json|aps-token\.json/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("`status --json` reports login state without printing tokens or paths", async () => {
    const p = apsTokenPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ accessToken: "SECRET-ACCESS", refreshToken: "SECRET-REFRESH", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() }));
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => ((out += String(s)), true));
    expect(await main(["status", "--json"])).toBe(0);
    vi.restoreAllMocks();
    const j = JSON.parse(out);
    expect(j).toMatchObject({ loggedIn: true, dataSource: "live" });
    expect(out).not.toMatch(/SECRET|aps-token|secret[\\/]/);
  });
});
