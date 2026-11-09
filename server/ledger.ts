/**
 * Persistence of the per-model-set clash ledger (core/ingest/ledger.ts, pure).
 *
 *   .coordinator/ledgers/<projectId>/<modelSetId>.json   ClashLedger (schema 1)
 *
 * Coordinator.ingest calls {@link LedgerService.diffAndRecord} for every ingest
 * that has a previous cached version: `diffWithLedger` uses ALL recorded older
 * versions as history (reappeared detection), records both versions and the
 * result is persisted. Re-ingesting the same versions is idempotent (the core
 * strips and re-records a version).
 *
 * Fixtures mode seeds a new ledger once with tests/fixtures/mc/history-v40-clash-ids.json
 * (version 40), so v41 → v42 shows the regressions the fixtures were built with.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyAccSnapshot, diffWithLedger, emptyLedger, parseLedger, updateLedger, type AccSnapshot, type ClashLedger, type LedgerVersion } from "../core/ingest/ledger";
import type { DiffableClash } from "../core/ingest/diff";
import type { ClashDiff } from "../core/types";
import { readJsonFile, writeJsonAtomic } from "./store/fs";
import type { Store } from "./store";
import { bareProjectId } from "./util";

const seg = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

export class LedgerService {
  constructor(
    private readonly store: Store,
    /** Optional seed for a brand-new ledger (fixtures mode). */
    private readonly seed?: (modelSetId: string) => Promise<ClashLedger | undefined>,
  ) {}

  path(projectId: string, modelSetId: string): string {
    return this.store.path("ledgers", seg(bareProjectId(projectId)), `${seg(modelSetId)}.json`);
  }

  async load(projectId: string, modelSetId: string): Promise<ClashLedger | undefined> {
    const raw = await readJsonFile<unknown>(this.path(projectId, modelSetId));
    return raw === undefined ? undefined : parseLedger(raw);
  }

  async save(projectId: string, ledger: ClashLedger): Promise<void> {
    await this.store.withLock(() => writeJsonAtomic(this.path(projectId, ledger.modelSetId), ledger));
  }

  /** Load (or seed) → transform → persist, under the store lock. */
  async withLedger(projectId: string, modelSetId: string, fn: (l: ClashLedger) => ClashLedger): Promise<ClashLedger> {
    return this.store.withLock(async () => {
      const current = (await this.load(projectId, modelSetId)) ?? (await this.seed?.(modelSetId)) ?? emptyLedger(modelSetId);
      const next = fn(current);
      await writeJsonAtomic(this.path(projectId, modelSetId), next);
      return next;
    });
  }

  /** Diff prev → next with the ledger as history, persist the updated ledger, return the diff. */
  async diffAndRecord<T extends DiffableClash>(
    projectId: string,
    modelSetId: string,
    prev: { version: number; clashes: readonly T[] },
    next: { version: number; clashes: readonly T[] },
    nextElementKeys?: Iterable<string>,
    outOfScope?: (prevClash: DiffableClash) => boolean,
  ): Promise<ClashDiff> {
    return this.store.withLock(async () => {
      const current = (await this.load(projectId, modelSetId)) ?? (await this.seed?.(modelSetId)) ?? emptyLedger(modelSetId);
      const { diff, ledger } = diffWithLedger(current, prev, next, { ...(nextElementKeys ? { nextElementKeys } : {}), ...(outOfScope ? { outOfScope } : {}) });
      await writeJsonAtomic(this.path(projectId, modelSetId), ledger);
      return diff;
    });
  }
}

export interface AccSyncResult {
  ledger: ClashLedger;
}

/** X1: record what ACC says for one version (the version is recorded first when missing). */
export async function recordAccInLedger<T extends DiffableClash>(
  svc: LedgerService,
  projectId: string,
  modelSetId: string,
  version: LedgerVersion<T>,
  snap: AccSnapshot,
): Promise<ClashLedger> {
  return svc.withLedger(projectId, modelSetId, (l) => {
    const base = l.versions.includes(version.version) ? l : updateLedger(l, version);
    // Phase-2 clashes carry pairKeys that a phase-1 record lacked: fill them in.
    for (const c of version.clashes) {
      const e = base.entries[c.id];
      if (e && c.pairKey && !e.pairKey) e.pairKey = c.pairKey;
    }
    return applyAccSnapshot(base, snap, version.clashes.map((c) => c.id));
  });
}

/** Fixtures-only seed: version 40 from tests/fixtures/mc/history-v40-clash-ids.json. */
export function fixtureLedgerSeed(fixtureDir: string): (modelSetId: string) => Promise<ClashLedger | undefined> {
  return async (modelSetId) => {
    let ids: string[];
    try {
      ids = JSON.parse(await readFile(join(fixtureDir, "mc", "history-v40-clash-ids.json"), "utf8")) as string[];
    } catch {
      return undefined;
    }
    return updateLedger(emptyLedger(modelSetId), { version: 40, clashes: ids.map((id) => ({ id: String(id) })) });
  };
}
