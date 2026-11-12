import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assertAllowedResourceUrl,
  isGzip,
  iterateNdjsonStream,
  maybeGunzip,
  parseJsonBytes,
  safeGet,
} from "../server/aps/download";
import { ApsError } from "../server/aps/errors";
import { retryDeps } from "../server/aps/http";
import { fixtureBytes, json, mockFetch, testCtx } from "./helpers";

describe("gzip sniffing", () => {
  it("detects 1f 8b and gunzips only then", () => {
    const gz = fixtureBytes("mc/v41/scope-version-document.json.gz");
    const plain = fixtureBytes("mc/v41/scope-version-document.json");
    expect(isGzip(gz)).toBe(true);
    expect(isGzip(plain)).toBe(false);
    expect(Buffer.from(maybeGunzip(gz)).equals(plain)).toBe(true);
    expect(maybeGunzip(plain)).toBe(plain);
    expect(parseJsonBytes(gz)).toEqual(parseJsonBytes(plain));
  });

  it("rejects corrupt gzip with a typed error", () => {
    expect(() => maybeGunzip(new Uint8Array([0x1f, 0x8b, 0, 1, 2]))).toThrow(ApsError);
  });

  it("streams NDJSON, gzipped or not", async () => {
    for (const rel of ["index/properties/SAN-r5.ndjson", "index/properties/SAN-r5.ndjson.gz"]) {
      const res = new Response(fixtureBytes(rel));
      let n = 0;
      for await (const row of iterateNdjsonStream<{ lmvId: number }>(res.body!)) {
        expect(typeof row.lmvId).toBe("number");
        n++;
      }
      expect(n).toBeGreaterThan(100);
    }
  });

  it("handles a final line without newline and chunk boundaries", async () => {
    const text = '{"a":1}\n\n{"a":2}\n{"a":3}';
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const b = new TextEncoder().encode(text);
        for (let i = 0; i < b.length; i += 3) c.enqueue(b.slice(i, i + 3));
        c.close();
      },
    });
    const rows: unknown[] = [];
    for await (const r of iterateNdjsonStream(body)) rows.push(r);
    expect(rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    const gzBody = new Response(gzipSync(text)).body!;
    const rows2: unknown[] = [];
    for await (const r of iterateNdjsonStream(gzBody)) rows2.push(r);
    expect(rows2).toEqual(rows);
  });
});

describe("SSRF guard", () => {
  const ok = [
    "https://bim360-mc-clash-prod.s3.us-east-1.amazonaws.com/a/b.json.gz?X-Amz-Signature=1",
    "https://s3.amazonaws.com/bucket/key",
    "https://developer.api.autodesk.com/construction/index/v2/x",
    "https://cdn.derivative.autodesk.com:443/x",
  ];
  const bad = [
    "http://bucket.s3.amazonaws.com/x",
    "https://169.254.169.254/latest/meta-data",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://localhost/x",
    "https://evil.com/x",
    "https://amazonaws.com.evil.com/x",
    "https://evilamazonaws.com/x",
    "https://amazonaws.com/x",
    "https://user:pw@s3.amazonaws.com/x",
    "https://s3.amazonaws.com:8443/x",
    "file:///etc/passwd",
    "not a url",
  ];
  it.each(ok)("allows %s", (u) => expect(() => assertAllowedResourceUrl(u)).not.toThrow());
  it.each(bad)("blocks %s", (u) => {
    const err = (() => {
      try {
        assertAllowedResourceUrl(u);
      } catch (e) {
        return e as ApsError;
      }
    })();
    expect(err?.code).toBe("blocked_url");
  });

  it("re-validates redirects and drops Authorization on origin change", async () => {
    const { fetch, calls } = mockFetch((u) => {
      if (u.hostname === "developer.api.autodesk.com") {
        return new Response(null, { status: 303, headers: { location: "https://bucket.s3.amazonaws.com/props.ndjson" } });
      }
      if (u.hostname === "bucket.s3.amazonaws.com") return json({ fine: true });
      return undefined;
    });
    const deps = retryDeps(testCtx(fetch));
    const res = await safeGet("https://developer.api.autodesk.com/x", deps, {
      headers: { Authorization: "Bearer secret" },
      authOrigin: "https://developer.api.autodesk.com",
    });
    expect(await res.json()).toEqual({ fine: true });
    expect(calls[0].headers.authorization).toBe("Bearer secret");
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it("blocks a redirect to a disallowed host", async () => {
    const { fetch, calls } = mockFetch(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
    const err = await safeGet("https://s3.amazonaws.com/x", retryDeps(testCtx(fetch))).catch((e) => e);
    expect(err.code).toBe("blocked_url");
    expect(calls).toHaveLength(1);
  });
});
