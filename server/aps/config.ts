/**
 * Minimal `.env` / `.env.local` reader (no dependency). Precedence:
 * process.env > .env.local > .env (PLAN governance: secrets only in .env.local).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Parse dotenv text: `KEY=value`, `export KEY=value`, quotes, `#` comments. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "").trim();
    out[m[1]] = v;
  }
  return out;
}

function readIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Merged environment for the server side. */
export function loadEnv(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const merged: Record<string, string> = {
    ...parseDotenv(readIfExists(join(cwd, ".env"))),
    ...parseDotenv(readIfExists(join(cwd, ".env.local"))),
  };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) merged[k] = v;
  return merged;
}
