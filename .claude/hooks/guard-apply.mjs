// PreToolUse guard for mcp__coord__apply_approved_proposals (the ONLY ACC write path).
// Defence in depth: the MCP server re-checks everything. This hook FAILS CLOSED:
// any parse error, missing verifier or non-zero verifier exit -> deny.
//
// Checks, in order:
//  1. hook input parses, tool is the apply tool
//  2. caller is the main agent (never a subagent)
//  3. autonomy level >= 1 (coordinator.config.json / .local.json; invalid JSON -> deny)
//  4. input names a batch (`batchId`), with a safe id format
//  5. dryRun (default true) -> no decision (the settings `ask` rule still prompts the human)
//  6. real apply -> `tsx server/cli.ts verify-approval <batchId> --json` must exit 0
//     (and must not report {"valid": false}); otherwise deny with the verifier's reason
// On success the hook returns NO decision, so the permission `ask` rule always prompts the human.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readInput, projectRoot, decide, pass, block, isSubagent, loadConfig, TAG } from "./_lib.mjs";

const APPLY_TOOL = "mcp__coord__apply_approved_proposals";
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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
if ((cfg.autonomy?.level ?? 1) < 1) {
  decide("deny", `${TAG} Nivel de autonomía L0 (solo lectura): no se aplican cambios en ACC.`);
}

const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
const batchId = ti.batchId;
if (typeof batchId !== "string" || !BATCH_ID.test(batchId)) {
  decide(
    "deny",
    `${TAG} Aplicar requiere un lote (batchId) aprobado por un humano en la UI web (/aprobaciones). ` +
      `No se aplican propuestas sueltas.`,
  );
}

const dryRun = ti.dryRun !== false; // contract default: true
if (dryRun) pass();

const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const cli = join(root, "server", "cli.ts");
if (!existsSync(tsxCli) || !existsSync(cli)) {
  decide("deny", `${TAG} No se encontró el verificador de aprobaciones (tsx o server/cli.ts). Bloqueado por seguridad.`);
}

// No shell: argv array, so batchId cannot inject commands (also constrained by BATCH_ID).
const r = spawnSync(process.execPath, [tsxCli, cli, "verify-approval", batchId, "--json"], {
  cwd: root,
  encoding: "utf8",
  timeout: 20000,
  windowsHide: true,
  env: { ...process.env, COORD_VERIFY_CALLER: "guard-apply-hook" },
});

let verdict;
try {
  verdict = r.stdout && r.stdout.trim() ? JSON.parse(r.stdout.trim().split(/\r?\n/).pop()) : undefined;
} catch {
  verdict = undefined;
}
const reason = (verdict && (verdict.reason || verdict.error)) || (r.stderr || "").trim().slice(0, 300) || "sin detalle";

if (r.error) {
  decide("deny", `${TAG} El verificador de aprobaciones falló (${r.error.code ?? r.error.message}). Bloqueado.`);
}
if (r.status !== 0) {
  decide("deny", `${TAG} Lote ${batchId} sin aprobación humana válida: ${reason}. Pide al coordinador aprobarlo en la UI web.`);
}
if (verdict && verdict.valid === false) {
  decide("deny", `${TAG} Lote ${batchId} rechazado por el verificador: ${reason}.`);
}

// Valid approval: no decision here; the `ask` permission rule makes the human confirm in the terminal.
pass();
