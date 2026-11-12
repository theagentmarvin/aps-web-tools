import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ensureIndexes,
  fetchElementProps,
  getIndexFields,
  loadPropertyAliases,
  lmvIdQuery,
  parsePropertyAliases,
  resolveManifestViewId,
  verifyIdMapping,
} from "../server/aps/index-properties";
import { FieldDictionary, mapIndexRow, parseLengthUom, toMillimetres } from "../server/aps/property-mapping";
import { parseNdjson } from "../server/aps/download";
import type { IndexRow } from "../server/aps/types";
import type { ElementProps } from "../core/types";
import { aliasConfig, bytes, elementTables, fields, fixtureBytes, json, mockFetch, rawVersion, ROOT, testCtx, truth } from "./helpers";

const rows = (rel: string): IndexRow[] => parseNdjson<IndexRow>(fixtureBytes(rel).toString("utf8"));
const dict = new FieldDictionary(fields());
const config = aliasConfig();

describe("property aliases file", () => {
  it("loads rules/property-aliases.yaml", async () => {
    const cfg = await loadPropertyAliases(undefined, ROOT);
    expect(cfg.aliases.level).toContain("Nivel de referencia");
    expect(cfg.aliases.systemClassification).toContain("Clasificación de sistema");
    expect(cfg.aliases.systemType).toContain("Tipo de sistema");
    expect(cfg.bboxUnit).toBe("ft");
  });

  it("fails closed on an invalid file", () => {
    expect(() => parsePropertyAliases("version: 2\naliases: {}")).toThrow(/property-aliases/);
  });
});

describe("Index row → ElementProps", () => {
  it("maps a Spanish duct with system, level, sizes and bbox in metres", () => {
    const row = rows("index/properties/CLI-r4.ndjson")[0];
    const e = mapIndexRow(row, dict, config, { documentId: 2, modelFile: "urn:lineage", documentName: "PRJ-CLI-MOD-001.rvt" });
    expect(e).toMatchObject({
      documentId: 2,
      modelFile: "urn:lineage",
      documentName: "PRJ-CLI-MOD-001.rvt",
      lmvId: row.lmvId,
      externalId: row.externalId,
      category: "Conductos",
      family: "Conducto rectangular",
      level: "Nivel -1",
      systemClassification: "Aire de escape",
      systemType: "Extracción baños",
      system: "EXT-4",
      widthMm: 600,
      heightMm: 400,
      size: "600x400",
      insulationThicknessMm: 25,
      workset: "CLI-Conductos",
      phaseCreated: "Nueva construcción",
    });
    expect(e.elementId).toMatch(/^\d+$/);
    expect(e.bbox!.min.x).toBeCloseTo(row.bboxMin!.x * 0.3048, 5);
    expect(e.raw["Mecánico/Tipo de sistema"]).toBe("Extracción baños");
  });

  it("maps pipes, insulation, sleeves, slabs, beams and sprinklers", () => {
    const san = rows("index/properties/SAN-r5.ndjson").map((r) => mapIndexRow(r, dict, config));
    const pipe = san.find((e) => e.category === "Tuberías")!;
    expect(pipe.diameterMm).toBeGreaterThan(0);
    expect(pipe.outsideDiameterMm).toBeCloseTo(pipe.diameterMm! + 2.2, 5);
    expect(pipe.level).toMatch(/^Nivel/);
    const ins = san.find((e) => e.category === "Aislamientos de tuberías")!;
    expect(ins.insulationThicknessMm).toBeGreaterThan(0);
    const sleeve = san.find((e) => e.family === "Pasada PVC")!;
    expect(sleeve.level).toMatch(/^Nivel/); // via "Nivel"
    expect(sleeve.mark).toMatch(/^PAS-/);

    const est = rows("index/properties/EST-r5.ndjson").map((r) => mapIndexRow(r, dict, config));
    const slab = est.find((e) => e.category === "Suelos")!;
    expect(slab.thicknessMm).toBeGreaterThan(100);
    expect(slab.structural).toBe(true);
    const beam = est.find((e) => e.category === "Armazón estructural")!;
    expect(beam.widthMm).toBeGreaterThan(0);
    expect(beam.heightMm).toBeGreaterThan(beam.widthMm!);
    expect(beam.material).toBe("Hormigón G30");
    const col = est.find((e) => e.category === "Pilares estructurales")!;
    expect(col.level).toMatch(/^Nivel/); // via "Restricción de base"

    const inc = rows("index/properties/INC-r3.ndjson").map((r) => mapIndexRow(r, dict, config));
    expect(inc.find((e) => e.category === "Rociadores")?.systemType).toBe("Rociadores");
  });

  it("converts English model lengths in feet to mm", () => {
    const ele = rows("index/properties/ELE-r3.ndjson").map((r) => mapIndexRow(r, dict, config));
    const tray = ele.find((e) => e.category === "Cable Trays")!;
    expect([200, 300, 400, 600]).toContain(Math.round(tray.widthMm!));
    expect(tray.level).toMatch(/^Level/);
    expect(tray.workset).toBe("ELE-Bandejas");
  });

  it("parses units", () => {
    expect(parseLengthUom("autodesk.unit.unit:millimeters-1.0.1")).toBe("mm");
    expect(parseLengthUom("autodesk.unit.unit:meters-1.0.1")).toBe("m");
    expect(parseLengthUom("ft")).toBe("ft");
    expect(toMillimetres("110 mmø", null, "ft")).toBe(110);
    expect(toMillimetres("0,5 m", null, "mm")).toBe(500);
    expect(toMillimetres(1, "ft", "mm")).toBe(304.8);
    expect(toMillimetres("n/a", null, "mm")).toBeUndefined();
  });
});

describe("Index v2 flow with a mocked fetch", () => {
  const t = truth();
  const msv = rawVersion(42).modelSetVersion;
  const sanUrn = msv.documentVersions.find((d) => d.originalSeedFileVersionName === "PRJ-SAN-MOD-001.rvt")!.originalSeedFileVersionUrn!;
  const entry = t.index[sanUrn];
  const P = "/construction/index/v2/projects/3f8a";

  it("batch-status (bare array) → poll by retryAt → fields → query → rows", async () => {
    let statusPolls = 0;
    let queryPolls = 0;
    const { fetch, calls } = mockFetch((u, c) => {
      const p = u.pathname;
      if (p === `${P}/indexes:batch-status` && c.method === "POST") {
        return json([{ projectId: "3f8a", indexId: entry.indexId, state: "PROCESSING", retryAt: "2026-11-06T00:00:03Z", versionUrns: [sanUrn] }]);
      }
      if (p === `${P}/indexes/${entry.indexId}`) {
        statusPolls++;
        return json({ projectId: "3f8a", indexId: entry.indexId, state: "FINISHED", versionUrns: [sanUrn] });
      }
      if (p === `${P}/indexes/${entry.indexId}/fields`) return bytes(fixtureBytes("index/fields.ndjson.gz"));
      if (p === `${P}/indexes/${entry.indexId}/queries` && c.method === "POST") {
        return json({ indexId: entry.indexId, queryId: "q1", state: "RUNNING" });
      }
      if (p === `${P}/indexes/${entry.indexId}/queries/q1`) {
        queryPolls++;
        return json({ indexId: entry.indexId, queryId: "q1", state: "FINISHED" });
      }
      if (p === `${P}/indexes/${entry.indexId}/queries/q1/properties`) {
        // Redirect to storage like the real API (303), served gzipped.
        return new Response(null, { status: 303, headers: { location: "https://idx.s3.amazonaws.com/q1.ndjson.gz" } });
      }
      if (u.hostname === "idx.s3.amazonaws.com") {
        const wanted = JSON.parse(calls.find((x) => x.url.endsWith("/queries") && x.method === "POST")!.body!).query.$in["s.lmvId"] as number[];
        const all = rows(entry.file);
        const text = all.filter((r) => wanted.includes(r.lmvId)).map((r) => JSON.stringify(r)).join("\n");
        return bytes(new Uint8Array(gzipSync(text)));
      }
      return undefined;
    });
    const ctx = testCtx(fetch);
    const indexes = await ensureIndexes(ctx, "b.3f8a", [sanUrn, sanUrn], undefined, { now: () => Date.parse("2026-11-06T00:00:00Z") });
    expect(indexes).toHaveLength(1);
    expect(statusPolls).toBe(1);
    expect(ctx.sleeps[0]).toBe(3000);
    expect(JSON.parse(calls[0].body!)).toEqual({ versions: [{ versionUrn: sanUrn }] });

    const f = await getIndexFields(ctx, "3f8a", entry.indexId);
    expect(f.length).toBe(fields().length);

    const wantedIds = rows(entry.file).slice(0, 5).map((r) => r.lmvId);
    const map = await fetchElementProps(ctx, "3f8a", entry.indexId, wantedIds, f, {
      config,
      documentId: 3,
      viewId: entry.views.find((v) => v.viewableName === "{3D}")!.id,
    });
    expect([...map.keys()].sort()).toEqual([...wantedIds].sort());
    expect(map.get(wantedIds[0])!.documentId).toBe(3);
    expect(queryPolls).toBe(1);
    const storage = calls.find((c) => c.url.includes("idx.s3.amazonaws.com"))!;
    expect(storage.headers.authorization).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith("/fields"))!.headers.authorization).toBe("Bearer test-token");
  });

  it("accepts the {indexes:[…]} shape and surfaces FAILED", async () => {
    const { fetch } = mockFetch((u) =>
      u.pathname.endsWith(":batch-status") ? json({ indexes: [{ projectId: "p", indexId: "i", state: "FAILED" }] }) : undefined,
    );
    await expect(ensureIndexes(testCtx(fetch), "p", ["urn:x"])).rejects.toMatchObject({ code: "job_failed" });
  });

  it("builds the lmvId filter and resolves manifest views", () => {
    expect(lmvIdQuery([1, 2])).toEqual({ $in: { "s.lmvId": [1, 2] } });
    const manifest = { seedFiles: [{ versionUrn: sanUrn, views: entry.views.map((v) => ({ ...v })) }] };
    const coord = entry.views.find((v) => v.viewableName === "Coordinación")!;
    expect(resolveManifestViewId(manifest, sanUrn, coord.viewableGuid)).toBe(coord.id);
  });
});

describe("verifyIdMapping", () => {
  const instances = rawVersion(42).instances.instances;

  it("confirms lvid == lmvId on the fixtures", () => {
    const { tables } = elementTables(42);
    const r = verifyIdMapping(instances, tables);
    expect(r).toMatchObject({ key: "lmvId", ok: true, matchRate: 1, sampled: 100 });
    expect(r.warning).toBeUndefined();
  });

  it("falls back to svf2Id loudly when lmvId does not match", () => {
    const { tables } = elementTables(42);
    // Re-key every table by svf2Id - 1 offset so lvids only hit via svf2Id.
    const shifted = new Map<number, Map<number, ElementProps>>();
    for (const [doc, t] of tables) {
      const m = new Map<number, ElementProps>();
      for (const e of t.values()) m.set(e.lmvId + 100000, { ...e, lmvId: e.lmvId + 100000, svf2Id: e.lmvId });
      shifted.set(doc, m);
    }
    const r = verifyIdMapping(instances, shifted);
    expect(r.key).toBe("svf2Id");
    expect(r.lmvIdRate).toBe(0);
    expect(r.warning).toMatch(/svf2Id/);
  });

  it("reports a low match rate", () => {
    const r = verifyIdMapping(instances, new Map());
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/ATENCIÓN/);
  });
});
