// SessionStart: inject a short Spanish status block into the agent's context. v2.
// Local only, fast. Login status is NOT checked here (the token lives in the secure directory outside the repo):
// the agent asks mcp__coord__get_session_status. Fails OPEN (it only adds context); on any error it injects
// the governance reminder alone.
import { readInput, projectRoot, loadConfig, isHarnessDev } from "./_lib.mjs";

const REMINDER =
  "Recordatorio de gobernanza: el uso de este agente se rige por el Procedimiento Acceso Herramientas IA de SalfaCorp. " +
  "Menciónalo brevemente al coordinador al iniciar.";

const LEVELS = { 0: "L0 Observador (solo lectura)", 1: "L1 Proponer (aprobación humana con passkey obligatoria)" };

function emit(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
  process.exit(0);
}

try {
  let input = {};
  try {
    input = readInput();
  } catch {
    /* tolerate */
  }
  const root = projectRoot(input);
  const lines = [REMINDER];

  let level = 1;
  try {
    level = loadConfig(root).autonomy?.level ?? 1;
  } catch {
    lines.push("ATENCIÓN: coordinator.config(.local).json no es JSON válido; se asume L1 y el servidor puede rechazar operaciones.");
  }
  const effective = Math.max(0, Math.min(level, 1)); // v1 server supports at most L1
  lines.push(`Nivel de autonomía efectivo: ${LEVELS[effective]}${level > effective ? ` (configurado L${level}, v1 lo limita a L1)` : ""}.`);

  if (process.env.COORD_DATA_SOURCE === "fixtures") {
    lines.push("Fuente de datos: MODO FIXTURES (tests/fixtures, sin red ni ACC; escrituras simuladas). Dilo al coordinador.");
  } else {
    lines.push("Fuente de datos: ACC en vivo. Verifica la sesión APS con mcp__coord__get_session_status antes de trabajar.");
  }
  if (isHarnessDev()) lines.push("Modo desarrollo del harness activo (COORD_HARNESS_DEV=1): se permite editar .claude/, CLAUDE.md, .mcp.json, coordinator.config*.json y el código de la aplicación.");
  emit(lines.join("\n"));
} catch {
  emit(REMINDER);
}
