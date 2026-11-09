// PreToolUse guard for mcp__coord__apply_approved_proposals (the ONLY ACC write path). v2.
// Defence in depth: the MCP server re-verifies the WebAuthn-signed approval under the batch lock; that is the
// real boundary. This hook FAILS CLOSED: any parse error, missing verifier, modified approval code or
// non-zero verifier exit -> deny.
//
// Checks, in order:
//  1. hook input parses, tool is the apply tool
//  2. caller is the main agent (never a subagent / --agent session)
//  3. autonomy level >= 1 (coordinator.config.json / .local.json; invalid JSON -> deny)
//  4. input is exactly {batchId, dryRun?}: unknown keys -> deny; safe batch id format
//  5. dry run (dryRun absent or === true) -> no decision (the settings `ask` rule still prompts the human)
//     Anything else (false, "false", 0, null…) is treated as a REAL apply.
//  6. outside dev mode: the approval code must be unmodified vs git HEAD (`git status --porcelain
//     --untracked-files=all -- <GUARDED>`: cli, approval, secure, store, aps/write-guard.ts, aps/issues.ts)
//  7. `node --import tsx server/cli.ts verify-approval <batchId> --json` must exit 0 and not report valid:false
// On success: NO decision, so the permission `ask` rule always prompts the human.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readInput, projectRoot, decide, pass, block, isSubagent, isHarnessDev, loadConfig, TAG } from "./_lib.mjs";

const APPLY_TOOL = "mcp__coord__apply_approved_proposals";
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// The approval verifier and the ACC write door (write-guard: the only issuer of write tokens; issues: the
// Issues v1 client that M5's issue.update will use). Any change vs git HEAD blocks real applies outside dev mode.
const GUARDED = ["server/cli.ts", "server/approval", "server/secure", "server/store", "server/aps/write-guard.ts", "server/aps/issues.ts"];

let input;
try {
  input = readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; aplicación bloqueada (${e.message}).`);
}

if (input.tool_name !== APPLY_TOOL) pass();

if (isSubagent(input)) {
  decide("deny", `${TAG} Solo el agente principal puede aplicar en ACC; un subagente (${input.agent_type ?? input.agent_id}) nunca.`);
}

const root = projectRoot(input);

let cfg;
try {
  cfg = loadConfig(root);
} catch (e) {
  decide("deny", `${TAG} coordinator.config(.local).json inválido; aplicación bloqueada (${e.message}).`);
}
if ((cfg.autonomy?.level ?? 1) < 1) decide("deny", `${TAG} Nivel de autonomía L0 (solo lectura): no se aplican cambios en ACC.`);

const ti = input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input) ? input.tool_input : null;
if (!ti) decide("deny", `${TAG} Entrada de aplicación inválida.`);
const extra = Object.keys(ti).filter((k) => k !== "batchId" && k !== "dryRun");
if (extra.length) decide("deny", `${TAG} Campos no permitidos en la aplicación: ${extra.join(", ")}.`);

const batchId = ti.batchId;
if (typeof batchId !== "string" || !BATCH_ID.test(batchId)) {
  decide("deny", `${TAG} Aplicar requiere un lote (batchId) aprobado por un humano con passkey en la UI web (/aprobaciones). No se aplican propuestas sueltas.`);
}

const dryRun = ti.dryRun === undefined || ti.dryRun === true;
if (dryRun) pass();

const run = (cmd, args, timeout) =>
  spawnSync(cmd, args, { cwd: root, encoding: "utf8", timeout, windowsHide: true, env: { ...process.env, COORD_VERIFY_CALLER: "guard-apply-hook" } });

if (!isHarnessDev()) {
  const g = run("git", ["status", "--porcelain", "--untracked-files=all", "--", ...GUARDED], 10000);
  if (g.error || g.status !== 0) {
    decide("deny", `${TAG} No se pudo verificar con git que el código de aprobación esté intacto (${g.error?.code ?? (g.stderr || "").trim().slice(0, 120)}). Bloqueado.`);
  }
  if ((g.stdout || "").trim()) {
    decide("deny", `${TAG} El código que verifica aprobaciones (${GUARDED.join(", ")}) tiene cambios respecto de git HEAD; no se aplica nada hasta que un humano los revise.`);
  }
}

if (!existsSync(join(root, "node_modules", "tsx", "package.json")) || !existsSync(join(root, "server", "cli.ts"))) {
  decide("deny", `${TAG} No se encontró el verificador de aprobaciones (tsx o server/cli.ts). Bloqueado por seguridad.`);
}

// No shell: argv array, so batchId cannot inject commands (also constrained by BATCH_ID).
const r = run(process.execPath, ["--import", "tsx", join(root, "server", "cli.ts"), "verify-approval", batchId, "--json"], 30000);

let verdict;
try {
  verdict = r.stdout && r.stdout.trim() ? JSON.parse(r.stdout.trim().split(/\r?\n/).pop()) : undefined;
} catch {
  verdict = undefined;
}
const reason = (verdict && (verdict.reason || verdict.message || verdict.error)) || (r.stderr || "").trim().slice(0, 300) || "sin detalle";

if (r.error) decide("deny", `${TAG} El verificador de aprobaciones falló (${r.error.code ?? r.error.message}). Bloqueado.`);
if (r.status !== 0) decide("deny", `${TAG} Lote ${batchId} sin aprobación humana válida: ${reason}. Apruébalo con tu passkey en la UI web.`);
if (!verdict || verdict.valid !== true) decide("deny", `${TAG} Lote ${batchId}: el verificador no confirmó la aprobación (${reason}).`);

pass();
