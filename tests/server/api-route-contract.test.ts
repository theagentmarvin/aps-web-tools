/**
 * Contract between the web UI's HTTP client (src/lib/api/http.ts) and the server router
 * (server/api/router.ts): every method + path the client calls must be a registered route.
 * Mock mode never hits the router, so drift there (e.g. regroup/apply, DELETE /chat/:id) only
 * showed up in live mode. Static source check: no server needed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const clientSrc = readFileSync(join(root, "src", "lib", "api", "http.ts"), "utf8");
const routerSrc = readFileSync(join(root, "server", "api", "router.ts"), "utf8");

/** Local path prefixes (`const base = \`/projects/…\``) inlined into the calls that use them. */
const LOCALS: Record<string, string> = Object.fromEntries([...clientSrc.matchAll(/const (\w+) = `(\/[^`]*)`;/g)].map((m) => [m[1]!, m[2]!]));

/** Template/string literal path → normalized path with `:p` for every interpolation; query dropped. */
function normalize(raw: string): string {
  // Replace each ${…} (balanced braces) with a placeholder: "" for BASE / qs(…), ":p" otherwise.
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "$" && raw[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      for (; j < raw.length && depth; j++) depth += raw[j] === "{" ? 1 : raw[j] === "}" ? -1 : 0;
      const expr = raw.slice(i + 2, j - 1).trim();
      out += expr === "BASE" || expr.startsWith("qs(") ? "" : LOCALS[expr] !== undefined ? normalize(LOCALS[expr]!) : ":p";
      i = j - 1;
    } else out += raw[i];
  }
  return out.replace(/\?.*$/, "");
}

/** Method + path pairs the client calls. */
function clientCalls(src: string): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  // this.req<…>("METHOD", `path` | "path"
  for (const m of src.matchAll(/this\.req<[^(]*>\(\s*"([A-Z]+)",\s*(`[^`]*`|"[^"]*")/g)) out.push({ method: m[1]!, path: normalize(m[2]!.slice(1, -1)) });
  // this.get<…>(`path` | "path"
  for (const m of src.matchAll(/this\.get<[^(]*>\(\s*(`[^`]*`|"[^"]*")/g)) out.push({ method: "GET", path: normalize(m[1]!.slice(1, -1)) });
  // fetch(`${BASE}/…`, { method: "X" … })  (default GET)
  for (const m of src.matchAll(/fetch\(\s*`\$\{BASE\}([^`]*)`(\s*,\s*\{[^}]*?method:\s*"([A-Z]+)")?/g)) out.push({ method: m[3] ?? "GET", path: normalize(m[1]!) });
  // The generic helpers themselves (`${path}${qs(q)}`) are not calls.
  return out.filter((c) => c.path !== ":p");
}

/** Routes registered with add("METHOD", "/path", …) (single- or multi-line). */
function serverRoutes(src: string): Array<{ method: string; path: string; re: RegExp }> {
  return [...src.matchAll(/\badd\(\s*"([A-Z]+)",\s*"([^"]+)"/g)].map((m) => ({
    method: m[1]!,
    path: m[2]!,
    re: new RegExp(`^${m[2]!.replace(/:([A-Za-z]+)/g, "[^/]+")}/?$`),
  }));
}

describe("HTTP client ↔ server router contract", () => {
  const calls = clientCalls(clientSrc);
  const routes = serverRoutes(routerSrc);

  it("parses a meaningful number of calls and routes", () => {
    expect(calls.length).toBeGreaterThan(60);
    expect(routes.length).toBeGreaterThan(80);
  });

  it("every client call has a matching server route (method + path)", () => {
    const missing = calls.filter((c) => !routes.some((r) => r.method === c.method && r.re.test(c.path.replace(/:p/g, "x"))));
    expect(missing).toEqual([]);
  });

  it("covers the two routes that used to drift (regroup, chat cancel)", () => {
    expect(calls).toContainEqual({ method: "POST", path: "/proposals/:p/regroup" });
    expect(calls).toContainEqual({ method: "POST", path: "/chat/:p/cancel" });
    expect(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/chat/"))).toBe(false);
  });
});
