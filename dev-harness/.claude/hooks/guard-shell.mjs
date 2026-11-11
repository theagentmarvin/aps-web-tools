// PreToolUse guard for shell tools (Bash, PowerShell, Monitor) in DEVELOPER mode. Minimal by design.
//   deny  any mention of coordinators' real data / backups / keystore / .env secrets (raw and "squashed" views,
//         so split strings like 'bim-'+'coordinator' are caught), CLAUDECODE / environment tricks that would
//         re-enable human-only channels, human-only CLI verbs (approve, passkey-enroll) and ACC writes (CLI apply,
//         HTTP calls to Autodesk or to the local apply route)
//   ask   shell writes aimed at the active guard (.claude/hooks/**, .claude/settings*.json)
//   allow everything else, including git (add/commit/branch/merge/…, any commit message), npm, npx, tsx, tests
// Best effort, not a sandbox: the boundary for ACC writes is the passkey-verified approval checked by the server.
import { readInput, decide, pass, block, TAG } from "./_lib.mjs";

let input;
try {
  input = readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; comando bloqueado (${e.message}).`);
}

const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
const cmd = typeof ti.command === "string" ? ti.command : typeof ti.script === "string" ? ti.script : "";
if (!cmd.trim()) pass();

const deny = (why) => decide("deny", `${TAG} Bloqueado: ${why}. (Si es legítimo, hazlo tú en tu terminal.)`);

/** Split on ; && || | & and newlines, respecting quotes. */
function segments(s) {
  const out = [];
  let cur = "";
  let q = null;
  for (const c of s) {
    if (q) {
      cur += c;
      if (c === q) q = null;
    } else if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === ";" || c === "\n" || c === "|" || c === "&") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// git segments (add/commit/log/…, any message) are not scanned for paths: false positives on commit messages.
const isGit = (seg) => /^(\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*git(\.exe)?\s/i.test(seg) && !/hookspath|core\.hooks|core\.fsmonitor|filter\.|alias\./i.test(seg);
const segs = segments(cmd);
const nonGit = segs.filter((s) => !isGit(s)).join(" ; ");
const raw = nonGit.toLowerCase().replace(/\\/g, "/");
const squashed = raw.replace(/[\s"'`^+,()[\]{}]/g, "").replace(/\/{2,}/g, "/");
// git segments keep their env-assignment prefix in the scan (`CLAUDECODE= git …`), never their message.
const gitPrefixes = segs.filter(isGit).map((s) => s.slice(0, s.search(/git(\.exe)?\s/i))).join(" ");
const envView = `${nonGit} ${gitPrefixes}`.toLowerCase().replace(/[\s"'`^+,()[\]{}]/g, "");

// 1. Environment tricks.
if (/claudecode/.test(envView)) deny("manipulación de la variable CLAUDECODE (habilita canales solo humanos)");
if (/(^|[;&|\s])env\s+(-i|-u|--ignore-environment|--unset)\b|-usenewenvironment/.test(cmd.toLowerCase())) deny("ejecución con el entorno limpiado o modificado");
if (/coord_dev_live|coord_harness_dev/.test(squashed)) deny("cambio del modo del entorno de desarrollo desde la terminal (se fija al iniciar claude)");

// 2. Real data, backups, secrets.
const MARKERS = [
  [/bim-coord[a-z-]*\/(data|backups)|bim-coord[a-z-]*\\(data|backups)/, "datos reales o respaldos de los coordinadores"],
  [/(appdata|roaming)[/\\]?bim-coord|\.config\/bim-coord|coord_secure_dir/, "secretos del coordinador (llaves, passkeys, tokens)"],
  [/\$env:appdata|%appdata%|\$appdata\b|\$\{appdata\}|getfolderpath\(.?applicationdata/, "acceso a %APPDATA% (allí viven las llaves del coordinador)"],
  [/(localappdata|xdg_data_home|\.local\/share)[^;|&]*bim-coord(?!inator-agent-runtime)/, "datos reales o respaldos de los coordinadores"],
  [/approval-key|audit-key|aps-token|webauthn-cred|browser-session\.json/, "llaves o tokens del coordinador"],
  [/(^|[\s"'/=\\:<>])\.env(\.local|\.[\w-]+\.local)?(?![\w.-])/, "lectura o escritura de .env (secretos; .env.example sí se permite)"],
  [/aps_client_secret/, "acceso al secreto de la app APS"],
  [/(^|[\s"'/=\\:])\.coordinator(-backups)?([/\\]|\s|$|["'])/, "carpeta de datos local de una instalación antigua (.coordinator/)"],
];
for (const [re, why] of MARKERS) if (re.test(raw)) deny(why);
for (const [re, why] of MARKERS.slice(0, 5)) if (re.test(squashed)) deny(why);

// 3. Human-only CLI verbs and ACC writes.
if (/(server[/\\]cli(\.ts)?|coordinator\s+--|run\s+coordinator)\s+(--\s+)?(approve|passkey-enroll)\b/.test(raw)) deny("aprobar y registrar passkeys lo hace solo un humano");
if (/(server[/\\]cli(\.ts)?|coordinator\s+--|run\s+coordinator)\s+(--\s+)?apply\b/.test(raw)) deny("aplicar en ACC no se hace desde el agente de desarrollo");
const NET = /(\bcurl\b|\bwget\b|invoke-webrequest|invoke-restmethod|\biwr\b|\birm\b|\bfetch\(|https?\.request|\baxios\b|\bundici\b|httpx|requests\.)/;
if (NET.test(raw) && /autodesk\.com|autodesk360|\/bim360\/|\/construction\//.test(squashed)) deny("llamada directa a las APIs de Autodesk (ACC); usa fixtures");
if (NET.test(raw) && /\/api\/coord\/[^\s"']*apply/.test(raw)) deny("aplicación de lotes por HTTP desde el agente");

// 4. Shell writes aimed at the active guard → ask (reads such as `cat .claude/settings.json` pass).
if (/\.claude[/\\](hooks|settings)/.test(raw) && /(>|\bsed\s+-i|\btee\b|\brm\b|\bdel\b|\bmv\b|\bcp\b|copy-item|move-item|remove-item|set-content|out-file|add-content|new-item|writefile|rename-item|robocopy|xcopy)/.test(raw)) {
  decide("ask", `${TAG} El comando modifica la guardia activa del modo desarrollo (.claude/hooks o .claude/settings). Confirma solo si tú lo pediste.`);
}
pass();
