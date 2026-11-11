/**
 * Agent harness update from the web UI (human-only, passkey).
 *
 * `harness-staging/` holds the reviewed agent prompts, skills and hooks; the active copy lives in
 * `.claude/` + `CLAUDE.md`. The CLI `npm run setup` installs it (TTY only, refused under Claude
 * Code). This service is the same install, reachable ONLY through the HTTP routes
 * `GET /harness/status`, `GET /harness/diff`, `GET /harness/install-options` and
 * `POST /harness/install` (server/api/router.ts). There is NO MCP tool and no chat tool for it.
 *
 * Install guards (in this order):
 *  1. refused when the server process itself was started by an agent (CLAUDECODE in its env —
 *     the same signal the CLI refuses on): the human channel is a server the human started;
 *  2. (router) exact Host, exact Origin, Sec-Fetch-Site same-origin, CSRF header + cookie;
 *  3. a fresh user-verified WebAuthn assertion over a challenge bound to the exact files
 *     (staged hash ← installed hash of every file written): what the human reviewed is what
 *     gets written, and a changed staging or `.claude/` invalidates the challenge;
 *  4. the staged hooks pass tests/hooks.test.ts (as in setup);
 *  5. previous files are backed up into `<data home>/backups/harness-<stamp>/`, every written
 *     file is re-hashed (rollback on mismatch) and an HMAC-chained `harness.installed` audit
 *     event is appended.
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Coordinator } from "./coordinator";
import {
  harnessBackupName,
  harnessChanges,
  harnessDiff,
  harnessPayloadHash,
  harnessPlan,
  installHarnessFiles,
  STAGED_HOOKS_DIR,
  stagedHooksNeedTest,
  type HarnessFileState,
} from "./setup";
import { withFileLock } from "./store/fs";
import { CoordError } from "./util";

export interface HarnessStatus {
  upToDate: boolean;
  /** False when the repository has no harness-staging/ (nothing to install). */
  staging: boolean;
  files: Array<{ path: string; state: HarnessFileState }>;
  /** Staged files that would never be installed (outside .claude/ and CLAUDE.md). */
  refused: string[];
  stagedVersion: string | null;
  installedVersion: string | null;
  /** The server was started by an agent: install is refused (start it with Coordinador BIM.cmd). */
  installBlocked: boolean;
}

export interface HarnessInstallProof {
  webauthn?: { nonce: string; origin: string; response: unknown };
}

export interface HarnessInstallOutcome {
  installed: string[];
  backup: string | null;
  stagedVersion: string;
  installedAt: string;
}

/** WebAuthn "batch" id of the harness install ceremony (challenge namespace). */
export const HARNESS_CEREMONY_ID = "harness-install";

/** Same signal the CLI refuses on (server/cli.ts approvalChannelBlocked). */
export function agentStartedServer(env: NodeJS.ProcessEnv): boolean {
  return "CLAUDECODE" in env;
}

function runStagedHookTestsAsync(root: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vitest", "run", "tests/hooks.test.ts"], {
      cwd: root,
      stdio: "ignore",
      shell: process.platform === "win32",
      env: { ...process.env, HOOKS_DIR: STAGED_HOOKS_DIR },
      windowsHide: true,
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export interface HarnessInstallerOptions {
  /** Repository root holding harness-staging/ and .claude/ (default: coord.root). */
  root?: string;
  /** Environment of the server process (tests inject one without CLAUDECODE). */
  env?: NodeJS.ProcessEnv;
  /** Staged hook tests (default: `npx vitest run tests/hooks.test.ts` with HOOKS_DIR). */
  runStagedHookTests?: (root: string) => Promise<number>;
}

export class HarnessInstaller {
  readonly root: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runTests: (root: string) => Promise<number>;

  constructor(
    private readonly coord: Coordinator,
    opts: HarnessInstallerOptions = {},
  ) {
    this.root = opts.root ?? coord.root;
    this.env = opts.env ?? process.env;
    this.runTests = opts.runStagedHookTests ?? runStagedHookTestsAsync;
  }

  status(): HarnessStatus {
    const plan = harnessPlan(this.root);
    const installBlocked = agentStartedServer(this.env);
    if (!plan) return { upToDate: true, staging: false, files: [], refused: [], stagedVersion: null, installedVersion: null, installBlocked };
    return {
      upToDate: harnessChanges(plan).length === 0,
      staging: true,
      files: plan.files.map((f) => ({ path: f.path, state: f.state })),
      refused: plan.refused,
      stagedVersion: plan.stagedVersion,
      installedVersion: plan.installedVersion,
      installBlocked,
    };
  }

  diff(path: string): { path: string; diff: string; truncated: boolean } {
    try {
      return harnessDiff(this.root, path);
    } catch {
      throw new CoordError("not_found", `harness-staging/${path} no existe o no es instalable.`);
    }
  }

  private refuseAgentServer(): void {
    if (agentStartedServer(this.env)) {
      throw new CoordError(
        "forbidden",
        "Este servidor fue iniciado por un agente (Claude Code): la actualización del agente no se instala desde aquí.",
        "Cierra este servidor y abre la app con «Coordinador BIM.cmd» (o npm run dev en tu propia terminal).",
      );
    }
  }

  private plan() {
    const plan = harnessPlan(this.root);
    if (!plan || !harnessChanges(plan).length) throw new CoordError("invalid_state", "El agente ya está al día: no hay nada que instalar.");
    return plan;
  }

  /** Step 1: WebAuthn options whose challenge is bound to exactly the files that will be written. */
  async options(): Promise<{ nonce: string; options: unknown; payloadHash: string }> {
    this.refuseAgentServer();
    const payloadHash = harnessPayloadHash(this.plan());
    const { nonce, options } = await this.coord.webauthn.approvalOptions(HARNESS_CEREMONY_ID, payloadHash, 0);
    return { nonce, options, payloadHash };
  }

  /** Step 2: verify the passkey, test the staged hooks, back up, install, verify, audit. */
  async install(proof: HarnessInstallProof, user: { id: string; name: string }): Promise<HarnessInstallOutcome> {
    this.refuseAgentServer();
    if (!proof.webauthn) throw new CoordError("approval_missing", "Instalar la actualización del agente requiere confirmar con tu passkey (Windows Hello).");
    return withFileLock(
      this.coord.store.path("state", "harness-install.lock"),
      async () => {
        const plan = this.plan();
        const payloadHash = harnessPayloadHash(plan);
        const a = await this.coord.webauthn.verifyApproval({
          batchId: HARNESS_CEREMONY_ID,
          payloadHash,
          testVersion: 0,
          nonce: proof.webauthn!.nonce,
          origin: proof.webauthn!.origin,
          response: proof.webauthn!.response as never,
        });
        if (stagedHooksNeedTest(this.root, plan) && (await this.runTests(this.root)) !== 0) {
          throw new CoordError("validation_error", "Las pruebas de los hooks de la versión nueva fallaron: no se instaló nada.", "Avisa a quien mantiene el agente (npm test en el repositorio).");
        }
        const at = this.coord.now();
        let r;
        try {
          r = installHarnessFiles(this.root, plan, { backupDir: this.coord.store.path("backups", harnessBackupName(at)) });
        } catch (err) {
          throw new CoordError("conflict", `No se instaló la actualización: ${(err as Error).message}`);
        }
        const backup = r.backupDir ? basename(r.backupDir) : null;
        await this.coord.store.audit({
          actor: { type: "user", id: user.id, name: user.name },
          action: "harness.installed",
          details: { files: r.installed.length, hashes: JSON.stringify(r.hashes), channel: "web-ui", proof: "webauthn", credentialId: a.credentialId, payloadHash, stagedVersion: plan.stagedVersion, backup },
        });
        return { installed: r.installed, backup, stagedVersion: plan.stagedVersion, installedAt: new Date(at).toISOString() };
      },
      { staleMs: 120_000, timeoutMs: 10_000 },
    );
  }
}
