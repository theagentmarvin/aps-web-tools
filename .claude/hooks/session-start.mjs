// SessionStart: inject a short Spanish status block into the agent's context.
// Local filesystem only (no network, never reads the token itself). Must stay fast.
// Fails OPEN (it only adds context); on any error it injects the governance reminder alone.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readInput, projectRoot, loadConfig } from "./_lib.mjs";

const REMINDER =
  "Recordatorio de gobernanza: el uso de este agente se rige por el Procedimiento Acceso Herramientas IA de SalfaCorp. " +
  "Menciónalo brevemente al coordinador al iniciar.";

const LEVELS = { 0: "L0 Observador (solo lectura)", 1: "L1 Proponer (aprobación humana obligatoria)", 2: "L2 Aprobación por políticas", 3: "L3 Autoaplicación de bajo riesgo" };

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
  // v1 server supports at most L1.
  const effective = Math.max(0, Math.min(level, 1));
  lines.push(`Nivel de autonomía efectivo: ${LEVELS[effective]}${level > effective ? ` (configurado L${level}, v1 lo limita a L1)` : ""}.`);

  const fixtures = process.env.COORD_DATA_SOURCE === "fixtures";
  if (fixtures) {
    lines.push("MODO FIXTURES (COORD_DATA_SOURCE=fixtures): datos sintéticos de tests/fixtures, sin red ni ACC. Dilo al coordinador.");
  } else {
    const hasToken = existsSync(join(root, ".coordinator", "auth", "token.json"));
    lines.push(hasToken ? "Sesión APS: hay token en caché (verifica con mcp__coord__get_session_status)." : "Sesión APS: no hay token en caché; el coordinador debe iniciar sesión (UI web o CLI) antes de usar ACC.");
  }

  const projDir = join(root, ".coordinator", "projects");
  if (existsSync(projDir)) {
    const withNotes = readdirSync(projDir).filter((p) => existsSync(join(projDir, p, "notes.md")));
    if (withNotes.length) lines.push(`Notas de proyecto disponibles: ${withNotes.length} (.coordinator/projects/<projectId>/notes.md).`);
  }
  if (process.env.COORD_HARNESS_DEV === "1" || existsSync(join(root, ".coordinator", "harness-dev"))) {
    lines.push("Modo desarrollo del harness activo: se permite editar .claude/, .mcp.json y coordinator.config*.json.");
  }
  emit(lines.join("\n"));
} catch {
  emit(REMINDER);
}
