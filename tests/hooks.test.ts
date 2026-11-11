/**
 * DEVELOPER harness hooks (dev-harness/.claude/hooks), activated into the repo root by
 * scripts/activate-dev-harness.ps1. Minimal guardrails by design:
 *   deny  coordinators' real data / backups / secrets / .env* (read + write, also inside nested worktrees),
 *         apply (and, with COORD_DEV_LIVE=1, every non-read coord tool), CLAUDECODE / env tricks
 *   ask   edits of the active guard (.claude/hooks/**, .claude/settings*.json)
 *   allow everything else: app code incl. security code, agent-runtime/**, dev-harness/**, CLAUDE.md, git
 * The in-app agent's hooks (agent-runtime/hooks) are tested in tests/server/agent-runtime.test.ts.
 * Hook contract: https://code.claude.com/docs/en/hooks
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const HOOKS = resolve(ROOT, process.env.HOOKS_DIR ?? "dev-harness/.claude/hooks");
const LOCAL = "C:\\Users\\coord\\AppData\\Local";
const ROAMING = "C:\\Users\\coord\\AppData\\Roaming";
const BASE_ENV = { LOCALAPPDATA: LOCAL, APPDATA: ROAMING, CLAUDE_PROJECT_DIR: ROOT };

function run(hook: string, input: unknown, env: Record<string, string> = {}) {
  const e: NodeJS.ProcessEnv = { ...process.env, ...BASE_ENV, ...env };
  delete e.COORD_DEV_LIVE;
  if (env.COORD_DEV_LIVE) e.COORD_DEV_LIVE = env.COORD_DEV_LIVE;
  const r = spawnSync(process.execPath, [join(HOOKS, `${hook}.mjs`)], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env: e });
  const out = r.stdout.trim() ? (JSON.parse(r.stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } }) : {};
  return { code: r.status, decision: out.hookSpecificOutput?.permissionDecision, reason: out.hookSpecificOutput?.permissionDecisionReason ?? "", context: out.hookSpecificOutput?.additionalContext };
}
const file = (tool: string, path: string, extra: Record<string, unknown> = {}) => run("guard-files", { tool_name: tool, tool_input: { file_path: path, ...extra }, cwd: ROOT });
const sh = (command: string, tool = "Bash") => run("guard-shell", { tool_name: tool, tool_input: { command }, cwd: ROOT });
const mcp = (tool: string, env: Record<string, string> = {}) => run("guard-mcp", { tool_name: `mcp__coord__${tool}`, tool_input: {} }, env);

describe("dev guard-files: real data, backups and secrets are off-limits (read and write)", () => {
  const PROTECTED = [
    `${LOCAL}\\bim-coordinator\\data\\projects\\p1\\notes.md`,
    `${LOCAL}\\bim-coordinator\\data\\decisions\\x.json`,
    `${LOCAL}\\bim-coordinator\\backups\\coordinator-2026-11-10.zip`,
    `${ROAMING}\\bim-coordinator\\approval-key.json`,
    "C:/Users/otro/AppData/Local/bim-coordinator/data/state/a.json", // other user profile: generic pattern
    "/home/u/.local/share/bim-coordinator/data/x.json",
    "/home/u/.config/bim-coordinator/aps-token.json",
    join(ROOT, ".env"),
    join(ROOT, ".env.local"),
    join(ROOT, ".env.production.local"),
    join(ROOT, ".coordinator", "decisions", "d.json"),
    // Nested worktrees: the old guard only matched repo-root-relative paths.
    join(ROOT, ".wt", "X", ".env.local"),
    join(ROOT, ".wt", "X", ".coordinator", "secret", "approval-key.json"),
    "\\\\?\\" + `${LOCAL}\\bim-coordinator\\data\\x.json`,
    `${LOCAL}\\bim-coordinator\\data. \\x.json`, // trailing dot/space
    `${LOCAL.toUpperCase()}\\BIM-COORDINATOR\\DATA\\x.json`, // case
  ];
  it.each(PROTECTED)("deny Read and Write: %s", (p) => {
    expect(file("Read", p).decision).toBe("deny");
    expect(file("Write", p, { content: "x" }).decision).toBe("deny");
  });

  it("relative paths resolve against the session cwd (also inside a nested worktree)", () => {
    expect(run("guard-files", { tool_name: "Edit", tool_input: { file_path: ".env.local" }, cwd: join(ROOT, ".wt", "Y") }).decision).toBe("deny");
    expect(run("guard-files", { tool_name: "Read", tool_input: { file_path: "../../.coordinator/auth/t.json" }, cwd: join(ROOT, ".wt", "Y") }).decision).toBe("deny");
  });

  it("Grep/Glob that reach secrets by path or wildcard are denied; content regexes are not paths", () => {
    expect(run("guard-files", { tool_name: "Grep", tool_input: { pattern: "token", path: `${ROAMING}\\bim-coordinator` } }).decision).toBe("deny");
    expect(run("guard-files", { tool_name: "Glob", tool_input: { pattern: "**/.env*" } }).decision).toBe("deny");
    expect(run("guard-files", { tool_name: "Glob", tool_input: { pattern: "**/*.ts", path: join(ROOT, "server") } }).decision).toBeUndefined();
    expect(run("guard-files", { tool_name: "Grep", tool_input: { pattern: "\\.env", path: join(ROOT, "server") } }).decision).toBeUndefined();
  });

  it("allows .env.example, the agent runtime folder and the demo data", () => {
    expect(file("Edit", join(ROOT, ".env.example")).decision).toBeUndefined();
    expect(file("Read", `${LOCAL}\\bim-coordinator\\agent-runtime\\0123456789abcdef\\CLAUDE.md`).decision).toBeUndefined();
    expect(file("Read", join(ROOT, ".coordinator-demo", "x.json")).decision).toBeUndefined();
  });
});

describe("dev guard-files: ask only before editing the active guard", () => {
  it.each([join(ROOT, ".claude", "hooks", "guard-shell.mjs"), join(ROOT, ".claude", "settings.json"), join(ROOT, ".claude", "settings.local.json"), join(ROOT, ".wt", "X", ".claude", "hooks", "_lib.mjs"), "C:/Users/coord/.claude/settings.json"])("ask on Write/Edit %s", (p) => {
    expect(file("Edit", p).decision).toBe("ask");
    expect(file("Write", p).reason).toContain("guardia activa");
    expect(file("Read", p).decision).toBeUndefined(); // reading is fine
  });

  it.each([
    "server/approval.ts",
    "server/secure/webauthn.ts",
    "server/aps/write-guard.ts",
    "server/data-admin.ts",
    "server/store/home.ts",
    "server/store/migrate.ts",
    "server/chat/bridge.ts",
    "server/mcp/contracts.ts",
    "agent-runtime/hooks/guard-apply.mjs",
    "agent-runtime/settings.json",
    "agent-runtime/agents/coordinador-chat.md",
    "agent-runtime/CLAUDE.md",
    "dev-harness/.claude/hooks/guard-shell.mjs",
    "dev-harness/.claude/settings.json",
    "CLAUDE.md",
    ".claude/skills/mejorar/SKILL.md",
    "src/App.tsx",
    "tests/server/chat.test.ts",
    "docs/setup.md",
    "rules/classification-rules.yaml",
    "package.json",
  ])("allow (no ask) editing %s", (rel) => {
    expect(file("Edit", join(ROOT, ...rel.split("/"))).decision).toBeUndefined();
  });

  it("fails closed on unreadable input", () => {
    expect(run("guard-files", "no json").code).toBe(2);
    expect(run("guard-shell", "").code).toBe(2);
    expect(run("guard-mcp", "{").code).toBe(2);
  });
});

describe("dev guard-shell", () => {
  it.each([
    `cat "${LOCAL}\\bim-coordinator\\data\\decisions\\x.json"`,
    "Get-ChildItem $env:LOCALAPPDATA\\bim-coordinator\\backups",
    "ls ~/.local/share/bim-coordinator/data",
    "type %APPDATA%\\bim-coordinator\\approval-key.json",
    "Get-Content $env:APPDATA\\x",
    "cat ~/.config/bim-coordinator/aps-token.json",
    "node -e \"console.log(require('fs').readFileSync('bim-'+'coordinator/data/x'))\"",
    "cat .env.local",
    "cat .wt/X/.env",
    "cp .env.example .env.local",
    "Get-Content .\\.env",
    "ls .coordinator/secret",
    "echo $APS_CLIENT_SECRET",
    "CLAUDECODE= npx tsx server/cli.ts approve L-1",
    "Remove-Item Env:CLAUDECODE; npm run coordinator -- approve L-1",
    "env -u CLAUDECODE npx tsx server/cli.ts passkey-enroll",
    "env -i PATH=x node server/cli.ts status",
    "npx tsx server/cli.ts approve L-1",
    "npm run coordinator -- passkey-enroll",
    "npx tsx server/cli.ts apply L-1 --no-dry-run",
    "npm run coordinator -- apply L-1",
    "curl -X POST https://developer.api.autodesk.com/construction/clash/v3/x",
    "curl -X POST http://localhost:3000/api/coord/batches/L-1/apply",
    "$env:COORD_DEV_LIVE = '1'; npx tsx scripts/x.ts",
  ])("deny: %s", (c) => {
    expect(sh(c).decision).toBe("deny");
  });

  it.each([
    "npx tsc -p tsconfig.server.json --noEmit",
    "npx vitest run",
    "npm run dev",
    "npm install zod",
    "npx tsx scripts/eval-agent.ts --self-test",
    "node scripts/dev-mcp.mjs",
    "git status",
    "git add .claude/hooks/guard-shell.mjs CLAUDE.md agent-runtime server",
    'git commit -m "Harden guard for .env.local and bim-coordinator/data paths; CLAUDECODE note"',
    "git checkout -b mejora/filtro-niveles",
    "git merge --no-ff mejora/filtro-niveles",
    "git log --oneline -5 -- .claude/settings.json",
    "cat .env.example",
    "grep -rn process.env server/",
    "cat .claude/settings.json",
    "Get-Content agent-runtime/hooks/guard-apply.mjs",
    "Copy-Item dev-harness/.claude/skills/mejorar/SKILL.md dev-harness/.claude/skills/mejorar/SKILL.bak",
    "npx tsx server/cli.ts status",
    "npm run coordinator -- verify-approval L-1 --json",
    "curl http://localhost:3037/api/coord/projects",
  ])("allow: %s", (c) => {
    expect(sh(c).decision).toBeUndefined();
  });

  it("asks before shell writes to the active guard", () => {
    expect(sh("echo {} > .claude/settings.json").decision).toBe("ask");
    expect(sh("Remove-Item .claude/hooks/guard-files.mjs", "PowerShell").decision).toBe("ask");
    expect(sh("sed -i 's/deny/allow/' .wt/X/.claude/hooks/_lib.mjs").decision).toBe("ask");
  });
});

describe("dev guard-mcp", () => {
  it("apply is always denied; fixtures mode allows every other coord tool", () => {
    expect(mcp("apply_approved_proposals").decision).toBe("deny");
    expect(mcp("apply_approved_proposals", { COORD_DEV_LIVE: "1" }).decision).toBe("deny");
    for (const t of ["propose_classification", "ingest_clash_test", "run_classification", "get_group", "draft_issue"]) expect(mcp(t).decision, t).toBeUndefined();
  });

  it("COORD_DEV_LIVE=1: read tools only", () => {
    for (const t of ["get_session_status", "list_projects", "summarize_clashes", "diff_test_versions", "get_group"]) expect(mcp(t, { COORD_DEV_LIVE: "1" }).decision, t).toBeUndefined();
    for (const t of ["propose_classification", "ingest_clash_test", "run_classification", "set_active_context", "draft_issue", "record_feedback", "generate_report", "start_flow"]) expect(mcp(t, { COORD_DEV_LIVE: "1" }).decision, t).toBe("deny");
  });

  it("non-coord tools pass (other servers are the developer's choice)", () => {
    expect(run("guard-mcp", { tool_name: "mcp__other__do", tool_input: {} }).decision).toBeUndefined();
  });
});

describe("dev harness wiring", () => {
  const settings = JSON.parse(readFileSync(join(ROOT, "dev-harness", ".claude", "settings.json"), "utf8")) as { permissions: { deny: string[]; allow?: string[]; ask?: string[] }; hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ args: string[] }> }>>; enabledMcpjsonServers: string[] };

  it("settings: apply + data/secret denies, every hook file exists, no allow-all rules", () => {
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["mcp__coord__apply_approved_proposals", "Read(~/AppData/Roaming/bim-coordinator/**)", "Read(~/AppData/Local/bim-coordinator/data/**)", "Edit(~/AppData/Local/bim-coordinator/backups/**)", "Read(**/.env.local)"]));
    expect(settings.permissions.allow ?? []).toEqual([]);
    expect(settings.enabledMcpjsonServers).toEqual(["coord"]);
    const hookFiles = Object.values(settings.hooks).flatMap((g) => g.flatMap((x) => x.hooks.map((h) => h.args[0]!.replace("${CLAUDE_PROJECT_DIR}/.claude/hooks/", ""))));
    expect(hookFiles.sort()).toEqual(["guard-files.mjs", "guard-mcp.mjs", "guard-shell.mjs", "session-start.mjs"]);
    const matchers = settings.hooks.PreToolUse!.map((x) => x.matcher);
    expect(matchers).toEqual(expect.arrayContaining(["Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit", "Bash|PowerShell|Monitor", "mcp__coord__.*"]));
  });

  it("coord MCP for the dev session is the fixtures wrapper", () => {
    const m = JSON.parse(readFileSync(join(ROOT, "dev-harness", ".mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(Object.keys(m.mcpServers)).toEqual(["coord"]);
    expect(m.mcpServers.coord!.args).toEqual(["scripts/dev-mcp.mjs"]);
    const wrapper = readFileSync(join(ROOT, "scripts", "dev-mcp.mjs"), "utf8");
    expect(wrapper).toContain('env.COORD_DATA_SOURCE = "fixtures"');
    expect(wrapper).toContain("COORD_DEV_LIVE");
  });

  it("session start: governance reminder + development mode line", () => {
    const s = run("session-start", {});
    expect(s.context).toContain("Procedimiento Acceso Herramientas IA");
    expect(s.context).toContain("Modo desarrollo: pídeme mejoras de la app o del agente con /mejorar");
    expect(s.context).toContain("fixtures");
    expect(run("session-start", {}, { COORD_DEV_LIVE: "1" }).context).toContain("solo lectura");
  });

  it("CLAUDE.md and /mejorar carry the governance line, the invariants and the workflow", () => {
    const md = readFileSync(join(ROOT, "dev-harness", "CLAUDE.md"), "utf8");
    expect(md).toContain("Procedimiento Acceso Herramientas IA");
    for (const s of ["agent-runtime/", "npx vitest run", "tsconfig.server.json", "/mejorar", "CSRF", "start_flow", "rules/"]) expect(md).toContain(s);
    const skill = readFileSync(join(ROOT, "dev-harness", ".claude", "skills", "mejorar", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: mejorar\n/);
    for (const s of ["máximo 3 preguntas", "npx vitest run", "Coordinador BIM.cmd", "mejora/<slug>"]) expect(skill).toContain(s);
  });

  it.skipIf(process.platform !== "win32")("activation script refuses to run under Claude Code", () => {
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "scripts", "activate-dev-harness.ps1"), "-Yes"], { encoding: "utf8", env: { ...process.env, CLAUDECODE: "1", LOCALAPPDATA: join(ROOT, "no-existe") } });
    expect(r.status).toBe(2);
  }, 30_000);
});
