// PreToolUse guard for MCP tools that are NOT from the `coord` server, inside the APP.
// The server launches the in-app agent with --strict-mcp-config (only `coord`), so no foreign server should be
// present. Backstop, same policy as the repository's v2 guard: configurable in coordinator.config*.json
// (application folder, COORD_APP_ROOT):
//   "foreignMcp": { "mode": "block_writes" | "block_all" | "allow_all", "allow": [globs], "deny": [globs] }
// Precedence: allow globs > deny globs > explicit write list > mode > verb heuristic. Fails CLOSED.
import { readInput, decide, pass, block, loadConfig, TAG } from "./_lib.mjs";

let input;
try {
  input = readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; herramienta MCP externa bloqueada (${e.message}).`);
}

const name = String(input.tool_name ?? "");
if (!name.startsWith("mcp__") || name.startsWith("mcp__coord__")) pass();

let policy;
try {
  policy = loadConfig().foreignMcp ?? {};
} catch (e) {
  decide("deny", `${TAG} Configuración inválida; herramienta MCP externa bloqueada (${e.message}).`);
}

const mode = policy.mode ?? "block_writes";
const globToRe = (g) => new RegExp(`^${String(g).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
const matches = (list) => Array.isArray(list) && list.some((g) => globToRe(g).test(name));

if (matches(policy.allow)) pass();
if (matches(policy.deny)) decide("deny", `${TAG} ${name} está denegada por la política foreignMcp.`);
if (mode === "allow_all") pass();
if (mode === "block_all") decide("deny", `${TAG} El agente de la app solo usa las herramientas mcp__coord__* (política foreignMcp=block_all).`);

const tool = name.slice(name.lastIndexOf("__") + 2);

const EXPLICIT = new Set([
  "send_code_to_revit", "operate_element", "ai_element_filter", "set_parameter", "set_parameter_batch", "set_source_key",
  "delete_element", "build_elements", "load_family", "duplicate_family_type", "change_element_type",
  "create_level", "create_grid", "create_room", "create_line_based_element", "create_point_based_element",
  "create_surface_based_element", "create_structural_framing_system",
]);
if (EXPLICIT.has(tool.toLowerCase())) {
  decide("deny", `${TAG} ${name} modifica el modelo de Revit o ejecuta código en él; no se usa desde el agente de coordinación.`);
}

const words = tool
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map((w) => w.toLowerCase());

const VERBS = new Set([
  "write", "create", "update", "upsert", "delete", "del", "remove", "rm", "set", "put", "post", "patch", "edit", "modify",
  "insert", "add", "append", "save", "store", "upload", "import", "apply", "move", "mv", "rename", "copy", "duplicate",
  "build", "operate", "change", "load", "drop", "truncate", "clear", "reset", "commit", "push", "merge", "publish",
  "deploy", "install", "assign", "close", "reopen", "archive", "restore", "batch", "transaction", "mutate", "submit",
  "sync", "send", "share", "invite", "grant", "revoke", "approve", "sign", "enroll", "register", "mkdir", "touch",
  "exec", "execute", "run", "shell", "bash", "cmd", "powershell", "eval", "evaluate", "script", "code", "invoke",
  "trigger", "spawn", "start", "stop", "kill", "launch",
  "fetch", "http", "https", "request", "download", "navigate", "browse", "click", "fill", "goto", "curl", "webhook", "email", "mail", "message", "notify",
]);
const OPERATIONS = /_operations$|Operations$/;

if (OPERATIONS.test(tool) || words.some((w) => VERBS.has(w))) {
  decide("deny", `${TAG} ${name} parece una herramienta de escritura, ejecución o red de otro servidor MCP; el agente de la app no la usa.`);
}
pass();
