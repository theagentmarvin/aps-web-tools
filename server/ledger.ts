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
import { diffWithLedger, emptyLedger, parseLedger, updateLedger, type ClashLedger } from "../core/ingest/ledger";
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

  /** Diff prev → next with the ledger as history, persist the updated ledger, return the diff. */
  async diffAndRecord<T extends DiffableClash>(
    projectId: string,
    modelSetId: string,
    prev: { version: number; clashes: readonly T[] },
    next: { version: number; clashes: readonly T[] },
    nextElementKeys?: Iterable<string>,
  ): Promise<ClashDiff> {
    return this.store.withLock(async () => {
      const current = (await this.load(projectId, modelSetId)) ?? (await this.seed?.(modelSetId)) ?? emptyLedger(modelSetId);
      const { diff, ledger } = diffWithLedger(current, prev, next, nextElementKeys ? { nextElementKeys } : {});
      await writeJsonAtomic(this.path(projectId, modelSetId), ledger);
      return diff;
    });
  }
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
