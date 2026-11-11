// SessionStart for the IN-APP agent: a short Spanish status block. Fails OPEN (it only adds context); on any
// error it injects the governance reminder alone. The chat agent is told not to repeat it (the UI shows it).
import { readInput, loadConfig } from "./_lib.mjs";

const REMINDER = "Gobernanza: el uso de este agente se rige por el Procedimiento Acceso Herramientas IA de SalfaCorp.";
const LEVELS = { 0: "L0 Observador (solo lectura)", 1: "L1 Proponer (aprobación humana con passkey obligatoria)" };

function emit(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
  process.exit(0);
}

try {
  try {
    readInput();
  } catch {
    /* tolerate */
  }
  const lines = [REMINDER, "Agente de la app (chat o flujo): usas la app con las herramientas mcp__coord__*; nunca cambias la app."];
  let level = 1;
  try {
    level = loadConfig().autonomy?.level ?? 1;
  } catch {
    lines.push("ATENCIÓN: coordinator.config(.local).json no es JSON válido; se asume L1.");
  }
  const effective = Math.max(0, Math.min(level, 1));
  lines.push(`Nivel de autonomía efectivo: ${LEVELS[effective]}.`);
  lines.push(
    process.env.COORD_DATA_SOURCE === "fixtures"
      ? "Fuente de datos: MODO FIXTURES (datos de demostración, sin ACC; escrituras simuladas)."
      : "Fuente de datos: ACC en vivo.",
  );
  emit(lines.join("\n"));
} catch {
  emit(REMINDER);
}
