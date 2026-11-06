import { describe, expect, it } from "vitest";
import {
  attachPairKeys,
  diffStateIndex,
  diffTestVersions,
  elementLookupFromTables,
  normalizeClashTest,
  pairKeyOf,
} from "../core/ingest";
import { elementTables, fixtureJson, rawVersion, truth } from "./helpers";

function ingest(v: 41 | 42) {
  const raw = rawVersion(v);
  const r = normalizeClashTest(raw, { documentVersions: raw.modelSetVersion.documentVersions });
  const { tables, externalIds } = elementTables(v);
  return { clashes: attachPairKeys(r.clashes, r.documents, elementLookupFromTables(tables)), externalIds };
}

describe("diffTestVersions on fixtures (v41 → v42)", () => {
  const prev = ingest(41);
  const next = ingest(42);
  const history = fixtureJson<string[]>("mc/history-v40-clash-ids.json");
  const diff = diffTestVersions(prev.clashes, next.clashes, { history, nextElementKeys: next.externalIds });
  const expected = truth().expectedDiff;

  it("every clash gets a pairKey from index rows", () => {
    expect(prev.clashes.every((c) => c.pairKey)).toBe(true);
    expect(next.clashes.every((c) => c.pairKey)).toBe(true);
  });

  it("matches the generator truth", () => {
    expect(diff.new).toEqual(expected.new);
    expect(diff.persisting).toEqual(expected.persisting);
    expect(diff.resolved).toEqual(expected.resolved);
    expect(diff.element_deleted).toEqual(expected.element_deleted);
    expect(diff.reappeared).toEqual(expected.reappeared);
    expect(diff.matchedByPairKey.map(({ prevId, nextId }) => ({ prevId, nextId })).sort((a, b) => a.prevId.localeCompare(b.prevId))).toEqual(
      [...expected.matchedByPairKey].sort((a, b) => a.prevId.localeCompare(b.prevId)),
    );
    expect(diff.counts).toEqual({ new: 70, persisting: 220, resolved: 65, element_deleted: 15, reappeared: 13 });
  });

  it("without element keys, deletions fall back to resolved", () => {
    const d = diffTestVersions(prev.clashes, next.clashes, { history });
    expect(d.counts.element_deleted).toBe(0);
    expect(d.counts.resolved).toBe(80);
  });

  it("indexes states by id", () => {
    const idx = diffStateIndex(diff);
    expect(idx.get(expected.new[0])).toBe("new");
    expect(idx.get(expected.element_deleted[0])).toBe("element_deleted");
  });
});

describe("diffTestVersions units", () => {
  it("prefers id, then pairKey, then history", () => {
    const prev = [
      { id: "1", pairKey: "a|b" },
      { id: "2", pairKey: "c|d" },
      { id: "3", pairKey: "e|f" },
    ];
    const next = [
      { id: "1", pairKey: "x|y" }, // same id, pairKey changed → persisting by id
      { id: "20", pairKey: "c|d" }, // id changed → persisting by pairKey
      { id: "9", pairKey: "g|h" }, // in history by pairKey → reappeared
      { id: "10" }, // no pairKey → new
    ];
    const d = diffTestVersions(prev, next, { history: ["g|h"], nextElementKeys: ["a", "b", "c", "d", "e"] });
    expect(d.persisting).toEqual(["1", "20"]);
    expect(d.matchedByPairKey).toEqual([{ prevId: "2", nextId: "20", pairKey: "c|d" }]);
    expect(d.reappeared).toEqual(["9"]);
    expect(d.new).toEqual(["10"]);
    expect(d.element_deleted).toEqual(["3"]); // "f" is gone
    expect(d.resolved).toEqual([]);
  });

  it("pairKeyOf is order independent", () => {
    expect(pairKeyOf("b", "a")).toBe(pairKeyOf("a", "b"));
  });
});
