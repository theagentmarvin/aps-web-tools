---
name: mejorar
description: Implementa una mejora de la app Coordinador BIM o del agente de la app (chat y flujos) pedida por un coordinador — aclarar, implementar, typecheck y tests, resumen en español, commit cuando el coordinador esté de acuerdo. Usar para "mejora", "agrega", "cambia", "arregla", "que el agente haga…", "que la app muestre…".
argument-hint: "[qué mejorar, en tus palabras]"
---

# Mejorar la app o el agente

Pedido: $ARGUMENTS

1. **Entender.** Si el pedido es ambiguo, haz **como máximo 3 preguntas** cortas (qué pantalla o flujo, qué
   resultado espera, un ejemplo). Si es claro, sigue sin preguntar.
2. **Ubicar.** App: `server/`, `src/`, `core/`. Agente de la app: `agent-runtime/` (agentes, skills, hooks,
   `CLAUDE.md`) + listas de herramientas en `server/chat/bridge.ts`, `server/flows/`, `server/mcp/contracts.ts`.
   Reglas de clasificación: no se editan a mano (flujo Reglas › Publicar).
3. **Implementar** el cambio más pequeño que resuelve el pedido, con tests nuevos o ajustados. Cambios grandes
   (varias áreas, migraciones de datos, cambios de seguridad): crea antes una rama `mejora/<slug>`; los
   pequeños pueden ir en la rama actual.
4. **Verificar:** `npx tsc -p tsconfig.json --noEmit`, `npx tsc -p tsconfig.server.json --noEmit` y
   `npx vitest run` completo. Si cambiaste el comportamiento del agente de la app, corre también
   `npx tsx scripts/eval-agent.ts --self-test` (offline); las evaluaciones reales gastan cuota: ofrécelas, no
   las corras sin permiso. Nunca dejes tests rojos.
5. **Resumen para el coordinador** (español, ≤ 12 líneas): qué cambió, cómo probarlo (pantalla, botón o
   pregunta al chat), riesgos. **Señala explícitamente** si tocaste algo sensible: aprobaciones/passkey,
   escritura en ACC, datos o respaldos, permisos o herramientas del agente de la app.
6. **Commit** cuando el coordinador esté de acuerdo (puede decir "haz commit directo"). Mensaje en inglés,
   claro. Si usaste una rama, ofrece hacer merge a la rama de trabajo.
7. Cierra con: «Reinicia la app con **Coordinador BIM.cmd** para usar el cambio.»
