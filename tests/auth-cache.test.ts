import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApsAuth,
  buildAuthorizeUrl,
  createPkcePair,
  pkceChallenge,
  resolveAuthConfig,
  TokenStore,
  waitForAuthCode,
  type AuthConfig,
} from "../server/aps/auth";
import { parseDotenv } from "../server/aps/config";
import { ClashCache } from "../server/cache/clash-cache";
import { normalizeClashTest } from "../core/ingest";
import { json, mockFetch, rawVersion } from "./helpers";

const tmp = (): string => mkdtempSync(join(tmpdir(), "coord-test-"));

function cfg(dir: string): AuthConfig {
  return resolveAuthConfig(dir, { VITE_APS_CLIENT_ID: "client-123", APS_CLIENT_SECRET: "s3cr3t", APS_CALLBACK_PORT: "38765" });
}

describe("config and PKCE", () => {
  it("parses dotenv files", () => {
    expect(parseDotenv('# c\nA=1\nexport B="two words"\nC=x # trailing\n\nbad line')).toEqual({ A: "1", B: "two words", C: "x" });
  });

  it("resolves config with defaults and validates the port", () => {
    const c = resolveAuthConfig("/proj", { VITE_APS_CLIENT_ID: "id" });
    expect(c.port).toBe(8765);
    expect(c.redirectUri).toBe("http://localhost:8765/callback");
    expect(c.scopes).toEqual(["data:read", "data:write", "data:create"]);
    expect(c.tokenPath.replace(/\\/g, "/")).toMatch(/\.coordinator\/auth\/token\.json$/);
    expect(() => resolveAuthConfig("/p", {})).toThrow();
    expect(() => resolveAuthConfig("/p", { VITE_APS_CLIENT_ID: "id", APS_CALLBACK_PORT: "80" })).toThrow();
  });

  it("computes the RFC 7636 S256 challenge", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const p = createPkcePair();
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.challenge).toBe(pkceChallenge(p.verifier));
  });

  it("builds the authorize URL", () => {
    const u = new URL(buildAuthorizeUrl(cfg(tmp()), { state: "st", challenge: "ch" }));
    expect(u.pathname).toBe("/authentication/v2/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-123",
      redirect_uri: "http://localhost:38765/callback",
      scope: "data:read data:write data:create",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
  });
});

describe("ApsAuth token lifecycle", () => {
  it("refreshes an expiring token, persists the rotated refresh token, and never leaks secrets in errors", async () => {
    const dir = tmp();
    const config = cfg(dir);
    const store = new TokenStore(config.tokenPath);
    await store.write({ accessToken: "old", refreshToken: "r1", expiresAt: 1000, obtainedAt: 0 });
    const { fetch, calls } = mockFetch(() => json({ access_token: "new", refresh_token: "r2", expires_in: 3599, scope: "data:read" }));
    const auth = new ApsAuth({ config, fetch, now: () => 10_000 });
    const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
    expect([a, b]).toEqual(["new", "new"]);
    expect(calls).toHaveLength(1); // single refresh for concurrent callers
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("r1");
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from("client-123:s3cr3t").toString("base64")}`);
    const saved = JSON.parse(readFileSync(config.tokenPath, "utf8"));
    expect(saved.refreshToken).toBe("r2");
    expect(existsSync(`${config.tokenPath}.lock`)).toBe(false);
    expect(await auth.getAccessToken()).toBe("new"); // cached
    expect(calls).toHaveLength(1);
    const status = await auth.status();
    expect(JSON.stringify(status)).not.toMatch(/new|r2/);

    const failing = mockFetch(() => json({ error: "invalid_grant", error_description: "The refresh token is invalid or expired." }, 400));
    const auth2 = new ApsAuth({ config, fetch: failing.fetch, now: () => 10_000_000 });
    const err = await auth2.getAccessToken({ forceRefresh: true }).catch((e) => e);
    expect(err.code).toBe("auth_required");
    expect(err.message).not.toMatch(/r2|s3cr3t/);
    expect(await store.read()).toBeUndefined(); // invalid refresh token is discarded
  });

  it("asks for login when there is no token", async () => {
    const auth = new ApsAuth({ config: cfg(tmp()), fetch: mockFetch().fetch });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "auth_required" });
  });

  it("completes the loopback login with PKCE and state check", async () => {
    const config = cfg(tmp());
    const { fetch, calls } = mockFetch(() => json({ access_token: "A", refresh_token: "R", expires_in: 3599 }));
    const auth = new ApsAuth({
      config,
      fetch,
      openBrowser: (url) => {
        const u = new URL(url);
        const cb = `http://127.0.0.1:${config.port}/callback`;
        // A stray request with a wrong state must not end the flow.
        void globalThis
          .fetch(`${cb}?code=bad&state=wrong`)
          .then(() => globalThis.fetch(`${cb}?code=the-code&state=${u.searchParams.get("state")}`));
      },
    });
    const status = await auth.loginInteractive({ timeoutMs: 5000 });
    expect(status.loggedIn).toBe(true);
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("code")).toBe("the-code");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe("http://localhost:38765/callback");
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await auth.getAccessToken()).toBe("A");
    await auth.logout();
    expect(existsSync(config.tokenPath)).toBe(false);
  });

  it("times out the loopback wait", async () => {
    const w = waitForAuthCode(38766, "s", 50);
    await w.ready;
    await expect(w.code).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("ClashCache", () => {
  it("round-trips clashes, documents and elements with a manifest", async () => {
    const cache = new ClashCache(".coordinator/cache", tmp());
    const raw = rawVersion(42);
    const r = normalizeClashTest(raw, { documentVersions: raw.modelSetVersion.documentVersions });
    const key = { projectId: "b.3f8a2c1e-5b7d", modelSetId: "9c1d2e3f", version: 42, testId: "t-42" };
    expect(await cache.has(key)).toBe(false);
    const m = await cache.writeTest(key, { clashes: r.clashes, documents: r.documents, meta: { distUnit: "m" } });
    expect(m.files.clashes?.count).toBe(r.clashes.length);
    expect(m.files.clashes?.format).toBe("ndjson");
    expect(m.meta).toEqual({ distUnit: "m" });
    await cache.writeElements(key, [{ lmvId: 1, raw: {} }]);
    const back = await cache.readTest(key);
    expect(back?.clashes).toEqual(r.clashes);
    expect(back?.documents).toEqual(r.documents);
    expect(back?.manifest.files.elements?.count).toBe(1);
    expect(await cache.readElements(key)).toEqual([{ lmvId: 1, raw: {} }]);
    expect(cache.dirFor(key).replace(/\\/g, "/")).toMatch(/\.coordinator\/cache\/3f8a2c1e-5b7d\/9c1d2e3f\/v42\/t-42$/);
    expect(await cache.sizeBytes(key)).toBeGreaterThan(0);
    await cache.remove(key);
    expect(await cache.has(key)).toBe(false);
  });

  it("rejects path traversal in keys", () => {
    const cache = new ClashCache(".coordinator/cache", tmp());
    expect(() => cache.dirFor({ projectId: "..", modelSetId: "m", version: 1, testId: "t" })).toThrow();
    expect(() => cache.dirFor({ projectId: "p", modelSetId: "a/../../x", version: 1, testId: "t" })).toThrow();
    expect(() => cache.dirFor({ projectId: "p", modelSetId: "m", version: -1, testId: "t" })).toThrow();
  });

  it("ignores a corrupt manifest", async () => {
    const dir = tmp();
    const cache = new ClashCache("c", dir);
    const key = { projectId: "p", modelSetId: "m", version: 1, testId: "t" };
    await cache.writeTest(key, { clashes: [], documents: [] });
    writeFileSync(join(cache.dirFor(key), "manifest.json"), "{oops");
    expect(await cache.readManifest(key)).toBeUndefined();
  });
});
