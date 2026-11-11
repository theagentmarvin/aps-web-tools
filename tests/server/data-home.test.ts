/**
 * WS-H: data home outside the repo, automatic migration, daily backups, export / import.
 * Everything runs in temp folders (never the real %LOCALAPPDATA% or <repo>/.coordinator).
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCoordApi } from "../../server/api/router";
import { BACKUP_FORMAT, DataAdmin, MANIFEST_NAME } from "../../server/data-admin";
import { TOOLS } from "../../server/mcp/contracts";
import { defaultDataHome, MIGRATED_MARKER, MIGRATION_ERROR, MIGRATION_RECORD, resolveDataHome } from "../../server/store/home";
import { migrateLegacyHome } from "../../server/store/migrate";
import { crc32, readZip, unsafeEntryReason } from "../../server/store/zip";
import { HUMAN, makeCoord, makeLiveLike } from "./helpers";

const dirs: string[] = [];
function tmp(prefix = "coord-h-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
    rmSync(`${d}-backups`, { recursive: true, force: true });
  }
});

function put(root: string, rel: string, text: string): void {
  const p = join(root, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

/** A fake repo root + LOCALAPPDATA, both temp. */
function sandbox() {
  const root = tmp("coord-repo-");
  const local = tmp("coord-local-");
  const env = { LOCALAPPDATA: local, XDG_DATA_HOME: local } as NodeJS.ProcessEnv;
  const legacy = join(root, ".coordinator");
  const newHome = defaultDataHome(env);
  return { root, local, env, legacy, newHome, opts: { root, env, dataSource: "live" as const } };
}

function seedLegacy(legacy: string) {
  put(legacy, ".gitkeep", "");
  put(legacy, "decisions/decisions.jsonl", '{"id":"D-1","projectId":"p1"}\n');
  put(legacy, "proposals/P-20261101-0001.json", JSON.stringify({ id: "P-20261101-0001", projectId: "p1" }));
  put(legacy, "projects/p1/notes.md", "- 2026-11-01 · [convención] ejes A-F (confirmado por coordinador)\n");
  put(legacy, "state/counters.json", "{}");
  // A lock left behind by a crashed process (stale): excluded from the copy and taken over.
  put(legacy, "state/store.lock", '{"pid":1}');
  const old = new Date(Date.now() - 3600_000);
  utimesSync(join(legacy, "state", "store.lock"), old, old);
  put(legacy, "state/counters.json.123.tmp", "partial");
  put(legacy, "secret/approval.key", "NOT-TO-BE-COPIED");
  put(legacy, "auth/token.json", "NOT-TO-BE-COPIED");
}

/** Minimal stored-only ZIP writer that does NOT validate names (to build hostile archives). */
function rawZip(entries: Array<{ name: string; data: Buffer | string; mode?: number }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const name = Buffer.from(e.name);
    const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    c.writeUInt32LE(off, 42);
    parts.push(h, name, data);
    central.push(c, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

async function* chunks(b: Buffer) {
  yield b;
}

describe("resolveDataHome", () => {
  it("default per-user folder: %LOCALAPPDATA% on Windows, XDG_DATA_HOME / ~/.local/share elsewhere", () => {
    expect(defaultDataHome({ LOCALAPPDATA: "C:\\Users\\a b\\AppData\\Local" }, "win32").replace(/\\/g, "/")).toBe("C:/Users/a b/AppData/Local/bim-coordinator/data");
    expect(defaultDataHome({ XDG_DATA_HOME: "/xdg" }, "linux").replace(/\\/g, "/")).toMatch(/\/xdg\/bim-coordinator\/data$/);
    expect(defaultDataHome({}, "darwin", "/home/u").replace(/\\/g, "/")).toMatch(/\/home\/u\/\.local\/share\/bim-coordinator\/data$/);
  });

  it("COORDINATOR_HOME / explicit home win; fixtures keep the repo folder; never migrated", async () => {
    const s = sandbox();
    seedLegacy(s.legacy);
    expect(resolveDataHome({ ...s.opts, env: { ...s.env, COORDINATOR_HOME: join(s.local, "x") } }).mode).toBe("override");
    expect(resolveDataHome({ ...s.opts, dataSource: "fixtures" })).toMatchObject({ mode: "fixtures", home: s.legacy });
    expect((await migrateLegacyHome({ ...s.opts, dataSource: "fixtures" })).status).toBe("skipped");
    expect((await migrateLegacyHome({ ...s.opts, env: { ...s.env, COORDINATOR_HOME: join(s.local, "x") } })).status).toBe("skipped");
    expect(existsSync(s.newHome)).toBe(false);
  });

  it("a repo folder with only .gitkeep / hook audit lines is not data: the new folder is used", () => {
    const s = sandbox();
    put(s.legacy, ".gitkeep", "");
    put(s.legacy, "audit/agent-2026-11.jsonl", "{}\n");
    expect(resolveDataHome(s.opts)).toMatchObject({ mode: "default", home: s.newHome, pendingMigration: false });
  });
});

describe("migration of <repo>/.coordinator", () => {
  it("copies (never moves), verifies, marks the old folder, records the migration; idempotent", async () => {
    const s = sandbox();
    seedLegacy(s.legacy);
    expect(resolveDataHome(s.opts)).toMatchObject({ mode: "legacy", home: s.legacy, pendingMigration: true });
    const r = await migrateLegacyHome(s.opts);
    expect(r.status).toBe("migrated");
    if (r.status !== "migrated") return;
    expect(r.record.fileCount).toBe(4); // decisions, proposal, notes, counters
    expect(readFileSync(join(s.newHome, "decisions", "decisions.jsonl"), "utf8")).toContain("D-1");
    expect(existsSync(join(s.newHome, "secret"))).toBe(false);
    expect(existsSync(join(s.newHome, "auth"))).toBe(false);
    expect(existsSync(join(s.newHome, "state", "store.lock"))).toBe(false);
    expect(JSON.parse(readFileSync(join(s.newHome, MIGRATION_RECORD), "utf8"))).toMatchObject({ version: 1, fileCount: 4 });
    // Old folder intact + marker pointing at the new path.
    expect(readFileSync(join(s.legacy, "decisions", "decisions.jsonl"), "utf8")).toContain("D-1");
    expect(readFileSync(join(s.legacy, MIGRATED_MARKER), "utf8")).toContain(s.newHome);
    expect(resolveDataHome(s.opts)).toMatchObject({ mode: "default", home: s.newHome, bothExist: false });
    // Second start: nothing to do, nothing copied twice.
    put(s.newHome, "decisions/decisions.jsonl", '{"id":"D-2"}\n');
    expect((await migrateLegacyHome(s.opts)).status).toBe("none");
    expect(readFileSync(join(s.newHome, "decisions", "decisions.jsonl"), "utf8")).toContain("D-2");
    // No leftovers of the staging copy.
    expect(readdirSync(join(s.newHome, "..")).filter((n) => n.startsWith("data.migrating"))).toEqual([]);
  });

  it("verification failure: staging discarded, old folder stays in use, error surfaced; next start succeeds", async () => {
    const s = sandbox();
    seedLegacy(s.legacy);
    const r = await migrateLegacyHome({ ...s.opts, afterCopy: async (staging) => writeFileSync(join(staging, "decisions", "decisions.jsonl"), "tampered") });
    expect(r.status).toBe("failed");
    expect(existsSync(s.newHome)).toBe(false);
    expect(existsSync(join(s.legacy, MIGRATED_MARKER))).toBe(false);
    expect(resolveDataHome(s.opts)).toMatchObject({ mode: "legacy", home: s.legacy });
    const err = JSON.parse(readFileSync(join(s.newHome, "..", MIGRATION_ERROR), "utf8")) as { problems: string[] };
    expect(err.problems.join(" ")).toMatch(/sha256/);
    expect((await migrateLegacyHome(s.opts)).status).toBe("migrated");
    expect(existsSync(join(s.newHome, "..", MIGRATION_ERROR))).toBe(false);
  });

  it("both folders with data: the new one wins, no merge, warning", async () => {
    const s = sandbox();
    seedLegacy(s.legacy);
    put(s.newHome, "decisions/decisions.jsonl", '{"id":"NEW"}\n');
    const r = await migrateLegacyHome(s.opts);
    expect(r.status).toBe("both_exist");
    expect(r.resolution.home).toBe(s.newHome);
    expect(readFileSync(join(s.newHome, "decisions", "decisions.jsonl"), "utf8")).not.toContain("D-1");
    expect(existsSync(join(s.newHome, "proposals"))).toBe(false);
  });

  it("concurrent starts migrate once", async () => {
    const s = sandbox();
    seedLegacy(s.legacy);
    const [a, b] = await Promise.all([migrateLegacyHome(s.opts), migrateLegacyHome(s.opts)]);
    expect([a.status, b.status].sort()).toEqual(["migrated", "none"]);
  });
});

describe("backups", () => {
  it("zip holds data + manifest with sha256, never secrets or locks; external copy; audit without paths", async () => {
    const home = tmp();
    const target = tmp("coord-target-");
    const coord = makeCoord(home);
    put(home, "decisions/decisions.jsonl", '{"id":"D-1","projectId":"p1"}\n');
    put(home, "secret/approval-key.json", "SECRET");
    put(home, "state/x.lock", "lock");
    put(home, "tests/T-1/run.exe", "MZ");
    const admin = new DataAdmin(coord);
    await admin.saveSettings({ targetDir: target, keep: 3 }, { type: "user", id: HUMAN.id, name: HUMAN.name });
    const b = await admin.backupNow("manual", { type: "user", id: HUMAN.id, name: HUMAN.name });
    expect(admin.backupsDir).toBe(`${home}-backups`);
    const entries = readZip(await readFile(join(admin.backupsDir, b.name)));
    const names = entries.map((e) => e.name);
    expect(names).toContain(MANIFEST_NAME);
    expect(names).toContain("data/decisions/decisions.jsonl");
    expect(names.some((n) => /secret|\.lock|\.exe/.test(n))).toBe(false);
    const manifest = JSON.parse(entries.find((e) => e.name === MANIFEST_NAME)!.read().toString("utf8"));
    expect(manifest).toMatchObject({ format: BACKUP_FORMAT, version: 1, scope: "full", skipped: 1 });
    expect(existsSync(join(target, b.name))).toBe(true);
    const text = readFileSync(join(home, "audit", "audit.jsonl"), "utf8");
    expect(text).toContain('"action":"data.backup"');
    expect(text).not.toContain(target.replace(/\\/g, "\\\\"));
  });

  it("rotation keeps the newest N daily backups and N others", async () => {
    const home = tmp();
    let t = new Date(2026, 10, 1, 10, 0, 0).getTime();
    const coord = makeCoord(home, { now: () => t });
    put(home, "decisions/decisions.jsonl", "{}\n");
    const admin = new DataAdmin(coord);
    await admin.saveSettings({ keep: 2 }, { type: "user", id: HUMAN.id, name: HUMAN.name });
    for (let d = 0; d < 4; d++) {
      const info = await admin.backupNow("scheduled", { type: "server", id: "backup", name: "x" });
      // mtime follows the fake clock so "newest" is well defined.
      utimesSync(join(admin.backupsDir, info.name), new Date(t), new Date(t));
      t += 24 * 3600_000;
    }
    await admin.rotate(admin.backupsDir, 2);
    const left = (await admin.listBackups()).map((b) => b.name).sort();
    expect(left).toEqual(["coordinator-2026-11-03.zip", "coordinator-2026-11-04.zip"]);
    await admin.backupNow("manual", { type: "user", id: HUMAN.id, name: HUMAN.name });
    expect((await admin.listBackups()).filter((b) => b.kind === "scheduled")).toHaveLength(2);
  });

  it("refuses an external target inside the data folder or a relative path", async () => {
    const home = tmp();
    const admin = new DataAdmin(makeCoord(home));
    mkdirSync(join(home, "projects"), { recursive: true });
    const actor = { type: "user" as const, id: HUMAN.id, name: HUMAN.name };
    await expect(admin.saveSettings({ targetDir: join(home, "projects") }, actor)).rejects.toThrow(/dentro/);
    await expect(admin.saveSettings({ targetDir: "relativo/carpeta" }, actor)).rejects.toThrow(/absoluta/);
  });
});

describe("zip-slip and import validation", () => {
  it("unsafe entry names are refused", () => {
    for (const n of ["../evil.json", "data/../../evil.json", "/abs.json", "C:/x.json", "data\\x.json", "data/con.json", "data/a:b.json", "data//x.json", "data/./x.json"]) {
      expect(unsafeEntryReason(n), n).toBeDefined();
    }
    expect(unsafeEntryReason("data/tests/T-1/test.json")).toBeUndefined();
    expect(() => readZip(rawZip([{ name: "../evil.json", data: "{}" }]))).toThrow(/insegura/);
    expect(() => readZip(rawZip([{ name: "data/link.json", data: "x", mode: 0o120777 }]))).toThrow(/simbólico/);
  });

  it("stageImport refuses traversal, executables, secrets, missing manifest and project exports", async () => {
    const home = tmp();
    const admin = new DataAdmin(makeCoord(home));
    const man = (files: Array<{ path: string; data: string }>, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ format: BACKUP_FORMAT, version: 1, createdAt: "2026-11-01T00:00:00Z", kind: "manual", scope: "full", fileCount: files.length, bytes: 0, skipped: 0, files: files.map((f) => ({ path: f.path, size: f.data.length, sha256: createHash("sha256").update(f.data).digest("hex") })), ...extra });
    const stage = (entries: Array<{ name: string; data: string }>) => admin.stageImport(chunks(rawZip(entries)));
    await expect(stage([{ name: MANIFEST_NAME, data: man([]) }, { name: "data/../../pwn.json", data: "{}" }])).rejects.toThrow(/insegura/);
    await expect(stage([{ name: MANIFEST_NAME, data: man([{ path: "tests/run.exe", data: "MZ" }]) }, { name: "data/tests/run.exe", data: "MZ" }])).rejects.toThrow(/no permitido/);
    await expect(stage([{ name: MANIFEST_NAME, data: man([{ path: "secret/k.json", data: "{}" }]) }, { name: "data/secret/k.json", data: "{}" }])).rejects.toThrow(/nunca se importan/);
    await expect(stage([{ name: "data/decisions/decisions.jsonl", data: "{}\n" }])).rejects.toThrow(/falta/);
    const one = [{ path: "decisions/decisions.jsonl", data: "{}\n" }];
    await expect(stage([{ name: MANIFEST_NAME, data: man(one, { scope: "project" }) }, { name: "data/decisions/decisions.jsonl", data: "{}\n" }])).rejects.toThrow(/un solo proyecto/);
    await expect(stage([{ name: MANIFEST_NAME, data: man(one) }, { name: "data/decisions/decisions.jsonl", data: "tampered\n" }])).rejects.toThrow(/sha256/);
    expect(existsSync(join(home, "pwn.json"))).toBe(false);
    expect(existsSync(`${home}-backups`) ? readdirSync(`${home}-backups`).filter((n) => n.startsWith(".import-")) : []).toEqual([]);
  });

  it("round trip: backup → stage → restore (fixtures demo) with a pre-restore backup; secrets stay", async () => {
    const home = tmp();
    const coord = makeCoord(home);
    const actor = { type: "user" as const, id: HUMAN.id, name: HUMAN.name };
    put(home, "decisions/decisions.jsonl", '{"id":"ORIGINAL"}\n');
    const admin = new DataAdmin(coord);
    const b = await admin.backupNow("manual", actor);
    put(home, "decisions/decisions.jsonl", '{"id":"CHANGED"}\n');
    put(home, "secret/keep.json", "KEEP");
    const st = await admin.stageImport(chunks(await readFile(join(admin.backupsDir, b.name))));
    expect(st.fileCount).toBeGreaterThan(0);
    await expect(admin.restore(st.id, {}, actor)).rejects.toThrow(/passkey/);
    const st2 = await admin.stageImport(chunks(await readFile(join(admin.backupsDir, b.name))));
    const r = await admin.restore(st2.id, { demo: true }, actor);
    expect(r).toMatchObject({ proof: "demo", restartRecommended: true });
    expect(r.preRestoreBackup).toMatch(/-pre-restore\.zip$/);
    expect(readFileSync(join(home, "decisions", "decisions.jsonl"), "utf8")).toContain("ORIGINAL");
    expect(readFileSync(join(home, "secret", "keep.json"), "utf8")).toBe("KEEP");
    expect(readFileSync(join(home, "audit", "audit.jsonl"), "utf8")).toContain('"action":"data.restored"');
    // The pre-restore backup holds the CHANGED state.
    const pre = readZip(await readFile(join(admin.backupsDir, r.preRestoreBackup)));
    expect(pre.find((e) => e.name === "data/decisions/decisions.jsonl")!.read().toString()).toContain("CHANGED");
    expect(readdirSync(join(home, "..")).filter((n) => n.startsWith(`${home.split(/[\\/]/).pop()}.replaced`))).toEqual([]);
  });
});

describe("routes: human-only (CSRF; passkey for restore), no MCP tool", () => {
  let server: Server;
  let base = "";
  let origin = "";
  let csrf = "";
  let cookie = "";
  async function start(coord: ReturnType<typeof makeCoord>) {
    const api = createCoordApi({ coordinator: coord });
    server = createServer((rq, rs) => api.middleware(rq, rs));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}/api/coord`;
    origin = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/csrf`);
    csrf = ((await res.json()) as { token: string }).token;
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }
  const h = (withCsrf: boolean, extra: Record<string, string> = {}) => ({ Origin: origin, ...(withCsrf ? { "X-Coord-CSRF": csrf, Cookie: cookie } : {}), ...extra });
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
  });

  it("every data route needs the CSRF token; export streams a zip; import + restore need a passkey in live mode", async () => {
    const home = tmp();
    put(home, "decisions/decisions.jsonl", "{}\n");
    await start(makeLiveLike(home));
    for (const [method, path] of [
      ["GET", "/data/status"],
      ["POST", "/data/backups"],
      ["PUT", "/data/settings"],
      ["GET", "/data/export"],
      ["POST", "/data/import"],
      ["GET", "/data/import/0123456789abcdef/restore-options"],
      ["POST", "/data/import/0123456789abcdef/restore"],
      ["DELETE", "/data/import/0123456789abcdef"],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method, headers: h(false, { "Content-Type": "application/json" }), body: method === "GET" ? undefined : "{}" });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    const st = await fetch(`${base}/data/status`, { headers: h(true) });
    expect(st.status).toBe(200);
    expect(((await st.json()) as { mode: string }).mode).toBe("override");

    const ex = await fetch(`${base}/data/export`, { headers: h(true) });
    expect(ex.status).toBe(200);
    expect(ex.headers.get("content-type")).toBe("application/zip");
    const zip = Buffer.from(await ex.arrayBuffer());
    expect(readZip(zip).map((e) => e.name)).toContain("data/decisions/decisions.jsonl");

    const up = await fetch(`${base}/data/import`, { method: "POST", headers: h(true, { "Content-Type": "application/zip" }), body: zip });
    expect(up.status).toBe(200);
    const stage = (await up.json()) as { id: string };
    const noKey = await fetch(`${base}/data/import/${stage.id}/restore`, { method: "POST", headers: h(true, { "Content-Type": "application/json" }), body: "{}" });
    expect(noKey.status).toBe(403);
    expect(((await noKey.json()) as { error: { code: string } }).error.code).toBe("approval_missing");
    const demo = await fetch(`${base}/data/import/${stage.id}/restore`, { method: "POST", headers: h(true, { "Content-Type": "application/json" }), body: JSON.stringify({ demo: true }) });
    expect(demo.status).toBe(403);
    // Without an enrolled passkey there are no restore options either.
    const opts = await fetch(`${base}/data/import/${stage.id}/restore-options`, { headers: h(true) });
    expect(opts.status).toBe(403);
  });

  it("no MCP tool can back up, export, import, restore or configure backups", () => {
    for (const t of TOOLS) {
      expect(`${t.name} ${t.title ?? ""}`, t.name).not.toMatch(/backup|restore|respald|export|import|data_home|datos y respaldos/i);
    }
    const mcpSrc = ["server.ts", "index.ts", "contracts.ts"].map((f) => readFileSync(join(__dirname, "..", "..", "server", "mcp", f), "utf8")).join("\n");
    expect(mcpSrc).not.toMatch(/data-admin|DataAdmin/);
  });
});
