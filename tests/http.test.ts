import { describe, expect, it } from "vitest";
import { ApsError } from "../server/aps/errors";
import {
  apsRequest,
  backoffDelay,
  collect,
  DEFAULT_RETRY,
  paginateContinuation,
  paginateOffset,
  parseRetryAfter,
} from "../server/aps/http";
import { listModelSets } from "../server/aps/modelset";
import { json, mockFetch, testCtx } from "./helpers";
const failure = (p: Promise<unknown>): Promise<ApsError> =>
  p.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e as ApsError,
  );


describe("retry and backoff", () => {
  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfter("7")).toBe(7000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("caps exponential backoff", () => {
    expect(backoffDelay(0, DEFAULT_RETRY, () => 0)).toBe(250);
    expect(backoffDelay(20, DEFAULT_RETRY, () => 0.999)).toBeLessThanOrEqual(DEFAULT_RETRY.maxDelayMs);
  });

  it("retries 429 honouring Retry-After, then succeeds", async () => {
    let n = 0;
    const { fetch, calls } = mockFetch(() =>
      ++n === 1 ? json({ developerMessage: "Quota limit exceeded." }, 429, { "retry-after": "3" }) : json({ ok: true }),
    );
    const ctx = testCtx(fetch, { region: "EMEA" });
    await expect(apsRequest(ctx, "GET", "/x")).resolves.toEqual({ ok: true });
    expect(ctx.sleeps).toEqual([3000]);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.authorization).toBe("Bearer test-token");
    expect(calls[0].headers["x-ads-region"]).toBe("EMEA");
  });

  it("retries 5xx with backoff and throws a typed error when exhausted", async () => {
    const { fetch, calls } = mockFetch(() => json({ title: "boom" }, 503));
    const ctx = testCtx(fetch, { retry: { maxRetries: 2 } });
    const err = await failure(apsRequest(ctx, "GET", "/y"));
    expect(err).toBeInstanceOf(ApsError);
    expect(err.status).toBe(503);
    expect(err.code).toBe("server_error");
    expect(calls).toHaveLength(3);
    expect(ctx.sleeps).toEqual([375, 750]);
  });

  it("retries network errors", async () => {
    let n = 0;
    const ctx = testCtx(async () => {
      if (++n < 3) throw new TypeError("fetch failed");
      return json([1]);
    });
    await expect(apsRequest(ctx, "GET", "/z")).resolves.toEqual([1]);
  });

  it("does not retry 4xx and gives a Spanish 403 hint about Custom Integrations", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ type: "forbidden", title: "Forbidden", detail: "No access", errors: [{ field: "x", title: "t" }] }, 403),
    );
    const err = await failure(apsRequest(testCtx(fetch), "GET", "/secret?token=abc"));
    expect(calls).toHaveLength(1);
    expect(err.status).toBe(403);
    expect(err.messageEs).toMatch(/Custom Integrations/);
    expect(err.message).toMatch(/HTTP 403/);
    expect(err.message).not.toMatch(/token=abc/);
    expect(err.detail).toBe("No access");
    expect(err.errors).toHaveLength(1);
  });

  it("refreshes the token once on 401", async () => {
    const { fetch, calls } = mockFetch((_u, c) => (c.headers.authorization === "Bearer test-token" ? json({}, 401) : json({ ok: 1 })));
    const ctx = testCtx(fetch);
    await expect(apsRequest(ctx, "GET", "/a")).resolves.toEqual({ ok: 1 });
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer test-token", "Bearer test-token-1"]);
  });
});

describe("pagination", () => {
  it("follows continuationToken across pages", async () => {
    const pages: Record<string, unknown> = {
      "": { page: { continuationToken: "t1" }, modelSets: [{ modelSetId: "a" }, { modelSetId: "b" }] },
      t1: { page: { continuationToken: "t2" }, modelSets: [{ modelSetId: "c" }] },
      t2: { page: {}, modelSets: [{ modelSetId: "d" }] },
    };
    const { fetch, calls } = mockFetch((u) => json(pages[u.searchParams.get("continuationToken") ?? ""]));
    const sets = await listModelSets(testCtx(fetch), "b.abc-123");
    expect(sets.map((s) => s.modelSetId)).toEqual(["a", "b", "c", "d"]);
    expect(calls[0].url).toContain("/bim360/modelset/v3/containers/abc-123/modelsets?pageLimit=20");
    expect(calls).toHaveLength(3);
  });

  it("stops on a repeated token", async () => {
    const { fetch, calls } = mockFetch(() => json({ page: { continuationToken: "same" }, items: [1] }));
    const items = await collect(paginateContinuation<number>(testCtx(fetch), "/p", "items"));
    expect(items).toEqual([1, 1]);
    expect(calls).toHaveLength(2);
  });

  it("walks limit/offset pages", async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const { fetch } = mockFetch((u) => {
      const off = Number(u.searchParams.get("offset"));
      const lim = Number(u.searchParams.get("limit"));
      return json({ pagination: { limit: lim, offset: off, totalResults: 5 }, results: all.slice(off, off + lim) });
    });
    const got = await collect(paginateOffset<{ id: number }>(testCtx(fetch), "/issues", {}, 2));
    expect(got.map((g) => g.id)).toEqual([0, 1, 2, 3, 4]);
  });
});
