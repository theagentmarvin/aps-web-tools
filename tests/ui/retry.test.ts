/** G23: the initial data load retries transient failures (server restarting in dev) with backoff. */
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/lib/api/coordinator-api";
import { isTransient, withRetry } from "../../src/lib/api/retry";

describe("withRetry (G23)", () => {
  const noSleep = async () => undefined;

  it("retries network / proxy failures and then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const v = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new ApiError("fetch failed", 0, "network");
        return "ok";
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(v).toBe("ok");
    expect(n).toBe(3);
    expect(waits).toEqual([400, 800]);
  });

  it("does not retry real errors (4xx, server errors with a code)", async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw new ApiError("no", 403, "forbidden");
      }, { sleep: noSleep }),
    ).rejects.toThrow("no");
    expect(n).toBe(1);
    expect(isTransient(new ApiError("x", 500, "server", "internal"))).toBe(false);
    expect(isTransient(new ApiError("x", 500, "server"))).toBe(true);
    expect(isTransient(new ApiError("x", 502, "server"))).toBe(true);
  });

  it("gives up after the configured retries and surfaces the last error", async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw new ApiError("down", 0, "network");
      }, { retries: 2, sleep: noSleep }),
    ).rejects.toThrow("down");
    expect(n).toBe(3);
  });

  it("stops when aborted (component unmounted)", async () => {
    const signal = { aborted: false };
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        signal.aborted = true;
        throw new ApiError("down", 0, "network");
      }, { signal, sleep: noSleep }),
    ).rejects.toThrow();
    expect(n).toBe(1);
  });
});
