// PreToolUse guard for shell tools (Bash, PowerShell, Monitor).
// Shell text matching is best effort (it can be evaded); the real controls are that the APS token
// never leaves the MCP server and the approval key is unreadable. This hook catches mistakes and
// naive prompt injections. It fails CLOSED on unreadable input.
import { readInput, projectRoot, decide, pass, block, isHarnessDev, TAG } from "./_lib.mjs";

let input;
try {
  input = readInput();
} catch (e) {
  block(`${TAG} Entrada de hook ilegible; comando bloqueado (${e.message}).`);
}

const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
const cmd = typeof ti.command === "string" ? ti.command : typeof ti.script === "string" ? ti.script : "";
if (!cmd) pass();

const root = projectRoot(input);
const dev = isHarnessDev(root);
const c = cmd.replace(/\\/g, "/"); // normalise Windows separators

const WRITE_OPS = new RegExp(
  [
    // redirections, excluding 2>&1, >/dev/null, >$null, =>, ->
    String.raw`(?<![-=<>&\d])>>?\s*(?!&|/dev/null|\$null|nul\b)[^\s|;&]`,
    String.raw`(^|[\s;|&(])(tee|sed\s+-i|perl\s+-[a-z]*i|rm|mv|cp|del|erase|copy|move|ren|rename|touch|truncate|chmod|icacls|git\s+(checkout|restore|apply)|Set-Content|Add-Content|Out-File|Clear-Content|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item)\b`,
    String.raw`writeFile|appendFile|rmSync|unlinkSync|renameSync|copyFile`,
  ].join("|"),
  "i",
);
const NET_CLIENT =
  /(\bcurl\b|\bwget\b|Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b|fetch\(|https?\.(get|request)|axios|requests\.|urllib|Net\.WebClient|\bnode\s+(-e|--eval|-p)\b|\btsx\s+-e\b|\bpython[0-9.]*\s+-c\b)/i;

const rules = [
  {
    // Secrets, tokens and the approval machinery: no shell access at all (read or write), even in dev mode.
    test: () =>
      /\.coordinator\/+(auth|secret|secrets|approvals?|batches|proposals?|store|audit|feedback)(\/|\b)/i.test(c) ||
      /approval\.key|token\.json/i.test(c),
    reason: "acceso por shell a tokens, secretos, aprobaciones, propuestas o auditoría de .coordinator/",
  },
  {
    test: () => /(^|[\s"'=/])\.env(\.local|\.[\w-]+\.local)?(?![\w.-])/i.test(c) || /APS_CLIENT_SECRET/i.test(c),
    reason: "lectura de secretos (.env / .env.local / APS_CLIENT_SECRET)",
  },
  {
    // All ACC/APS traffic must go through the `coord` MCP server.
    test: () => /autodesk\.com|autodesk360\.com/i.test(c) && NET_CLIENT.test(c),
    reason: "llamada directa a APIs de Autodesk; usa las herramientas mcp__coord__*",
  },
  {
    // The human approval CLI. verify-approval (read-only check) stays allowed.
    test: () =>
      /(server\/cli(\.ts)?|npm\s+run\s+coordinator|\bcoordinator\s+--)/i.test(c) &&
      /\b(approve|reject|sign|approve-batch|set-level|autonomy)\b/i.test(c.replace(/verify-approval/gi, "")),
    reason: "las aprobaciones y el nivel de autonomía solo los cambia un humano (UI web o CLI interactiva)",
  },
  {
    test: () => !dev && /harness-dev/i.test(c),
    reason: "el modo de desarrollo del harness solo lo activa un humano",
  },
  {
    // Harness configuration: writes blocked unless a human enabled harness-dev mode.
    test: () =>
      !dev &&
      /(coordinator\.config(\.local)?\.json|\.mcp\.json|\.claude\/(settings(\.local)?\.json|hooks\/|agents\/|skills\/)|CLAUDE\.md)/i.test(c) &&
      WRITE_OPS.test(c),
    reason: "modificación por shell de la configuración del agente (.claude/, .mcp.json, coordinator.config*.json, CLAUDE.md)",
  },
  {
    // Rules change only via propose_rule_change (or an Edit, which prompts the human).
    test: () => /(^|[\s"'/])rules\/[^\s"']*\.ya?ml/i.test(c) && WRITE_OPS.test(c),
    reason: "escritura por shell en rules/; usa /curar-reglas (propose_rule_change)",
  },
];

for (const r of rules) {
  if (r.test()) decide("deny", `${TAG} Bloqueado: ${r.reason}.`);
}
pass();
