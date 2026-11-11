/**
 * In-app agent runtime (server/agent-runtime.ts): agent-runtime/ is materialised into a private folder laid out
 * as a Claude project, verified by a sha256 manifest, written atomically, outside the data home and the repo,
 * keeping only the current and previous hash. Also: the shipped runtime hooks (agent-runtime/hooks) behave.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRuntimeBase, materializeRuntime, resetRuntimeCache, runtimeBaseFor, runtimePlan, runtimeTarget, RUNTIME_MANIFEST, verifyRuntime } from "../../server/agent-runtime";
import { ROOT } from "./helpers";

let tmp: string;
let app: string;
let base: string;

function writeApp(files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(app, "agent-runtime", ...rel.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
}

beforeEach(() => {
  resetRuntimeCache();
  tmp = mkdtempSync(join(tmpdir(), "coord-rt-"));
  app = join(tmp, "app");
  base = join(tmp, "runtime-base");
  writeApp({
    "CLAUDE.md": "# Constitución\nDocs en {{APP_ROOT}}/docs\n",
    "settings.json": '{"permissions":{"deny":["Bash"]}}\n',
    "agents/coordinador-chat.md": "---\nname: coordinador-chat\ntools: mcp__coord__get_group\n---\nHola {{APP_ROOT}}\n",
    "skills/triage/SKILL.md": "---\nname: triage\n---\nTriage\n",
    "hooks/guard-apply.mjs": "process.exit(0);\n",
    "README.txt": "no se copia\n",
    "agents/../../evil.md": "x",
  });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("runtime plan", () => {
  it("maps only the whitelisted layout and substitutes {{APP_ROOT}} in .md files", () => {
    expect(runtimeTarget("agents/x.md")).toBe(".claude/agents/x.md");
    expect(runtimeTarget("skills/a/SKILL.md")).toBe(".claude/skills/a/SKILL.md");
    expect(runtimeTarget("hooks/_lib.mjs")).toBe(".claude/hooks/_lib.mjs");
    expect(runtimeTarget("settings.json")).toBe(".claude/settings.json");
    expect(runtimeTarget("CLAUDE.md")).toBe("CLAUDE.md");
    for (const bad of ["README.txt", "agents/../x.md", "skills/a/other.md", "hooks/x.js", "settings.local.json", ".mcp.json", "agents/sub/x.md"]) expect(runtimeTarget(bad), bad).toBeNull();
    const plan = runtimePlan(app)!;
    expect(plan.files.map((f) => f.target)).toEqual([".claude/agents/coordinador-chat.md", ".claude/hooks/guard-apply.mjs", ".claude/settings.json", ".claude/skills/triage/SKILL.md", "CLAUDE.md"]);
    const md = plan.files.find((f) => f.target === "CLAUDE.md")!.content.toString("utf8");
    expect(md).not.toContain("{{APP_ROOT}}");
    expect(md).toContain(`${app.split("\\").join("/")}/docs`);
    expect(plan.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(runtimePlan(join(tmp, "nada"))).toBeUndefined();
  });

  it("the app's own agent-runtime/ ships every in-app agent and every flow skill (no coordinar-test)", () => {
    const plan = runtimePlan(ROOT)!;
    const targets = plan.files.map((f) => f.target);
    for (const a of ["coordinador-chat", "coordinador-flujos", "clash-triager", "issue-writer", "model-hygiene-auditor", "rules-curator"]) expect(targets).toContain(`.claude/agents/${a}.md`);
    for (const s of ["preparar-ciclo", "triage", "acta", "redactar-issues", "informe-semanal", "auditar-modelo", "curar-reglas"]) expect(targets).toContain(`.claude/skills/${s}/SKILL.md`);
    expect(targets.some((t) => t.includes("coordinar-test"))).toBe(false);
    for (const h of ["_lib", "guard-apply", "guard-shell", "guard-files", "guard-read", "guard-foreign-mcp", "audit-log", "session-start"]) expect(targets).toContain(`.claude/hooks/${h}.mjs`);
    expect(targets).toContain(".claude/settings.json");
    expect(targets).toContain("CLAUDE.md");
    // Every hook referenced by settings.json is shipped.
    const settings = JSON.parse(readFileSync(join(ROOT, "agent-runtime", "settings.json"), "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ args: string[] }> }>>; permissions: { deny: string[] } };
    for (const groups of Object.values(settings.hooks)) for (const g of groups) for (const h of g.hooks) expect(targets).toContain(h.args[0]!.replace("${CLAUDE_PROJECT_DIR}/", ""));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["mcp__coord__apply_approved_proposals", "Bash", "PowerShell", "Edit", "Write", "WebFetch"]));
  });
});

describe("materialisation", () => {
  it("writes a verified Claude project and reuses it while the source is unchanged", () => {
    const r = materializeRuntime({ appRoot: app, base })!;
    expect(r.dir).toBe(join(base, r.hash));
    expect(r.reused).toBe(false);
    expect(readFileSync(join(r.dir, ".claude", "agents", "coordinador-chat.md"), "utf8")).toContain(app.split("\\").join("/"));
    expect(existsSync(join(r.dir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(r.dir, "README.txt"))).toBe(false);
    expect(existsSync(join(r.dir, RUNTIME_MANIFEST))).toBe(true);
    expect(verifyRuntime(r.dir, r.hash)).toBe(true);
    // No staging folders left behind.
    expect(readdirSync(base).filter((n) => n.startsWith(".stage-"))).toEqual([]);
    resetRuntimeCache();
    expect(materializeRuntime({ appRoot: app, base })!.reused).toBe(true);
  });

  it("rebuilds a tampered folder (changed file, extra hook, settings.local.json)", () => {
    const r = materializeRuntime({ appRoot: app, base })!;
    for (const tamper of [
      () => writeFileSync(join(r.dir, ".claude", "hooks", "guard-apply.mjs"), "/* desactivado */"),
      () => writeFileSync(join(r.dir, ".claude", "hooks", "extra.mjs"), "x"),
      () => writeFileSync(join(r.dir, ".claude", "settings.local.json"), '{"permissions":{"allow":["Bash"]}}'),
      () => rmSync(join(r.dir, ".claude", "agents", "coordinador-chat.md")),
    ]) {
      tamper();
      expect(verifyRuntime(r.dir, r.hash)).toBe(false);
      resetRuntimeCache();
      const again = materializeRuntime({ appRoot: app, base })!;
      expect(again.reused).toBe(false);
      expect(again.dir).toBe(r.dir);
      expect(verifyRuntime(again.dir, again.hash)).toBe(true);
      expect(readFileSync(join(again.dir, ".claude", "hooks", "guard-apply.mjs"), "utf8")).toBe("process.exit(0);\n");
      expect(existsSync(join(again.dir, ".claude", "settings.local.json"))).toBe(false);
    }
  });

  it("a changed source gets a new hash; only the current and the previous hash are kept", () => {
    const hashes: string[] = [];
    for (let i = 0; i < 4; i++) {
      writeApp({ "agents/coordinador-chat.md": `---\nname: coordinador-chat\ntools: mcp__coord__get_group\n---\nversión ${i}\n` });
      hashes.push(materializeRuntime({ appRoot: app, base })!.hash);
    }
    expect(new Set(hashes).size).toBe(4);
    const dirs = readdirSync(base).filter((n) => /^[0-9a-f]{16}$/.test(n)).sort();
    expect(dirs).toEqual([hashes[2]!, hashes[3]!].sort());
    expect(JSON.parse(readFileSync(join(base, "state.json"), "utf8"))).toEqual({ current: hashes[3], previous: hashes[2] });
  });

  it("refuses a base inside the app folder or the data home; no source → undefined", () => {
    expect(() => materializeRuntime({ appRoot: app, base: join(app, "rt") })).toThrow(/no puede estar dentro/);
    const dataHome = join(tmp, "data");
    expect(() => materializeRuntime({ appRoot: app, base: join(dataHome, "agent-runtime"), forbidden: [dataHome] })).toThrow(/no puede estar dentro/);
    expect(existsSync(join(dataHome, "agent-runtime"))).toBe(false);
    expect(materializeRuntime({ appRoot: join(tmp, "sin-agente"), base })).toBeUndefined();
  });

  it("default base is a sibling of data/ (never inside it); demo / fixtures / tests use a temp folder", () => {
    const local = join(tmp, "Local");
    const b = defaultRuntimeBase({ env: { LOCALAPPDATA: local }, platform: "win32" });
    expect(b).toBe(join(local, "bim-coordinator", "agent-runtime"));
    expect(b.startsWith(join(local, "bim-coordinator", "data"))).toBe(false);
    expect(runtimeBaseFor({ root: app, homeOverride: join(tmp, "h"), source: { kind: "fixtures" } }, {}).startsWith(tmpdir())).toBe(true);
    expect(runtimeBaseFor({ root: app, source: { kind: "fixtures" } }, {}).startsWith(tmpdir())).toBe(true);
    expect(runtimeBaseFor({ root: app, source: { kind: "live" } }, { COORD_AGENT_RUNTIME_BASE: base })).toBe(base);
    // Two test homes never share a base (no cross-cleanup between parallel runs).
    expect(runtimeBaseFor({ root: app, homeOverride: join(tmp, "a"), source: { kind: "fixtures" } }, {})).not.toBe(runtimeBaseFor({ root: app, homeOverride: join(tmp, "b"), source: { kind: "fixtures" } }, {}));
  });
});

describe("shipped runtime hooks (agent-runtime/hooks)", () => {
  let rt: string;
  beforeEach(() => {
    rt = join(tmp, "rt");
    cpSync(join(ROOT, "agent-runtime", "hooks"), join(rt, ".claude", "hooks"), { recursive: true });
  });
  const hook = (name: string, input: unknown, env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [join(rt, ".claude", "hooks", `${name}.mjs`)], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: rt, ...env } });
    const out = r.stdout.trim() ? (JSON.parse(r.stdout) as { hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string } }) : {};
    return { code: r.status, decision: out.hookSpecificOutput?.permissionDecision, context: out.hookSpecificOutput?.additionalContext };
  };

  it("apply, shell and file writes are always denied; unreadable input fails closed", () => {
    expect(hook("guard-apply", { tool_name: "mcp__coord__apply_approved_proposals", tool_input: { batchId: "L-1", dryRun: true } }).decision).toBe("deny");
    expect(hook("guard-shell", { tool_name: "Bash", tool_input: { command: "ls" } }).decision).toBe("deny");
    expect(hook("guard-files", { tool_name: "Write", tool_input: { file_path: join(ROOT, "server", "x.ts") } }).decision).toBe("deny");
    for (const h of ["guard-apply", "guard-shell", "guard-files", "guard-read", "guard-foreign-mcp"]) expect(hook(h, "no es json").code, h).toBe(2);
  });

  it("reads: docs, rules and project notes allowed; secrets, keystore, .env and .git denied (also nested worktrees)", () => {
    const read = (p: string, tool = "Read") => hook("guard-read", { tool_name: tool, tool_input: tool === "Read" ? { file_path: p } : { path: p, pattern: "x" } }).decision;
    expect(read(join(ROOT, "docs", "domain", "clash-taxonomy.md"))).toBeUndefined();
    expect(read(join(ROOT, "rules", "classification-rules.yaml"))).toBeUndefined();
    expect(read("C:/Users/u/AppData/Local/bim-coordinator/data/projects/p1/notes.md")).toBeUndefined();
    expect(read(join(ROOT, ".env.example"))).toBeUndefined();
    for (const p of [
      join(ROOT, ".env.local"),
      join(ROOT, ".wt", "X", ".env"),
      "C:/Users/u/AppData/Roaming/bim-coordinator/approval-key.json",
      "C:/Users/u/AppData/Local/bim-coordinator/data/secret/x.json",
      join(ROOT, ".coordinator", "auth", "token.json"),
      join(ROOT, ".wt", "X", ".coordinator", "secret", "k"),
      join(ROOT, ".git", "config"),
      "C:/Users/u/.claude.json",
    ]) expect(read(p), p).toBe("deny");
    expect(read("C:/Users/u/AppData/Roaming/bim-coordinator", "Grep")).toBe("deny");
    expect(hook("guard-read", { tool_name: "Glob", tool_input: { pattern: "**/.env*" } }).decision).toBe("deny");
  });

  it("foreign MCP write tools are denied; session-start reports governance and fixtures mode", () => {
    expect(hook("guard-foreign-mcp", { tool_name: "mcp__revit__send_code_to_revit", tool_input: {} }).decision).toBe("deny");
    expect(hook("guard-foreign-mcp", { tool_name: "mcp__pbi__list_tables", tool_input: {} }).decision).toBeUndefined();
    const s = hook("session-start", {}, { COORD_DATA_SOURCE: "fixtures", COORD_APP_ROOT: ROOT });
    expect(s.context).toContain("Procedimiento Acceso Herramientas IA");
    expect(s.context).toContain("MODO FIXTURES");
  });

  it("audit-log writes only to COORD_AGENT_AUDIT_DIR (never into the runtime folder)", () => {
    const audit = join(tmp, "audit");
    const input = { tool_name: "mcp__coord__get_group", tool_input: { groupId: "G-1", token: "secreto" }, tool_response: { ok: true } };
    expect(hook("audit-log", input, { COORD_AGENT_AUDIT_DIR: audit }).code).toBe(0);
    const files = readdirSync(audit);
    expect(files).toHaveLength(1);
    const line = readFileSync(join(audit, files[0]!), "utf8");
    expect(line).toContain('"tool_name":"mcp__coord__get_group"');
    expect(line).not.toContain("secreto");
    expect(hook("audit-log", input, { COORD_AGENT_AUDIT_DIR: "" }).code).toBe(0);
    expect(existsSync(join(rt, ".coordinator"))).toBe(false);
  });
});
