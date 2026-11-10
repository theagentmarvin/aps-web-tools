// PreToolUse guard for shell tools (Bash, PowerShell, Monitor). v2.
//
// BEST-EFFORT DEFENCE IN DEPTH, NOT A SECURITY BOUNDARY. A shell can always build a string the matcher does
// not see. The boundary is the WebAuthn-verified human approval checked by the server, plus Claude Code's
// permission prompts. This hook catches model mistakes and naive or moderately obfuscated injections, and it
// is deliberately conservative: when in doubt it denies (or asks). Fails CLOSED on unreadable input.
//
// Matching works on three views of the command:
//   raw      the command as written (lower-cased)
//   squashed quotes, backticks, carets, +, commas, parentheses, brackets, braces and whitespace removed,
//            backslashes -> "/". Defeats split strings: '.coord'+'inator', "sec""ret", sec^ret, ['a','b'].join()
//   segments the command split on ; && || | & and newlines, each tokenised with quote handling
import path from "node:path";
import { readInput, projectRoot, decide, pass, block, isHarnessDev, TAG } from "./_lib.mjs";

let input;
try {
  input = readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; comando bloqueado (${e.message}).`);
}

const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
const cmd = typeof ti.command === "string" ? ti.command : typeof ti.script === "string" ? ti.script : "";
if (!cmd.trim()) pass();

const root = projectRoot(input);
const dev = isHarnessDev();
const isPowerShellTool = /powershell/i.test(String(input.tool_name ?? ""));

const raw = cmd.toLowerCase().replace(/\\/g, "/");
const squashed = raw.replace(/[\s"'`^+,()[\]{}]/g, "").replace(/\/{2,}/g, "/");

const deny = (why) => decide("deny", `${TAG} Bloqueado: ${why}. (Guardia de mejor esfuerzo; si es legítimo, ejecútalo tú en tu terminal.)`);
const ask = (why) => decide("ask", `${TAG} ${why}`);

// ─────────────────────────────────────────────────────────────────────────────
// Tokenising
// ─────────────────────────────────────────────────────────────────────────────

function splitSegments(s) {
  const out = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function tokenize(seg) {
  const toks = [];
  let cur = "";
  let q = null;
  let has = false;
  for (const c of seg) {
    if (q) {
      if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) toks.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) toks.push(cur);
  return toks;
}

const base = (t) => path.basename(String(t ?? "").replace(/\\/g, "/")).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");

/** Strip prefixes that don't change what runs: env assignments, sudo/time/exec/command/&, call operator. */
function stripPrefixes(toks) {
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) i++;
    else if (["sudo", "time", "exec", "command", "&", "nohup", "nice"].includes(t.toLowerCase())) i++;
    else break;
  }
  return toks.slice(i);
}

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

const INTERPRETERS = new Set(["node", "nodejs", "tsx", "ts-node", "bun", "deno", "python", "python3", "py", "ruby", "perl", "php", "pwsh", "powershell", "cscript", "wscript", "mshta", "osascript"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "cmd", "pwsh", "powershell"]);

const INLINE_RE = [
  /\b(node|nodejs|bun|deno)(\.exe)?\b[^|;&]*\s(-e|-p|--eval|--print|eval)\b/,
  /\btsx\b[^|;&]*\s(-e|--eval|-p|--print)\b/,
  /\b(python[0-9.]*|py)(\.exe)?\b[^|;&]*\s-c\b/,
  /\b(pwsh|powershell)(\.exe)?\b[^|;&]*\s-(c|command|e|ec|enc|encodedcommand)\b/,
  /\b(ruby|perl|php)\b[^|;&]*\s-[er]\b/,
  /\bcmd(\.exe)?\s+\/[ck]\b/,
  /\b(bash|sh|zsh|dash)\s+(-[a-z]*c)\b/,
  /\b(node|tsx|bun|deno|python[0-9.]*|py)\s*(<<|<\s*\/dev\/stdin)/,
  /\|\s*(node|tsx|bun|deno|python[0-9.]*|py|pwsh|powershell|bash|sh)\b(\s+-)?\s*$/m,
];
const inlineInterpreter = isPowerShellTool || INLINE_RE.some((re) => re.test(raw));

const NET_CLIENT =
  /(\bcurl\b|\bwget\b|\bwget2\b|invoke-webrequest|invoke-restmethod|\biwr\b|\birm\b|start-bitstransfer|net\.webclient|httpclient|\bfetch\b|https?\.(get|request)|\baxios\b|\bundici\b|\bgot\(|\brequests\.|urllib|httpx|aiohttp|\bhttpie\b|(^|[\s;&|])https?\s+(-{1,2}[\w-]+\s+)*(get|post|put|patch|delete|:\d|localhost|127\.|\[::1\])|\bxh\b|\baria2c\b|\blynx\b|\bw3m\b|\bnc\b|\bncat\b|\btelnet\b|\bsocat\b|s_client|xmlhttprequest|websocket|test-netconnection|bitsadmin|certutil\s+-urlcache)/;
const LOOPBACK = /(localhost|127\.\d+|::1|0\.0\.0\.0|0x7f|2130706433|0177\.|::ffff:127|\blocaltest\.me|\.localhost\b)/;
const API_PATH = /\/api\/(coord|auth|aps|s3-proxy)/;

// Sensitive markers looked for in the SQUASHED command.
const ALWAYS_SENSITIVE = [
  // ALL of .coordinator/ (ledgers, questions.json, meeting/, issue-checks/, decisions/, tests/, batches, approvals…):
  // forged ledger refs or meeting notes would fake human decisions or due-date quotes. Notes go through Read/Edit.
  [/\.coordinator/, "acceso por shell a .coordinator/ (usa las herramientas mcp__coord__* y Read/Edit de notas)"],
  [/coordinator_home/, "acceso por shell al directorio de estado del coordinador (COORDINATOR_HOME)"],
  [/bim-coord/, "acceso al almacén de claves del coordinador"],
  [/coord_secure_dir/, "acceso al almacén de claves del coordinador"],
  [/approval[-.]?key|audit[-.]?key|aps-token|webauthn-cred|browser-session/, "acceso a llaves o tokens del coordinador"],
  [/claudecode/, "manipulación de la variable CLAUDECODE"],
  [/appdata|xdg_config_home|~\/\.config|\$home\/\.config|\.config\/bim/, "acceso a perfiles de usuario (APPDATA / ~/.config) donde viven las llaves"],
  [/(^|[;&|])env-i|-usenewenvironment|\benv-u/, "ejecución con entorno limpiado o modificado"],
  [/\.env\.local|\.env(?![a-z.])|aps_client_secret/, "lectura de secretos (.env / .env.local / APS_CLIENT_SECRET)"],
];
const INLINE_SENSITIVE = /secret|approv|token|harness|webauthn|passkey|credential|audit|\.claude|claude\.md|\.mcp\.json|coordinator\.config|\.git\/|hookspath/;
const OBFUSCATION =
  /fromcharcode|fromcodepoint|base64|atob|btoa|buffer\.from|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|\[char\]|\[convert\]::|-bxor|\.reverse|decodeuri|unescape|\bchr\(|codecs|rot13|-encodedcommand|-enc\b|\[system\.text\.encoding\]|frombase64|string\.join|invoke-expression|\biex\b|\beval\(|new-object|add-type|\bexec\(|compile\(|__import__|importlib|require\(.child_process|child_process/;

// Read-only / staging git segments (add, commit, status, diff, log…) are excluded from the content scans below:
// their arguments (paths being staged, commit messages via -m/-F) are not reads of secrets nor write targets.
// This fixes false positives such as `git commit -m "install of .mcp.json/config"` or `git add CLAUDE.md`.
const GIT_READ_OR_STAGE = new Set(["add", "commit", "status", "diff", "log", "show", "blame", "ls-files", "rev-parse", "branch", "grep", "shortlog", "describe", "tag"]);
const isGitReadOrStage = (seg) => {
  const t = stripPrefixes(tokenize(seg));
  return base(t[0]) === "git" && GIT_READ_OR_STAGE.has(String(t.find((x, i) => i > 0 && !x.startsWith("-")) ?? "").toLowerCase()) &&
    !/hookspath|core\.hooks|filter\.|alias\.|-c\s/i.test(seg);
};
const nonGitRaw = splitSegments(cmd).filter((s) => !isGitReadOrStage(s)).join(" ; ").toLowerCase().replace(/\\/g, "/");
const nonGitSquashed = nonGitRaw.replace(/[\s"'`^+,()[\]{}]/g, "").replace(/\/{2,}/g, "/");

// ─────────────────────────────────────────────────────────────────────────────
// 1. Always-sensitive markers (any tool, any context)
// ─────────────────────────────────────────────────────────────────────────────

// CLAUDECODE / environment manipulation is checked on the whole command (also as a prefix of a git command).
if (/claudecode/.test(squashed)) deny("manipulación de la variable CLAUDECODE");
for (const [re, why] of ALWAYS_SENSITIVE) if (re.test(nonGitSquashed) || re.test(nonGitRaw)) deny(why);

// Globs over hidden directories (e.g. `cat .c*/*/appr*`).
if (/(^|[\s/"'=])\.[^\s/]*[*?[]/.test(nonGitRaw)) deny("comodines sobre directorios ocultos (podrían alcanzar .coordinator/ o .claude/)");

// Links can redirect any path guard.
if (/\bmklink\b|\bln\s+-[a-z]*s|\bln\s+[^-]|symboliclink|-itemtype\s*(junction|hardlink)|fsutil\s+hardlink|\bjunction(\.exe)?\b/.test(nonGitRaw)) {
  deny("creación de enlaces simbólicos, duros o junctions");
}

// TTY / pty wrappers (the coordinator CLI refuses non-TTY and Claude Code sessions).
if (/(^|[\s;&|])(script|winpty|unbuffer|expect|conpty)(\s|$)|pty\.spawn|node-pty|start-process|\bstart\s+(""|cmd|powershell|pwsh|wt|conhost)|\bconhost\b|\bwt(\.exe)?\s/.test(raw)) {
  deny("envoltorios de terminal (pty/TTY) o ventanas nuevas");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Network: local coordinator API, Autodesk
// ─────────────────────────────────────────────────────────────────────────────

const usesNet = NET_CLIENT.test(raw) || inlineInterpreter;
// The local API's human-only endpoints (approve, question answers, notes, verdict and family decisions,
// discipline mappings, /csrf) must never be called from the agent's shell. Any mention of the API path is denied
// unless EVERY segment is a read-only text tool (grep/rg/cat/… over source code) — whatever HTTP client is used.
const READ_ONLY_TEXT = new Set(["grep", "rg", "egrep", "fgrep", "cat", "less", "more", "head", "tail", "wc", "ls", "find", "git", "select-string", "get-content", "type", "findstr"]);
const onlyReadOnlyText = splitSegments(cmd).every((s) => {
  const t = stripPrefixes(tokenize(s));
  const h = base(t[0]);
  return READ_ONLY_TEXT.has(h) && !(h === "find" && /-exec|-delete|-ok/.test(s));
});
if ((API_PATH.test(squashed) || API_PATH.test(raw)) && (usesNet || !onlyReadOnlyText)) {
  deny("llamada a la API local del coordinador (/api/coord, /api/auth, /api/aps): aprobaciones, respuestas, notas y decisiones son solo humanas, en la UI");
}
if (usesNet && LOOPBACK.test(squashed) && /\/api|%[0-9a-f]{2}/.test(squashed)) deny("llamada HTTP a un servidor local");
if (usesNet && /autodesk\.com|autodesk360|\/bim360\/|\/construction\//.test(squashed)) deny("llamada directa a APIs de Autodesk; usa las herramientas mcp__coord__*");

// ─────────────────────────────────────────────────────────────────────────────
// 3. Inline interpreters: no sensitive references, no obfuscation
// ─────────────────────────────────────────────────────────────────────────────

if (inlineInterpreter) {
  if (INLINE_SENSITIVE.test(nonGitSquashed)) deny("intérprete en línea que referencia secretos, aprobaciones, tokens o la configuración del agente (en cualquier forma, incluso por partes)");
  if (!isPowerShellTool && OBFUSCATION.test(nonGitSquashed)) deny("intérprete en línea con construcción ofuscada de cadenas o ejecución dinámica");
  if (isPowerShellTool && /fromcharcode|base64|\[char\]|\[convert\]::|-bxor|-encodedcommand|-enc\b|invoke-expression|\biex\b|add-type|frombase64|\[system\.text\.encoding\]/.test(nonGitSquashed)) {
    deny("PowerShell con construcción ofuscada de cadenas o ejecución dinámica");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Per segment: CLI verbs, file runs, npm/npx, git, writes to protected paths
// ─────────────────────────────────────────────────────────────────────────────

const HARNESS_PATH = /(^|[\s"'=/.])(\.claude\/|\.claude(\s|$|["'])|claude\.md|\.mcp\.json|coordinator\.config|harness-staging|settings(\.local)?\.json|\.claude\.json)/;
const GUARD_CODE_PATH = /(^|[\s"'=/])(server\/|core\/|scripts\/|tests\/|src\/|public\/|node_modules\/|\.git\/|package(-lock)?\.json|tsconfig|vite\.config|vitest\.config|index\.html|rules\/)/;

const CLI_ALLOWED_VERBS = new Set(["status", "approvals", "verify-approval", "help", "--help"]);
const NPM_SCRIPTS_PASS = new Set(["dev", "build", "preview", "lint", "typecheck", "test", "test:watch", "eval"]);
const NPX_PASS = new Set(["vitest", "tsc", "eslint", "vite", "prettier"]);
const GIT_WRITE_TREE = new Set(["checkout", "restore", "apply", "am", "stash", "reset", "cherry-pick", "revert", "merge", "rebase", "pull", "switch", "mv", "rm", "clean", "worktree", "update-index", "read-tree", "checkout-index"]);

function checkCli(verb, label) {
  const v = String(verb ?? "").toLowerCase();
  if (v === "setup" || v === "approve" || v === "passkey-enroll") deny(`\`${label} ${v}\` solo lo ejecuta un humano en su propia terminal`);
  if (!CLI_ALLOWED_VERBS.has(v)) deny(`\`${label} ${v || "(sin comando)"}\`: desde el agente solo se permiten status, approvals list y verify-approval; el resto va por las herramientas mcp__coord__*`);
}

function isUnder(file, dirs) {
  const f = String(file).replace(/\\/g, "/");
  const abs = path.isAbsolute(f) || /^[a-z]:\//i.test(f) || f.startsWith("~") ? f : path.join(root, f).replace(/\\/g, "/");
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  if (rel.startsWith("..") || path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || f.startsWith("~")) return "outside";
  return dirs.some((d) => rel.toLowerCase().startsWith(d)) ? "allowed" : "inside";
}

function checkFileRun(file, label) {
  if (!file) return;
  if (/^server\/cli(\.ts)?$|[/\\]server[/\\]cli(\.ts)?$/i.test(file)) return; // handled by checkCli
  const where = isUnder(file, ["scripts/", "tests/"]);
  if (where === "outside") deny(`${label} ejecuta un archivo fuera del repositorio (${file})`);
  if (where === "inside") ask(`${label} ejecuta ${file}, fuera de scripts/ y tests/. Confirma solo si lo pediste tú.`);
}

function analyse(seg, depth = 0) {
  if (depth > 3) deny("demasiados niveles de shells anidados");
  let toks = stripPrefixes(tokenize(seg));
  if (!toks.length) return;
  let head = base(toks[0]);

  // Nested shells: analyse the inner command string.
  if (SHELLS.has(head)) {
    const flagIdx = toks.findIndex((t, i) => i > 0 && /^(-[a-z]*c|\/c|\/k|-command|-c)$/i.test(t));
    if (flagIdx > 0 && toks[flagIdx + 1] !== undefined) {
      for (const inner of splitSegments(toks.slice(flagIdx + 1).join(" "))) analyse(inner, depth + 1);
      return;
    }
    const fileIdx = toks.findIndex((t, i) => i > 0 && /^-?file$/i.test(t));
    if (fileIdx > 0) return checkFileRun(toks[fileIdx + 1], head);
    if (toks.length > 1 && !toks[1].startsWith("-") && !toks[1].startsWith("/")) return checkFileRun(toks[1], head);
    return;
  }

  // npm / pnpm / yarn
  if (head === "npm" || head === "pnpm" || head === "yarn") {
    const sub = (toks[1] ?? "").toLowerCase();
    if (sub === "run" || sub === "run-script" || sub === "rum" || sub === "urn" || (head !== "npm" && toks[1] && !["install", "add", "i", "exec", "dlx", "x"].includes(sub))) {
      const script = (sub === "run" || sub === "run-script" || sub === "rum" || sub === "urn" ? toks[2] : toks[1]) ?? "";
      const s = script.toLowerCase();
      if (s === "setup" || s.includes("setup")) deny("`setup` instala la configuración del agente; solo lo ejecuta un humano");
      if (s === "coordinator") {
        const dd = toks.indexOf("--");
        return checkCli(dd >= 0 ? toks[dd + 1] : toks[3], `${head} run coordinator`);
      }
      if (NPM_SCRIPTS_PASS.has(s)) return;
      return ask(`\`${head} ${sub} ${script}\` no es un script habitual del coordinador. Confirma solo si lo pediste tú.`);
    }
    if (["pkg", "set-script", "config", "link", "publish", "unpublish", "token", "adduser", "login"].includes(sub)) deny(`\`${head} ${sub}\` modifica configuración o credenciales`);
    if (["exec", "x", "dlx"].includes(sub)) {
      toks = ["npx", ...toks.slice(2)];
      head = "npx";
    } else if (["install", "i", "ci", "add", "update", "uninstall", "remove", "rebuild"].includes(sub)) {
      return ask(`\`${head} ${sub}\` cambia dependencias (node_modules). Confirma solo si lo pediste tú.`);
    } else return;
  }

  // npx / bunx
  if (head === "npx" || head === "bunx" || head === "pnpx") {
    const rest = toks.slice(1).filter((t) => !/^(-y|--yes|--no-install|-q|--quiet)$/i.test(t));
    const pkg = base(rest[0] ?? "");
    if (pkg === "tsx" || pkg === "ts-node" || pkg === "node") {
      toks = rest;
      head = pkg;
    } else if (NPX_PASS.has(pkg)) return;
    else return ask(`\`npx ${rest[0] ?? ""}\` descarga o ejecuta un paquete arbitrario. Confirma solo si lo pediste tú.`);
  }

  // Interpreters running a file
  if (INTERPRETERS.has(head)) {
    const args = toks.slice(1);
    // Inline code (-e/-p/--eval/-c/-command…) is handled by the global inline-interpreter rules.
    if (args.some((a) => /^(-e|-p|--eval|--print|-c|-command|-ec|-enc|-encodedcommand|eval)$/i.test(a))) return;
    let file;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^(--import|-r|--require|--loader|--experimental-loader)$/i.test(a)) {
        const v = (args[i + 1] ?? "").toLowerCase();
        if (!/^tsx(\/esm|\/cjs)?$/.test(v)) deny(`${head} ${a} ${args[i + 1] ?? ""}: solo se permite cargar tsx`);
        i++;
        continue;
      }
      if (/^(--import|--require|--loader|-r)=/.test(a)) {
        if (!/=tsx(\/esm|\/cjs)?$/i.test(a)) deny(`${head} ${a}: solo se permite cargar tsx`);
        continue;
      }
      if (a.startsWith("-")) continue;
      file = a;
      break;
    }
    if (!file) return;
    if (/(^|[/\\])server[/\\]cli(\.ts)?$/i.test(file)) {
      const verb = args[args.indexOf(file) + 1];
      return checkCli(verb, `${head} server/cli.ts`);
    }
    return checkFileRun(file, head);
  }

  // git
  if (head === "git") {
    const sub = (toks.find((t, i) => i > 0 && !t.startsWith("-")) ?? "").toLowerCase();
    const segLower = seg.toLowerCase().replace(/\\/g, "/");
    if (/hookspath|core\.hooks|\.git\/hooks|filter\.|core\.fsmonitor|core\.sshcommand|alias\./.test(segLower)) deny("configuración de git que ejecuta código (hooks, filtros, alias)");
    if (sub === "config" && /--global|--system/.test(segLower)) deny("configuración global de git");
    if (GIT_READ_OR_STAGE.has(sub)) return; // false-positive fix: mentioning .claude/CLAUDE.md is fine here
    // apply/am take patch files whose targets are invisible here; stash/reset/pull/merge/rebase rewrite the tree.
    const alwaysRisky = ["apply", "am", "stash", "reset", "pull", "merge", "rebase"].includes(sub);
    if (GIT_WRITE_TREE.has(sub) && !dev && (alwaysRisky || HARNESS_PATH.test(segLower) || /server\/(cli|approval|secure|store)/.test(segLower))) {
      deny(`\`git ${sub}\` podría reescribir la configuración del agente o el código que protege las aprobaciones`);
    }
    return;
  }

  // Direct execution of a path (./x.sh, C:/tmp/forge.exe, scripts/run.ps1)
  if (/[/\\]/.test(toks[0]) || /\.(sh|bash|ps1|bat|cmd|m?js|cjs|ts|py|exe|com|vbs|hta)$/i.test(toks[0])) {
    if (/(^|[/\\])node_modules[/\\]\.bin[/\\](vitest|tsc|eslint|vite|prettier)(\.cmd)?$/i.test(toks[0])) return;
    return checkFileRun(toks[0], "ejecución directa");
  }

  // Target-aware writes: only the DESTINATIONS of write operations are checked (a rules/ path that is merely
  // read, e.g. by grep in the same command, is not a write).
  if (!dev) {
    for (const t of writeTargets(toks)) {
      const kind = protectedKind(t);
      if (kind === "harness") deny(`modificación por shell de la configuración del agente (${t})`);
      if (kind === "code") deny(`escritura por shell en código o configuración protegida (${t}); rules/ cambia vía /curar-reglas`);
      if (kind === "glob") deny(`comodín en el destino de una escritura (${t})`);
    }
  }
}

/** Destinations written by a tokenised simple command (redirections + known write commands). */
function writeTargets(toks) {
  const targets = [];
  const words = [];
  // Redirections: `> f`, `>> f`, `>f`, `x>f` (but not 2>&1, >/dev/null, >$null, =>, ->).
  const addDest = (d) => {
    if (d && !d.startsWith("&") && !/^(\/dev\/null|\$null|nul)$/i.test(d)) targets.push(d);
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    let m;
    if ((m = t.match(/^\d?>>?$/))) {
      addDest(toks[++i]); // `> file`, `2>> file`
    } else if ((m = t.match(/^\d?>>?(.+)$/))) {
      addDest(m[1]); // `>file`, `2>err.log`, `2>&1` (filtered by addDest)
    } else if ((m = t.match(/^(.*?[^-=<>&\d\s])>>?(.+)$/))) {
      words.push(m[1]); // `x>file` (but not `=>`, `->`)
      addDest(m[2]);
    } else {
      words.push(t);
    }
  }
  if (!words.length) return targets;
  const cmd0 = base(words[0]);
  const args = words.slice(1);
  const positional = (list) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (/^-(value|encoding|filter|include|exclude|itemtype|force|recurse|e|expression|n|suffix)$/i.test(a)) {
        if (!/^-(force|recurse)$/i.test(a)) i++;
        continue;
      }
      if (a.startsWith("-") && a.length > 1) continue;
      out.push(a);
    }
    return out;
  };
  const named = (names) => {
    for (let i = 0; i < args.length - 1; i++) if (names.includes(args[i].toLowerCase())) return args[i + 1];
    return undefined;
  };
  switch (cmd0) {
    case "sed":
    case "perl": {
      if (!args.some((a) => /^-[a-z]*i/i.test(a) || a === "--in-place")) break;
      const pos = positional(args);
      const hasScriptFlag = args.some((a) => /^-(e|f)$/.test(a) || a === "--expression");
      targets.push(...(hasScriptFlag ? pos : pos.slice(1)));
      break;
    }
    case "tee":
    case "rm":
    case "rmdir":
    case "del":
    case "erase":
    case "touch":
    case "truncate":
    case "chmod":
    case "chown":
    case "unlink":
    case "shred":
    case "remove-item":
    case "ri":
    case "clear-content":
    case "new-item":
    case "ni":
    case "mkdir":
    case "md":
      targets.push(...positional(cmd0 === "chmod" || cmd0 === "chown" ? args.filter((a, i) => i > 0 || a.startsWith("-")) : args));
      break;
    case "set-content":
    case "add-content":
    case "out-file":
    case "sc":
    case "ac":
    case "export-csv":
    case "export-clixml": {
      const p = named(["-path", "-literalpath", "-filepath"]);
      targets.push(p ?? positional(args)[0]);
      break;
    }
    case "cp":
    case "mv":
    case "copy":
    case "move":
    case "xcopy":
    case "robocopy":
    case "rsync":
    case "install":
    case "copy-item":
    case "move-item":
    case "rename-item":
    case "ren":
    case "rename":
    case "cpi":
    case "mi": {
      const d = named(["-destination", "-newname", "-target-directory", "-t"]);
      const pos = positional(args);
      if (d) targets.push(d);
      else if (cmd0 === "robocopy") targets.push(pos[1]);
      else targets.push(pos[pos.length - 1]);
      if (cmd0 === "mv" || cmd0 === "move" || cmd0 === "move-item" || cmd0 === "mi" || cmd0 === "rename-item" || cmd0 === "ren" || cmd0 === "rename") targets.push(...pos.slice(0, -1)); // sources disappear
      break;
    }
    case "dd":
      for (const a of args) if (a.startsWith("of=")) targets.push(a.slice(3));
      break;
    default:
      break;
  }
  return targets.filter((t) => typeof t === "string" && t.length > 0);
}

/** Classify a write destination: "harness" | "code" | "glob" | undefined. */
function protectedKind(target) {
  let t = String(target).replace(/\\/g, "/").replace(/^["']|["']$/g, "");
  if (path.isAbsolute(t) || /^[a-z]:\//i.test(t)) {
    const rel = path.relative(root, t).replace(/\\/g, "/");
    if (rel.startsWith("..") || /^[a-z]:/i.test(rel)) {
      return /(^|\/)\.claude(\/|$)|\.claude\.json$/i.test(t) ? "harness" : undefined;
    }
    t = rel;
  }
  t = t.replace(/^(\.\/)+/, "").toLowerCase();
  if (/^~?\/?\.claude(\/|$)|\/\.claude(\/|$)|^claude\.md$|^\.mcp\.json$|^coordinator\.config[^/]*\.json$|^harness-staging(\/|$)|\.claude\.json$/.test(t)) return "harness";
  if (/^(server|core|scripts|tests|src|public|node_modules|rules|\.git)(\/|$)/.test(t)) return "code";
  if (/^(package(-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.ts|vitest\.config\.ts|index\.html)$/.test(t)) return "code";
  if (/[*?[]/.test(t)) return "glob";
  return undefined;
}

for (const seg of splitSegments(cmd)) analyse(seg);

// Inline interpreters that write files: never at harness/guard paths (string building already checked above).
if (inlineInterpreter && !dev && /writefile|appendfile|createwritestream|set-content|out-file|add-content|copy-item|move-item|new-item|remove-item|open\(.*[wax+]/.test(squashed) && (HARNESS_PATH.test(raw) || GUARD_CODE_PATH.test(raw))) {
  deny("intérprete en línea que escribe en la configuración del agente o en el código protegido");
}

pass();
