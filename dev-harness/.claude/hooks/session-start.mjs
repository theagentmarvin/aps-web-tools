// SessionStart for the DEVELOPER harness: governance reminder + mode line. Fails OPEN (only adds context).
const REMINDER =
  "Recordatorio de gobernanza: el uso de la IA en SalfaCorp se rige por el Procedimiento Acceso Herramientas IA. " +
  "Menciónalo en una línea al iniciar la sesión.";
const lines = [REMINDER, "Modo desarrollo: pídeme mejoras de la app o del agente con /mejorar o en lenguaje natural."];
lines.push(
  process.env.COORD_DEV_LIVE === "1"
    ? "Servidor coord: datos REALES de ACC en solo lectura (COORD_DEV_LIVE=1). No apliques ni propongas nada; prueba los cambios con fixtures."
    : "Servidor coord: datos de prueba (fixtures, carpeta temporal). Los datos reales y los secretos de los coordinadores están bloqueados.",
);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }));
process.exit(0);
