/**
 * Persistence for the per-model-set "reappeared" ledger (store side).
 *
 * The ledger logic is pure and lives in core (coder B: `core/ingest/ledger.ts`,
 * `updateLedger(ledger, diff)`). This module only stores it:
 *   .coordinator/ledgers/<projectId>/<modelSetId>.json
 *     { meta: { appliedVersions: number[], updatedAt, lastTestKey }, ledger: <B's shape> }
 * and is called by Coordinator.ingest after each diff against the previous
 * cached version. Re-ingesting a version already applied is a no-op.
 *
 * WIRING: once core/ingest/ledger.ts exists, replace the body of
 * {@link DEFAULT_LEDGER_UPDATER} with one line:
 *     export const DEFAULT_LEDGER_UPDATER: LedgerUpdater | undefined = (l, d) => updateLedger(l as never, d);
 * (plus the import). Until then no ledger is written.
 */
import type { ClashDiff } from "../core/types";
import { readJsonFile, writeJsonAtomic } from "./store/fs";
import type { Store } from "./store";
import { bareProjectId, nowIso } from "./util";

export interface LedgerMeta {
  appliedVersions: number[];
  lastTestKey: string;
  updatedAt: string;
}

export interface LedgerFile<L = unknown> {
  meta: LedgerMeta;
  ledger: L;
}

/** Pure update step (B's `updateLedger`). `ledger` is undefined for the first diff of a model set. */
export type LedgerUpdater<L = unknown> = (ledger: L | undefined, diff: ClashDiff, ctx: { version: number; testKey: string }) => L;

/** The updater used in production. Undefined until core/ingest/ledger.ts lands (see header). */
export const DEFAULT_LEDGER_UPDATER: LedgerUpdater | undefined = undefined;

export interface LedgerStore {
  load<L = unknown>(projectId: string, modelSetId: string): Promise<LedgerFile<L> | undefined>;
  /** Apply `diff` for `version` (idempotent per version). Returns false when skipped. */
  apply(projectId: string, modelSetId: string, version: number, testKey: string, diff: ClashDiff): Promise<boolean>;
}

export class FileLedgerStore implements LedgerStore {
  constructor(
    private readonly store: Store,
    private readonly updater: LedgerUpdater | undefined = DEFAULT_LEDGER_UPDATER,
  ) {}

  path(projectId: string, modelSetId: string): string {
    return this.store.path("ledgers", bareProjectId(projectId).replace(/[^A-Za-z0-9._-]/g, "_"), `${modelSetId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  async load<L = unknown>(projectId: string, modelSetId: string): Promise<LedgerFile<L> | undefined> {
    return readJsonFile<LedgerFile<L>>(this.path(projectId, modelSetId));
  }

  async apply(projectId: string, modelSetId: string, version: number, testKey: string, diff: ClashDiff): Promise<boolean> {
    if (!this.updater) return false;
    const updater = this.updater;
    return this.store.withLock(async () => {
      const cur = await this.load(projectId, modelSetId);
      if (cur?.meta.appliedVersions.includes(version)) return false;
      const ledger = updater(cur?.ledger, diff, { version, testKey });
      const next: LedgerFile = {
        meta: { appliedVersions: [...(cur?.meta.appliedVersions ?? []), version].sort((a, b) => a - b), lastTestKey: testKey, updatedAt: nowIso(this.store.now()) },
        ledger,
      };
      await writeJsonAtomic(this.path(projectId, modelSetId), next);
      return true;
    });
  }
}
