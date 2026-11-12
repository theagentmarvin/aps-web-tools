import { describe, expect, it } from "vitest";
import {
  fetchClashResults,
  findResource,
  isLeaseExpired,
  listClashTests,
  pickLatestSuccessfulTest,
} from "../server/aps/clash";
import { assignClashes, closeClashes, reopenClashes, waitClashJob } from "../server/aps/clash-writes";
import { issueApprovedWriteToken, type ApprovedWriteToken } from "../server/aps/write-guard";
import type { AssignedGroupCreate, ClashResource, ClashTest, ClosedGroupCreate } from "../server/aps/types";
import { normalizeClashTest } from "../core/ingest";
import { bytes, fixtureBytes, fixtureJson, json, mockFetch, testCtx, truth } from "./helpers";

const C = "b.3f8a2c1e-5b7d-4e90-a1c2-6d8e9f0a1b2c";
const CID = "3f8a2c1e-5b7d-4e90-a1c2-6d8e9f0a1b2c";

describe("clash tests and resources", () => {
  it("lists tests for a version and picks the latest successful one", async () => {
    const { fetch, calls } = mockFetch(() => json(fixtureJson("mc/clash-tests.json")));
    const tests = await listClashTests(testCtx(fetch), C, "ms1", 42);
    expect(calls[0].url).toContain(`/bim360/clash/v3/containers/${CID}/modelsets/ms1/versions/42/tests`);
    expect(pickLatestSuccessfulTest(tests)?.modelSetVersion).toBe(42);
    expect(pickLatestSuccessfulTest([{ ...tests[0], status: "Failed" } as ClashTest])).toBeUndefined();
  });

  it("selects resources by prefix and ignores sqlite", () => {
    const res = fixtureJson<{ resources: ClashResource[] }>("mc/v42/clash-test-resources.json").resources;
    expect(findResource(res, "clashes")?.type).toBe("scope-version-clash.2.0.0");
    expect(findResource(res, "clashes")?.extension).toBe("json.gz");
    expect(findResource(res, "instances")?.type).toBe("scope-version-clash-instance.2.0.0");
    expect(findResource([{ type: "scope-version-clash.1.0.0", url: "u" }], "clashes")).toBeDefined();
  });

  it("knows when a lease is about to expire", () => {
    const r = { type: "t", url: "u", validUntil: "2026-11-04T13:41:37.000Z" };
    expect(isLeaseExpired(r, Date.parse("2026-11-04T13:00:00Z"))).toBe(false);
    expect(isLeaseExpired(r, Date.parse("2026-11-04T13:41:00Z"))).toBe(true);
  });

  it("downloads the three gzipped resources with the returned headers and no APS token", async () => {
    const t = truth();
    const resources = fixtureJson("mc/v42/clash-test-resources.json");
    const { fetch, calls } = mockFetch(
      (u) => (u.pathname.endsWith("/resources") ? json(resources) : undefined),
      (u) => {
        if (!u.hostname.endsWith("amazonaws.com")) return undefined;
        const file = u.pathname.split("/").pop()!.replace(".2.0.0", "");
        return bytes(fixtureBytes(`mc/v42/${file}`));
      },
    );
    const now = () => Date.parse("2026-11-04T13:00:00Z");
    const results = await fetchClashResults(testCtx(fetch), C, t.tests["42"], { now });
    expect(results.clashes.clashes).toHaveLength(t.counts.v42);
    expect(results.resourceTypes.instances).toBe("scope-version-clash-instance.2.0.0");
    const s3Calls = calls.filter((c) => c.url.includes("amazonaws.com"));
    expect(s3Calls).toHaveLength(3);
    for (const c of s3Calls) {
      expect(c.headers.authorization).toBeUndefined();
      expect(c.headers["x-amz-server-side-encryption-customer-algorithm"]).toBe("AES256");
    }
    expect(normalizeClashTest(results).clashes).toHaveLength(t.counts.v42);
  });

  it("re-leases URLs when expired and after a 403", async () => {
    const resources = fixtureJson("mc/v42/clash-test-resources.json");
    let leases = 0;
    let denied = false;
    const { fetch } = mockFetch(
      (u) => (u.pathname.endsWith("/resources") ? (leases++, json(resources)) : undefined),
      (u) => {
        if (!u.hostname.endsWith("amazonaws.com")) return undefined;
        if (u.pathname.includes("clash-instance") && !denied) {
          denied = true;
          return new Response("<Error>AccessDenied</Error>", { status: 403 });
        }
        const file = u.pathname.split("/").pop()!.replace(".2.0.0", "");
        return bytes(fixtureBytes(`mc/v42/${file}`));
      },
    );
    // Not expired: one lease up front, one after the 403.
    await fetchClashResults(testCtx(fetch), C, "t", { now: () => Date.parse("2026-11-04T13:00:00Z") });
    expect(leases).toBe(2);
    // Expired: each resource triggers a re-lease.
    leases = 0;
    await fetchClashResults(testCtx(fetch), C, "t", { now: () => Date.parse("2026-11-05T00:00:00Z") });
    expect(leases).toBe(4);
  });

  it("refuses resource URLs outside the allowlist", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ resources: [{ type: "scope-version-clash.2.0.0", url: "https://evil.example.com/x", headers: {} }] }),
    );
    const err = await fetchClashResults(testCtx(fetch), C, "t").catch((e) => e);
    expect(err.code).toBe("blocked_url");
    expect(calls).toHaveLength(1);
  });
});

describe("clash writes behind the approval guard", () => {
  const closeBody: ClosedGroupCreate[] = [
    { title: "Aislación sobre su propia tubería", reason: "MODEL_INACCURACY", clashes: [41299469560661, 41299469568580] },
  ];
  const assignBody: AssignedGroupCreate[] = [
    {
      title: "Ducto 600x400 atraviesa viga V300x700, N2",
      pushpin: { location: { x: 1.5, y: 2.5, z: 3.5 }, objectId: 1016, type: "TwoDVectorPushpin", viewerState: {} },
      clashes: [41299469560661],
      issueTypeId: "9f2b0000-0000-4000-a000-000000000001",
      issueSubTypeId: "7bc10000-0000-4000-a000-000000000002",
      documentVersionUrn: "urn:adsk.wipprod:fs.file:vf.abc?version=4",
      viewableName: "{3D}",
      assignedToType: "Company",
    },
  ];
  const routes = () =>
    mockFetch((_u, c) =>
      c.method === "POST" ? json({ jobId: "job-1", groups: ["g1"], status: "Running" }, 202) : undefined,
    );

  it("closeClashes POSTs the exact array body to the documented path", async () => {
    const { fetch, calls } = routes();
    const token = issueApprovedWriteToken({ operation: "clash.close", proposalIds: ["P-20261106-0001"], approvedBy: "u1", body: closeBody });
    const job = await closeClashes(testCtx(fetch), token, C, "test-1", closeBody);
    expect(job.jobId).toBe("job-1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`https://developer.api.autodesk.com/bim360/clash/v3/containers/${CID}/tests/test-1/clashes:close`);
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body!)).toEqual(closeBody);
  });

  it("assignClashes and reopenClashes use their documented paths", async () => {
    const { fetch, calls } = routes();
    const t1 = issueApprovedWriteToken({ operation: "clash.assign", proposalIds: ["P-1"], approvedBy: "u1", body: assignBody });
    await assignClashes(testCtx(fetch), t1, C, "test-1", assignBody);
    const t2 = issueApprovedWriteToken({ operation: "clash.reopen", proposalIds: ["P-2"], approvedBy: "u1", body: ["g1"] });
    await reopenClashes(testCtx(fetch), t2, C, "ms-1", ["g1"]);
    expect(calls[0].url).toContain(`/containers/${CID}/tests/test-1/clashes:assign`);
    expect(calls[1].url).toContain(`/containers/${CID}/modelsets/ms-1/clashes:reopen`);
    expect(JSON.parse(calls[1].body!)).toEqual(["g1"]);
  });

  it("rejects forged, reused, mismatched and wrong-operation tokens without calling APS", async () => {
    const { fetch, calls } = routes();
    const ctx = testCtx(fetch);
    const forged = { operation: "clash.close" } as unknown as ApprovedWriteToken<"clash.close">;
    await expect(closeClashes(ctx, forged, C, "t", closeBody)).rejects.toThrow(/no emitido/);

    const t = issueApprovedWriteToken({ operation: "clash.close", proposalIds: ["P"], approvedBy: "u", body: closeBody });
    await expect(closeClashes(ctx, t, C, "t", [{ ...closeBody[0], title: "otro" }])).rejects.toThrow(/difiere/);
    const t2 = issueApprovedWriteToken({ operation: "clash.close", proposalIds: ["P"], approvedBy: "u", body: closeBody });
    await closeClashes(ctx, t2, C, "t", closeBody);
    await expect(closeClashes(ctx, t2, C, "t", closeBody)).rejects.toThrow(/ya utilizado/);

    const wrongOp = issueApprovedWriteToken({ operation: "clash.reopen", proposalIds: ["P"], approvedBy: "u", body: closeBody });
    await expect(closeClashes(ctx, wrongOp as never, C, "t", closeBody)).rejects.toThrow(/no coincide/);

    const expired = issueApprovedWriteToken({ operation: "clash.close", proposalIds: ["P"], approvedBy: "u", body: closeBody, now: 0 });
    await expect(closeClashes(ctx, expired, C, "t", closeBody)).rejects.toThrow(/expirado/);
    expect(calls).toHaveLength(1);
  });

  it("validates bodies before using the token", async () => {
    const { fetch } = routes();
    const bad = [{ ...closeBody[0], clashes: [] }];
    const t = issueApprovedWriteToken({ operation: "clash.close", proposalIds: ["P"], approvedBy: "u", body: bad });
    await expect(closeClashes(testCtx(fetch), t, C, "t", bad)).rejects.toThrow(/entre 1 y 1000/);
    const longTitle = [{ ...assignBody[0], title: "x".repeat(101) }];
    const t3 = issueApprovedWriteToken({ operation: "clash.assign", proposalIds: ["P"], approvedBy: "u", body: longTitle });
    await expect(assignClashes(testCtx(fetch), t3, C, "t", longTitle)).rejects.toThrow(/máx. 100/);
  });

  it("polls a job until Succeeded or Failed", async () => {
    let n = 0;
    const { fetch } = mockFetch(() =>
      json({ jobId: "j", groups: ["g"], status: ++n < 3 ? "Running" : "Succeeded", createdIssueIds: n >= 3 ? ["i1"] : undefined }),
    );
    const ctx = testCtx(fetch);
    const job = await waitClashJob(ctx, C, "j", { intervalMs: 10 });
    expect(job.createdIssueIds).toEqual(["i1"]);
    expect(ctx.sleeps).toHaveLength(2);
    const failing = mockFetch(() => json({ jobId: "j", groups: [], status: "Failed" }));
    await expect(waitClashJob(testCtx(failing.fetch), C, "j")).rejects.toMatchObject({ code: "job_failed" });
  });
});
