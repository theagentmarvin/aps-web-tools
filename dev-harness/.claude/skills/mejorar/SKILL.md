---
name: mejorar
description: Implementa una mejora de la app Coordinador BIM o del agente de la app (chat y flujos) pedida por un coordinador — aclarar, implementar, typecheck y tests, resumen en español, rama + commit + PR a main cuando el coordinador esté de acuerdo (el dueño hace el merge). Usar para "mejora", "agrega", "cambia", "arregla", "que el agente haga…", "que la app muestre…".
argument-hint: "[qué mejorar, en tus palabras]"
---

# Mejorar la app o el agente

Pedido: $ARGUMENTS

0. **Rama.** Sigue `CONTRIBUTING.md`: `git remote -v`, `git checkout main`, `git pull --ff-only origin main`,
   `git checkout -b mejora/<tema-corto>`. Si hay cambios sin commit, pregunta antes qué hacer con ellos.
   Nunca trabajes ni hagas push sobre `main`.
1. **Entender.** Si el pedido es ambiguo, haz **como máximo 3 preguntas** cortas (qué pantalla o flujo, qué
   resultado espera, un ejemplo). Si es claro, sigue sin preguntar.
2. **Ubicar.** App: `server/`, `src/`, `core/`. Agente de la app: `agent-runtime/` (agentes, skills, hooks,
   `CLAUDE.md`) + listas de herramientas en `server/chat/bridge.ts`, `server/flows/`, `server/mcp/contracts.ts`.
   Reglas de clasificación: no se editan a mano (flujo Reglas › Publicar).
3. **Implementar** el cambio más pequeño que resuelve el pedido, con tests nuevos o ajustados.
4. **Verificar:** `npm run typecheck`, `npm test` (vitest completo) y `npm run check` (higiene del repo). Si cambiaste el comportamiento del agente de la app, corre también
   `npx tsx scripts/eval-agent.ts --self-test` (offline); las evaluaciones reales gastan cuota: ofrécelas, no
   las corras sin permiso. Nunca dejes tests rojos.
5. **Resumen para el coordinador** (español, ≤ 12 líneas): qué cambió, cómo probarlo (pantalla, botón o
   pregunta al chat), riesgos. **Señala explícitamente** si tocaste algo sensible: aprobaciones/passkey,
   escritura en ACC, datos o respaldos, permisos o herramientas del agente de la app.
6. **Commit, push y PR** cuando el coordinador esté de acuerdo: revisa `git status`/`git diff`, agrega solo los
   archivos del cambio, commit de una línea (inglés, qué y dónde), `git push -u origin <rama>` y
   `gh pr create --base main --fill` (plantilla completa; marca si toca seguridad). **No hagas merge**: lo hace el
   dueño del repo. Entrega el link del PR.
7. Cierra con: «Cuando el dueño haga el merge, cierra la app y ábrela con **Coordinador BIM.cmd**: te ofrecerá
   actualizar.»
