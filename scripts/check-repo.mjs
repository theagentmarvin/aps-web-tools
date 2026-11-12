#!/usr/bin/env node
// Repo hygiene checks (CI and before every commit): no merge-conflict markers, no personal paths,
// no project data, secrets or e-mail addresses in tracked files. Usage: node scripts/check-repo.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const problems = [];
const add = (file, line, why) => problems.push(`${file}${line ? `:${line}` : ""}  ${why}`);

// Placeholder user names allowed in tests, mocks and docs (fake profiles only).
const FAKE_USERS = new Set(["demo", "coord", "otro", "u", "x", "a b", "user", "usuario", "nombre", "<nombre>", "<user>", "<usuario>", "public", "default", "…", "...", "\\u2026"]);
// Example / placeholder e-mail domains (tests, fixtures and docs examples of personal-data filters).
const FAKE_EMAIL_DOMAIN = /@(?:[a-z0-9-]+\.)*(example|invalid|test|empresa|contratista|localhost)(\.[a-z]{2,})?\b|@s3\.amazonaws\.com/i;
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|zip|pdf|xlsx?|docx?|pptx?|rvt|ifc|dwg|nwd|glb|bin)$/i;
const DATA = [
  [/(^|\/)\.coordinator(-demo)?\//, "datos locales del coordinador (.coordinator/) — nunca se versionan"],
  [/\.(rvt|rfa|ifc|dwg|nwd|nwc)$/i, "archivo de modelo/CAD — no se versiona"],
  [/(^|\/)\.env(\.(?!example$)[\w.-]+)?$/, "archivo de entorno con posibles secretos"],
];
const SECRET = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/, "clave de API de Anthropic"],
  [/\b(APS|FORGE)_CLIENT_SECRET\s*[=:]\s*["']?[A-Za-z0-9]{16,}/, "secreto de cliente APS"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "clave privada"],
  [/\bBearer\s+eyJ[A-Za-z0-9_-]{20,}/, "token de acceso"],
];
const EMAIL = /[A-Za-z0-9._%+-]+@(?!example\.(com|org|invalid)\b|anthropic\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const USERPATH = /[A-Za-z]:[\\/]+Users[\\/]+([^\\/"'`\s)]+(?: [^\\/"'`\s)]+)?)/gi;
const SELF = "scripts/check-repo.mjs";

for (const f of files) {
  for (const [re, why] of DATA) if (re.test(f)) add(f, 0, why);
  if (BINARY.test(f) || f === SELF || f === "package-lock.json") continue;
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  const lines = text.split(/\r?\n/);
  lines.forEach((l, i) => {
    if (/^(<<<<<<<|>>>>>>>) |^=======$/.test(l) && !/\.md$/.test(f)) add(f, i + 1, "marca de conflicto de merge");
    else if (/^(<<<<<<<|>>>>>>>) /.test(l)) add(f, i + 1, "marca de conflicto de merge");
    for (const m of l.matchAll(USERPATH)) if (!FAKE_USERS.has(m[1].toLowerCase())) add(f, i + 1, `ruta personal (${m[0].slice(0, 40)}…) — usa una ruta genérica`);
    for (const [re, why] of SECRET) if (re.test(l)) add(f, i + 1, why);
    for (const m of l.matchAll(new RegExp(EMAIL.source, "g"))) {
      if (/^noreply@|@users\.noreply\.github\.com$/i.test(m[0]) || FAKE_EMAIL_DOMAIN.test(m[0])) continue;
      add(f, i + 1, `correo electrónico (${m[0]}) — sin datos personales en el repo; usa @example.com`);
    }
  });
}

if (problems.length) {
  console.error(`check-repo: ${problems.length} problema(s)\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`check-repo: OK (${files.length} archivos)`);
