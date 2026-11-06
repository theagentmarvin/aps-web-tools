import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  convertDist,
  IngestError,
  mapClashStatus,
  normalizeClashTest,
  applyTriageState,
  triageStateIndex,
} from "../core/ingest";
import { fixtureBytes, fixtureJson, rawVersion, truth } from "./helpers";
import type { ModelSetView } from "../server/aps/types";

describe("normalizeClashTest on fixtures", () => {
  const v42 = rawVersion(42);
  const result = normalizeClashTest(v42, { documentVersions: v42.modelSetVersion.documentVersions });

  it("keeps every clash and every document (legacy §8.3 fix)", () => {
    expect(result.clashes).toHaveLength(truth().counts.v42);
    expect(result.documents).toHaveLength(8);
    expect(result.warnings).toEqual([]);
    const leftDocs = new Set(result.clashes.map((c) => c.left.documentId));
    expect(leftDocs.size).toBeGreaterThan(3);
  });

  it("keeps stable ids and viewer ids separately (legacy §8.2 fix)", () => {
    const rawInst = v42.instances.instances[0];
    const c = result.clashes.find((x) => x.id === String(rawInst.cid))!;
    expect(c.left).toEqual({ documentId: rawInst.ldid, objectId: rawInst.loid, viewerDbId: rawInst.lvid });
    expect(c.right).toEqual({ documentId: rawInst.rdid, objectId: rawInst.roid, viewerDbId: rawInst.rvid });
    expect(c.left.objectId).not.toBe(c.left.viewerDbId);
  });

  it("converts dist metres → signed mm with penetration and kind", () => {
    const raw = v42.clashes.clashes[0];
    const c = result.clashes.find((x) => x.id === String(raw.id))!;
    expect(c.rawDist).toBe(raw.dist);
    expect(c.distanceMm).toBeCloseTo(raw.dist * 1000, 3);
    expect(c.penetrationMm).toBeCloseTo(Math.max(0, -raw.dist * 1000), 3);
    expect(result.clashes.some((x) => x.kind === "clearance")).toBe(true);
    expect(result.clashes.filter((x) => x.kind === "hard").every((x) => x.penetrationMm > 0)).toBe(true);
  });

  it("matches documents by exact versionUrn and disambiguates viewables", () => {
    const san = result.documents.filter((d) => d.displayName === "PRJ-SAN-MOD-001.rvt");
    expect(san.map((d) => d.viewableName).sort()).toEqual(["Coordinación", "{3D}"]);
    expect(san[0].urn).toBe(san[1].urn);
    expect(san[0].viewableGuid).not.toBe(san[1].viewableGuid);
    expect(result.documents.every((d) => d.matchedModelSet && d.discipline === null)).toBe(true);
    // duplicated linked model: same file name, different lineage
    const est = result.documents.filter((d) => d.displayName === "PRJ-EST-MOD-001.rvt");
    expect(est).toHaveLength(2);
    expect(est[0].lineageUrn).not.toBe(est[1].lineageUrn);
  });

  it("builds the viewer URN as base64url(bubbleUrn) without padding", () => {
    const d = result.documents[0];
    const bubble = v42.modelSetVersion.documentVersions.find((x) => x.versionUrn === d.urn)!.bubbleUrn!;
    expect(d.viewerUrn).toBe(Buffer.from(bubble).toString("base64url"));
    expect(base64UrlEncode("Ñandú-é")).toBe(Buffer.from("Ñandú-é").toString("base64url"));
  });

  it("maps raw status (numbers and strings)", () => {
    expect(result.clashes.some((c) => c.status === "reviewed")).toBe(true);
    expect(result.clashes.some((c) => c.rawStatus === "New" && c.status === "active")).toBe(true);
  });

  it("parses gzipped variants identically", () => {
    const gz = JSON.parse(gunzipSync(fixtureBytes("mc/v42/scope-version-clash.json.gz")).toString("utf8"));
    expect(gz).toEqual(v42.clashes);
  });

  it("applies view filtering only when asked", () => {
    const view = fixtureJson<{ modelSetViews: ModelSetView[] }>("mc/modelset-views.json").modelSetViews[0];
    const filtered = normalizeClashTest(v42, {
      documentVersions: v42.modelSetVersion.documentVersions,
      viewFilter: { definition: view.definition },
    });
    expect(filtered.documents).toHaveLength(8); // documents are never dropped
    expect(filtered.stats.droppedByViewFilter).toBeGreaterThan(0);
    expect(filtered.clashes.length + filtered.stats.droppedByViewFilter).toBe(result.clashes.length);
    const either = normalizeClashTest(v42, {
      documentVersions: v42.modelSetVersion.documentVersions,
      viewFilter: { definition: view.definition, match: "either" },
    });
    expect(either.clashes.length).toBeGreaterThan(filtered.clashes.length);
    const noDv = normalizeClashTest(v42, { viewFilter: { definition: view.definition } });
    expect(noDv.clashes).toHaveLength(result.clashes.length);
    expect(noDv.warnings.map((w) => w.code)).toContain("view_filter_without_document_versions");
  });
});

describe("normalizeClashTest edge cases", () => {
  const docs = { documents: [{ id: 0, urn: "urn:a?version=1", viewableName: "{3D}" }, { id: 1, urn: "urn:b?version=2", viewableName: "{3D}" }] };

  it("warns on missing / orphan / duplicate instances and mismatched object ids", () => {
    const r = normalizeClashTest({
      clashes: [
        { id: 1, clash: [10, 20], dist: -0.01, status: 1 },
        { id: 2, clash: [11, 21], dist: -0.02, status: 1 },
        { id: 2, clash: [11, 21], dist: -0.02, status: 1 },
      ],
      instances: [
        { cid: 1, ldid: 0, rdid: 1, loid: 10, roid: 99, lvid: 5, rvid: 6 },
        { cid: 3, ldid: 0, rdid: 7, loid: 1, roid: 2, lvid: 3, rvid: 4 },
      ],
      documents: docs,
    });
    const codes = Object.fromEntries(r.warnings.map((w) => [w.code, w.count]));
    expect(codes).toMatchObject({ missing_instance: 1, orphan_instance: 1, duplicate_clash_id: 1, object_id_mismatch: 1 });
    expect(r.clashes.map((c) => c.id)).toEqual(["1"]);
  });

  it("throws on unsafe clash ids", () => {
    expect(() =>
      normalizeClashTest({ clashes: [{ id: 2 ** 53 + 2, clash: [1, 2], dist: 0, status: 1 }], instances: [], documents: docs }),
    ).toThrow(IngestError);
  });

  it("honours the dist unit and sign parameters", () => {
    expect(convertDist(-0.05)).toEqual({ distanceMm: -50, penetrationMm: 50, kind: "hard" });
    expect(convertDist(-50, "mm")).toEqual({ distanceMm: -50, penetrationMm: 50, kind: "hard" });
    expect(convertDist(0.1, "ft", "positive_is_penetration")).toEqual({ distanceMm: -30.48, penetrationMm: 30.48, kind: "hard" });
    expect(convertDist(0.01)).toEqual({ distanceMm: 10, penetrationMm: 0, kind: "clearance" });
    expect(convertDist(Number.NaN).kind).toBe("unknown");
  });

  it("maps status codes and labels", () => {
    expect([1, 2, 3, 4, 9, "New", "closed", "3", null].map(mapClashStatus)).toEqual([
      "active",
      "reviewed",
      "resolved",
      "closed",
      "unknown",
      "active",
      "closed",
      "resolved",
      "unknown",
    ]);
  });

  it("derives triage state from groups", () => {
    const r = normalizeClashTest({
      clashes: [1, 2, 3].map((id) => ({ id, clash: [id, id], dist: -0.01, status: 1 })),
      instances: [1, 2, 3].map((cid) => ({ cid, ldid: 0, rdid: 1, loid: cid, roid: cid, lvid: cid, rvid: cid })),
      documents: docs,
    });
    const idx = triageStateIndex([{ id: "a", existing: [1], resolved: [] }], [{ id: "c", existing: [2, 1] }]);
    expect(applyTriageState(r.clashes, idx).map((c) => c.triage)).toEqual(["assigned", "closed", "open"]);
  });
});
