/**
 * Agent harness update from the web UI (server/harness-install.ts, shared core in server/setup.ts):
 * status / diff, the install core shared with `npm run setup`, the passkey-bound install, the
 * HTTP route guards, and that NO MCP tool or chat tool can reach it.
 * Every `.claude` write goes to a temp repo root — never the worktree's or the main repo's.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoordApi } from "../../server/api/router";
import { chatAllowedTools } from "../../server/chat/bridge";
import { parseAgentFile } from "../../server/chat/agent";
import type { Coordinator } from "../../server/coordinator";
import { HarnessInstaller } from "../../server/harness-install";
import { TOOLS } from "../../server/mcp/contracts";
import { createCoordServer } from "../../server/mcp/server";
import { harnessDiff, harnessPayloadHash, harnessPlan, installHarnessFiles, runSetup } from "../../server/setup";
import { SoftAuthenticator } from "./authenticator";
import { enrollPasskey, HUMAN, makeCoord, makeLiveLike, ROOT, tempHome } from "./helpers";

let root: string;
let home: string;
const cleanups: Array<() => void> = [];

function write(rel: string, content: string) {
  const p = join(root, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}
const read = (rel: string) => readFileSync(join(root, ...rel.split("/")), "utf8");

beforeEach(() => {
  const r = tempHome();
  const h = tempHome();
  root = r.home;
  home = h.home;
  cleanups.push(r.cleanup, h.cleanup);
  write(".claude/agents/chat.md", "v1\nsame\n");
  write(".claude/hooks/keep.mjs", "keep\n");
  write("harness-staging/.claude/agents/chat.md", "v2\nsame\n");
  write("harness-staging/.claude/hooks/keep.mjs", "keep\n");
  write("harness-staging/.claude/skills/nuevo/SKILL.md", "# nuevo\n");
  write("harness-staging/server/evil.ts", "export {};\n");
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function installer(coord: Coordinator, opts: { env?: NodeJS.ProcessEnv; tests?: number } = {}) {
  const h = new HarnessInstaller(coord, { root, env: opts.env ?? {}, runStagedHookTests: async () => opts.tests ?? 0 });
  coord.harnessInstaller = h;
  return h;
}

async function passkeyInstall(h: HarnessInstaller, auth: SoftAuthenticator, mutateBetween?: () => void) {
  const o = await h.options();
  mutateBetween?.();
  const response = auth.assert(o.options as { challenge: string });
  return h.install({ webauthn: { nonce: o.nonce, origin: auth.origin, response } }, HUMAN);
}

describe("harness status / diff (read-only)", () => {
  it("reports added / changed / same, refuses files outside .claude and CLAUDE.md, versions differ until installed", () => {
    const coord = makeCoord(home);
    const s = installer(coord).status();
    expect(s.upToDate).toBe(false);
    expect(s.staging).toBe(true);
    expect(s.files).toEqual([
      { path: ".claude/agents/chat.md", state: "changed" },
      { path: ".claude/hooks/keep.mjs", state: "same" },
      { path: ".claude/skills/nuevo/SKILL.md", state: "added" },
    ]);
    expect(s.refused).toEqual(["server/evil.ts"]);
    expect(s.stagedVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(s.stagedVersion).not.toBe(s.installedVersion);
    expect(s.installBlocked).toBe(false);
  });

  it("diff only for staged paths, unified format, size-capped", () => {
    const d = harnessDiff(root, ".claude/agents/chat.md");
    expect(d.diff).toContain("-v1");
    expect(d.diff).toContain("+v2");
    expect(d.truncated).toBe(false);
    expect(harnessDiff(root, ".claude/agents/chat.md", 10).truncated).toBe(true);
    const h = installer(makeCoord(home));
    expect(() => h.diff("server/evil.ts")).toThrow(/no existe o no es instalable/);
    expect(() => h.diff(".claude/../coordinator.config.json")).toThrow();
  });

  it("no staging → up to date, nothing to install", async () => {
    const coord = makeCoord(home);
    const h = new HarnessInstaller(coord, { root: home, env: {} });
    expect(h.status()).toMatchObject({ upToDate: true, staging: false, files: [] });
    await expect(h.options()).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("install core shared with npm run setup", () => {
  it("writes only the changes, backs up replaced files, verifies hashes; refuses a staging changed after review", () => {
    const plan = harnessPlan(root)!;
    write("harness-staging/.claude/agents/chat.md", "v3\n");
    expect(() => installHarnessFiles(root, plan, { backupDir: join(home, "b1") })).toThrow(/cambió desde la revisión/);
    expect(read(".claude/agents/chat.md")).toBe("v1\nsame\n");
    const fresh = harnessPlan(root)!;
    const r = installHarnessFiles(root, fresh, { backupDir: join(home, "b2") });
    expect(r.installed.sort()).toEqual([".claude/agents/chat.md", ".claude/skills/nuevo/SKILL.md"]);
    expect(r.backedUp).toEqual([".claude/agents/chat.md"]);
    expect(readFileSync(join(home, "b2", ".claude", "agents", "chat.md"), "utf8")).toBe("v1\nsame\n");
    expect(read(".claude/agents/chat.md")).toBe("v3\n");
    expect(existsSync(join(root, "server", "evil.ts"))).toBe(false);
    expect(harnessPlan(root)!.files.every((f) => f.state === "same")).toBe(true);
  });

  it("the CLI setup uses the same core (INSTALAR) and backs up into the given folder", async () => {
    mkdirSync(join(root, "server", "templates"), { recursive: true });
    for (const f of ["mcp.json", "coordinator.config.json"]) writeFileSync(join(root, "server", "templates", f), readFileSync(join(ROOT, "server", "templates", f)));
    const audits: Array<Record<string, unknown>> = [];
    const answers = ["INSTALAR"];
    await runSetup({ root, io: { out: () => {}, err: () => {}, ask: async () => answers.shift() ?? "" }, audit: async (d) => void audits.push(d), runHookTests: () => 0, backupDir: join(home, "backups", "cli") });
    expect(read(".claude/agents/chat.md")).toBe("v2\nsame\n");
    expect(readFileSync(join(home, "backups", "cli", ".claude", "agents", "chat.md"), "utf8")).toBe("v1\nsame\n");
    expect(audits[0]).toMatchObject({ files: 2, channel: "cli", backup: "cli" });
  });
});

describe("POST install: passkey bound to the exact files", () => {
  it("installs with a fresh user-verified passkey, backs up into the data home and audits", async () => {
    const coord = makeLiveLike(home);
    const auth = new SoftAuthenticator();
    await enrollPasskey(coord, auth);
    const h = installer(coord);
    const r = await passkeyInstall(h, auth);
    expect(r.installed.sort()).toEqual([".claude/agents/chat.md", ".claude/skills/nuevo/SKILL.md"]);
    expect(r.backup).toMatch(/^harness-\d{8}T\d{6}$/);
    expect(read(".claude/agents/chat.md")).toBe("v2\nsame\n");
    expect(readFileSync(coord.store.path("backups", r.backup!, ".claude", "agents", "chat.md"), "utf8")).toBe("v1\nsame\n");
    expect(h.status().upToDate).toBe(true);
    const audit = await coord.store.listAudit();
    expect(audit.find((e) => e.action === "harness.installed")).toMatchObject({ actor: { type: "user", name: HUMAN.name }, details: { channel: "web-ui", proof: "webauthn", files: 2 } });
  });

  it("refuses without a passkey, with an unregistered or presence-only passkey, and when the files changed after the challenge", async () => {
    const coord = makeLiveLike(home);
    const auth = new SoftAuthenticator();
    await enrollPasskey(coord, auth);
    const h = installer(coord);
    await expect(h.install({}, HUMAN)).rejects.toMatchObject({ code: "approval_missing" });
    // Unregistered authenticator.
    const o1 = await h.options();
    await expect(h.install({ webauthn: { nonce: o1.nonce, origin: auth.origin, response: new SoftAuthenticator().assert(o1.options as { challenge: string }) } }, HUMAN)).rejects.toMatchObject({ code: "approval_invalid" });
    // No user verification (presence-only tap).
    const o2 = await h.options();
    await expect(h.install({ webauthn: { nonce: o2.nonce, origin: auth.origin, response: auth.assert(o2.options as { challenge: string }, { userVerified: false }) } }, HUMAN)).rejects.toMatchObject({ code: "approval_invalid" });
    // A forged nonce.
    const o3 = await h.options();
    await expect(h.install({ webauthn: { nonce: "0".repeat(32), origin: auth.origin, response: auth.assert(o3.options as { challenge: string }) } }, HUMAN)).rejects.toMatchObject({ code: "approval_invalid" });
    // The staging changed after the human saw the diff: the signed payload no longer matches.
    await expect(passkeyInstall(h, auth, () => write("harness-staging/.claude/agents/chat.md", "otra cosa\n"))).rejects.toThrow(/cambió/);
    expect(read(".claude/agents/chat.md")).toBe("v1\nsame\n");
    expect(existsSync(join(root, ".claude", "skills"))).toBe(false);
  });

  it("refuses when the server was started by an agent (CLAUDECODE) and when the staged hook tests fail", async () => {
    const coord = makeLiveLike(home);
    const auth = new SoftAuthenticator();
    await enrollPasskey(coord, auth);
    const blocked = installer(coord, { env: { CLAUDECODE: "" } });
    expect(blocked.status().installBlocked).toBe(true);
    await expect(blocked.options()).rejects.toMatchObject({ code: "forbidden" });
    await expect(blocked.install({ webauthn: { nonce: "0".repeat(32), origin: auth.origin, response: {} } }, HUMAN)).rejects.toMatchObject({ code: "forbidden" });

    write("tests/hooks.test.ts", "");
    const failing = installer(coord, { tests: 1 });
    await expect(passkeyInstall(failing, auth)).rejects.toThrow(/hooks/);
    expect(read(".claude/agents/chat.md")).toBe("v1\nsame\n");
  });

  it("the challenge payload covers the before/after hash of every written file", () => {
    const a = harnessPayloadHash(harnessPlan(root)!);
    write(".claude/skills/nuevo/SKILL.md", "instalado a mano\n");
    expect(harnessPayloadHash(harnessPlan(root)!)).not.toBe(a);
  });
});

describe("HTTP route guards", () => {
  let server: Server;
  let base: string;
  let origin: string;
  let csrf: string;
  let cookie: string;

  beforeEach(async () => {
    const coord = makeCoord(home);
    installer(coord);
    const api = createCoordApi({ coordinator: coord });
    server = createServer((rq, rs) => api.middleware(rq, rs));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}/api/coord`;
    origin = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/csrf`);
    csrf = ((await res.json()) as { token: string }).token;
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  const call = async (method: string, path: string, opts: { csrf?: boolean; site?: string | null; body?: unknown } = {}) => {
    const headers: Record<string, string> = { Origin: origin };
    if (opts.csrf !== false) Object.assign(headers, { "X-Coord-CSRF": csrf, Cookie: cookie });
    if (opts.site !== null) headers["Sec-Fetch-Site"] = opts.site ?? "same-origin";
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return { status: res.status, json: (await res.json()) as { error?: { code: string; message: string } } & Record<string, unknown> };
  };

  it("status is a plain read; diff, options and install are human-only (CSRF)", async () => {
    const s = await call("GET", "/harness/status", { csrf: false });
    expect(s.status).toBe(200);
    expect(s.json.upToDate).toBe(false);
    expect((await call("GET", `/harness/diff?path=${encodeURIComponent(".claude/agents/chat.md")}`, { csrf: false })).status).toBe(403);
    expect((await call("GET", `/harness/diff?path=${encodeURIComponent(".claude/agents/chat.md")}`)).json.diff).toContain("+v2");
    expect((await call("GET", `/harness/diff?path=${encodeURIComponent("../coordinator.config.json")}`)).status).toBe(400);
    expect((await call("GET", "/harness/install-options", { csrf: false })).status).toBe(403);
  });

  it("install rejects missing CSRF, another origin, no fetch metadata, and a missing or invalid passkey", async () => {
    const noCsrf = await call("POST", "/harness/install", { csrf: false, body: {} });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.json.error!.message).toMatch(/CSRF/);
    const evil = await fetch(`${base}/harness/install`, { method: "POST", headers: { Origin: "http://evil.example", "X-Coord-CSRF": csrf, Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
    expect(evil.status).toBe(403);
    const noSite = await call("POST", "/harness/install", { site: null, body: {} });
    expect(noSite.status).toBe(403);
    expect(noSite.json.error!.message).toMatch(/navegador/);
    const noPasskey = await call("POST", "/harness/install", { body: {} });
    expect(noPasskey.status).toBe(403);
    expect(noPasskey.json.error!.code).toBe("approval_missing");
    const bad = await call("POST", "/harness/install", { body: { webauthn: { nonce: "0".repeat(32), origin, response: { id: "x", rawId: "x", type: "public-key", response: { authenticatorData: "", clientDataJSON: "", signature: "" } } } } });
    expect(bad.status).toBe(403);
    expect(["approval_invalid", "forbidden"]).toContain(bad.json.error!.code);
    const extra = await call("POST", "/harness/install", { body: { demo: true } });
    expect(extra.status).toBe(400); // strict body: no demo bypass
    expect(read(".claude/agents/chat.md")).toBe("v1\nsame\n");
  });
});

describe("no agent path reaches the harness install", () => {
  const AGENTISH = /harness|install|setup|claude_dir|\.claude/i;

  it("no MCP tool (full or chat mode) and no chat-allowed tool matches", async () => {
    expect(TOOLS.map((t) => t.name).filter((n) => AGENTISH.test(n))).toEqual([]);
    const { home: h, cleanup } = tempHome();
    cleanups.push(cleanup);
    const coord = makeCoord(h);
    for (const chat of [false, true]) {
      const server = createCoordServer(coord, { chat, audit: false });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: "t", version: "0" });
      await client.connect(b);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).filter((n) => AGENTISH.test(n))).toEqual([]);
      await client.close();
    }
    const staged = parseAgentFile(readFileSync(join(ROOT, "harness-staging", ".claude", "agents", "coordinador-chat.md"), "utf8"), "staged");
    expect(chatAllowedTools(staged).filter((n) => AGENTISH.test(n))).toEqual([]);
  });

  it("the MCP and chat layers never reference the installer or the install core", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|mts|js|mjs)$/.test(n)) files.push(p);
      }
    };
    walk(join(ROOT, "server", "mcp"));
    walk(join(ROOT, "server", "chat"));
    expect(files.length).toBeGreaterThan(3);
    const offenders = files.filter((p) => /harnessInstaller|harness-install|installHarnessFiles|runSetup|\/harness\//.test(readFileSync(p, "utf8"))).map((p) => relative(ROOT, p).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });
});
