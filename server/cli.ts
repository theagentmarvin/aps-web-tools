/**
 * Coordinator CLI: `npm run coordinator -- <command>`.
 *
 *   login                         APS 3-legged PKCE login (browser + loopback), caches the token
 *   logout                        forget the cached token
 *   status                        session / autonomy / pending counts
 *   ingest [testId] [--refresh] [--no-properties] [--project <id>] [--model-set <id>]
 *   classify [testKey] [--propose]
 *   approvals list                batches by state
 *   approve <batchId>             DEMO approval, fixtures mode only (interactive TTY; refused under Claude Code).
 *                                 Live approvals need a passkey (WebAuthn) in the web UI.
 *   passkey-enroll                one-time code to register the FIRST passkey (interactive TTY only)
 *   apply <batchId> [--no-dry-run]
 *   verify-approval <batchId> [--json]   read-only check used by the guard-apply hook
 *   setup [--check]               single human install step (TTY only, refused under Claude Code);
 *                                 --check is read-only and fails if the harness dev marker exists
 *
 * Data source: COORD_DATA_SOURCE=fixtures for offline mode.
 */
import "./net/system-ca"; // first: trust the OS certificate store (corporate HTTPS inspection)
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyApproved, approveBatch, verifyBatchApproval } from "./approval";
import { ApsAuth } from "./aps/auth";
import { coordinatorAuthConfig } from "./secure/aps-paths";
import { Coordinator } from "./coordinator";
import { CoordinatorUi } from "./coordinator-ui";
import { runSetup, setupCheck } from "./setup";
import { CoordError } from "./util";
import { FIXTURE_PROJECT_ID } from "./source/fixtures";

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}
function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function positional(args: string[]): string[] {
  const res: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (["--project", "--model-set", "--version"].includes(args[i])) i++;
      continue;
    }
    res.push(args[i]);
  }
  return res;
}

/** True when approval must be refused: non-interactive stdin or running under Claude Code. */
export function approvalChannelBlocked(env: NodeJS.ProcessEnv = process.env, isTTY: boolean = !!process.stdin.isTTY): string | undefined {
  if ("CLAUDECODE" in env) return "La aprobación no puede ejecutarse desde Claude Code (CLAUDECODE está definido). Ejecútala tú en tu propia terminal o usa la UI web.";
  if (!isTTY) return "La aprobación requiere una terminal interactiva (stdin no es TTY).";
  return undefined;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const json = flag(rest, "--json");

  if (cmd === "verify-approval") {
    // Read-only: never creates approvals, keys or batches.
    const batchId = positional(rest)[0];
    if (!batchId) {
      out(JSON.stringify({ valid: false, ok: false, reason: "missing_batch_id" }));
      return 1;
    }
    try {
      const coord = new Coordinator({ root });
      const v = await verifyBatchApproval(coord.approvalDeps(), batchId);
      if (!v.ok) {
        out(json ? JSON.stringify({ valid: false, ok: false, reason: v.reason, message: v.message }) : `NO VÁLIDA: ${v.reason} — ${v.message}`);
        return 1;
      }
      const proposalCount = v.approval.proposalIds.length;
      out(json ? JSON.stringify({ valid: true, ok: true, batchId, approvedBy: v.approval.approvedBy.name, expiresAt: v.approval.expiresAt, testVersion: v.approval.testVersion, itemCount: v.approval.itemIds.length, proposalCount }) : `VÁLIDA: ${batchId} aprobado por ${v.approval.approvedBy.name}, vence ${v.approval.expiresAt}`);
      return 0;
    } catch (e) {
      out(JSON.stringify({ valid: false, ok: false, reason: "error", message: (e as Error).message }));
      return 1;
    }
  }

  if (cmd === "setup") {
    const home = process.env.COORDINATOR_HOME;
    // --check: non-interactive and read-only (allowed anywhere, including under Claude Code).
    if (flag(rest, "--check")) return setupCheck(root, { out }, home);
    const blocked = approvalChannelBlocked();
    if (blocked) {
      err(blocked.replace("La aprobación", "La instalación (setup)"));
      return 2;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await runSetup({
        root,
        ...(home ? { home } : {}),
        io: { out, err, ask: (q) => rl.question(q) },
        audit: async (details) => {
          const c = new Coordinator({ root });
          await c.store.audit({ actor: { type: "user", id: `os:${userInfo().username}`, name: userInfo().username }, action: "harness.installed", details });
        },
      });
    } finally {
      rl.close();
    }
  }

  if (cmd === "login" || cmd === "logout") {
    // Same token file as the MCP server and the HTTP API (server/secure/aps-paths.ts).
    const auth = new ApsAuth({ config: coordinatorAuthConfig(root) });
    if (cmd === "logout") {
      await auth.logout();
      out("Sesión APS cerrada.");
      return 0;
    }
    const s = await auth.status();
    if (s.loggedIn && !flag(rest, "--force")) {
      out("Ya hay una sesión APS en caché (usa --force para iniciar otra).");
      return 0;
    }
    const st = await auth.loginInteractive({ onUrl: (u) => err(`Abre en el navegador si no se abrió solo:\n${u}`) });
    out(`Sesión iniciada. Vence: ${st.expiresAt ? new Date(st.expiresAt).toISOString() : "?"}`);
    return 0;
  }

  const coord = new Coordinator({ root });
  const ui = new CoordinatorUi(coord);
  const human = async () => {
    const u = await ui.currentUser();
    if (!u) throw new CoordError("not_authenticated", "Inicia sesión (npm run coordinator -- login) o configura approver.name en coordinator.config.local.json.");
    return u;
  };

  switch (cmd) {
    case "status": {
      if (flag(rest, "--json")) {
        // Cheap, offline (reads the token cache only), for hooks. Never prints tokens or paths.
        const s = await coord.source.authStatus().catch(() => ({ loggedIn: false }));
        out(JSON.stringify({ loggedIn: s.loggedIn, dataSource: coord.source.kind, ...("expiresAt" in s && s.expiresAt ? { expiresAt: new Date(s.expiresAt).toISOString() } : {}), autonomyLevel: coord.effectiveLevel }));
        return 0;
      }
      out(JSON.stringify(await coord.sessionStatus(), null, 2));
      return 0;
    }
    case "ingest": {
      // Fixtures mode (evals): the demo project when none is given or active.
      const project = opt(rest, "--project") ?? (coord.source.kind === "fixtures" && !(await coord.store.getContext())?.projectId ? FIXTURE_PROJECT_ID : undefined);
      const modelSet = opt(rest, "--model-set");
      const version = opt(rest, "--version");
      let testId = positional(rest)[0];
      if (!testId) {
        const t = await coord.listClashTests({ projectId: project, modelSetId: modelSet });
        const row = version ? t.rows.find((r) => Number(r[2]) === Number(version)) : t.rows[0];
        testId = String(row?.[0] ?? "");
        if (!testId) throw new CoordError("not_found", version ? `No hay clash test para la versión ${version}.` : "No hay clash tests.");
      }
      const u = await ui.currentUser();
      const r = await coord.ingest(
        { projectId: project, modelSetId: modelSet, testId, refresh: flag(rest, "--refresh"), fetchProperties: !flag(rest, "--no-properties") },
        { actor: { type: "user", id: u?.id ?? "cli", name: u?.name ?? "CLI" } },
        (step, d, t) => err(`  ${step} ${d}/${t}`),
      );
      out(JSON.stringify(r, null, 2));
      return 0;
    }
    case "classify": {
      const u = await ui.currentUser();
      const r = await coord.classify({ testKey: positional(rest)[0], proposeAutoAccepted: flag(rest, "--propose") }, { actor: { type: "user", id: u?.id ?? "cli", name: u?.name ?? "CLI" } });
      out(JSON.stringify(r, null, 2));
      return 0;
    }
    case "approvals": {
      if (positional(rest)[0] !== "list") throw new CoordError("validation_error", "Uso: approvals list");
      const list = await ui.listBatches();
      if (!list.length) out("Sin lotes.");
      for (const b of list) out(`${b.id}  ${b.state.padEnd(9)}  ${b.projectName} / ${b.modelSetName} v${b.modelSetVersion}  issues=${b.counts.issuesCreate} estados=${b.counts.statusChanges}${b.approval ? `  aprobado por ${b.approval.approvedBy} (${b.approval.valid ? "válida" : b.approval.reason})` : ""}`);
      return 0;
    }
    case "approve": {
      const blocked = approvalChannelBlocked();
      if (blocked) {
        err(blocked);
        return 2;
      }
      if (coord.source.kind !== "fixtures") {
        err("En modo live la aprobación exige tu passkey (WebAuthn): apruébalo en la UI web (/aprobaciones). La CLI solo aprueba lotes de demostración en modo fixtures.");
        return 2;
      }
      const batchId = positional(rest)[0];
      if (!batchId) throw new CoordError("validation_error", "Uso: approve <batchId>");
      const b = await ui.getBatch(batchId);
      const user = await human();
      out(`Lote ${b.id} · ${b.projectName} / ${b.modelSetName} · prueba v${b.modelSetVersion} (vigente v${b.latestVersion})`);
      out(`  Incidencias a crear: ${b.counts.issuesCreate} (irreversible)`);
      out(`  Interferencias que cambian de estado: ${b.counts.statusChanges}`);
      for (const i of b.items.filter((x) => !x.excluded).slice(0, 30)) out(`   - ${i.operation.padEnd(16)} ${i.label.slice(0, 80)} (${i.targetIds.length})`);
      if (b.items.filter((x) => !x.excluded).length > 30) out("   …");
      out(`Aprobador: ${user.name}`);
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const typed = (await rl.question(`Para aprobar, escribe el id del lote (${b.id}): `)).trim();
      rl.close();
      if (typed !== b.id) {
        err("No coincide. Aprobación cancelada.");
        return 1;
      }
      const r = await approveBatch(coord.approvalDeps(), batchId, { id: user.id, name: user.name, channel: "cli" }, { demo: true });
      out(`Aprobado. Vence ${r.approval.expiresAt}. Aplica con: npm run coordinator -- apply ${batchId} (dry-run) y luego --no-dry-run.`);
      return 0;
    }
    case "passkey-enroll": {
      // First passkey only: prints a one-time code typed into the browser registration page.
      const blocked = approvalChannelBlocked();
      if (blocked) {
        err(blocked);
        return 2;
      }
      const { code, expiresAt } = await coord.webauthn.createEnrollCode();
      await coord.store.audit({ actor: { type: "user", id: "cli", name: "CLI (TTY)" }, action: "webauthn.enroll_code_issued", details: { expiresAt } });
      out(`Código de enrolamiento (un solo uso, vence ${expiresAt}): ${code}`);
      out("Ábrelo en la UI web → Ajustes → Passkey y escríbelo para registrar tu passkey (Windows Hello).");
      return 0;
    }
    case "apply": {
      const batchId = positional(rest)[0];
      if (!batchId) throw new CoordError("validation_error", "Uso: apply <batchId> [--no-dry-run]");
      const u = await human();
      const r = await applyApproved(coord.approvalDeps(), batchId, { dryRun: !flag(rest, "--no-dry-run"), actor: { type: "user", id: u.id, name: u.name } });
      out(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case "seed-meeting-notes": {
      // Evals only (fixtures mode): seed meeting notes on the classified fixture test.
      if (coord.source.kind !== "fixtures") throw new CoordError("forbidden", "seed-meeting-notes solo funciona con COORD_DATA_SOURCE=fixtures.");
      const file = positional(rest)[0];
      if (!file) throw new CoordError("validation_error", "Uso: seed-meeting-notes <archivo.json>");
      const { readFile } = await import("node:fs/promises");
      const spec = JSON.parse(await readFile(resolve(root, file), "utf8")) as { notes: Array<{ id: string; target: { validity: string; rank: number } | { familyId: string }; text: string }> };
      const { test, views } = await coord.familyViewsFor(opt(rest, "--test") ?? (await coord.store.getContext())?.testKey);
      const ranked = (validity: string) =>
        views
          .filter((f) => f.proposed.validity === validity)
          .sort((a, b) => a.proposed.band - b.proposed.band || b.instanceCount - a.instanceCount || b.uniqueClashCount - a.uniqueClashCount || (a.id < b.id ? -1 : 1));
      const seeded: Array<{ id: string; familyId: string }> = [];
      for (const n of spec.notes) {
        const familyId = "familyId" in n.target ? n.target.familyId : ranked(n.target.validity)[n.target.rank - 1]?.id;
        if (!familyId) throw new CoordError("not_found", `Nota ${n.id}: no hay familia ${JSON.stringify(n.target)}`);
        await coord.putMeetingNote(test.testKey, "family", familyId, n.text, { id: "seed", name: "seed" });
        seeded.push({ id: n.id, familyId });
      }
      out(JSON.stringify({ testKey: test.testKey, seeded }, null, 2));
      return 0;
    }
    default:
      out("Comandos: login | logout | status | ingest [testId] [--version N] | classify [testKey] [--propose] | seed-meeting-notes <file> (fixtures) | approvals list | approve <batchId> (fixtures) | passkey-enroll | apply <batchId> [--no-dry-run] | verify-approval <batchId> [--json]");
      return cmd ? 1 : 0;
  }
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      err(`Error: ${(e as Error).message}${e instanceof CoordError && e.hint ? `\n${e.hint}` : ""}`);
      process.exit(1);
    });
}

