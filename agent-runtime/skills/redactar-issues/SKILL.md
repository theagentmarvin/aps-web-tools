---
name: redactar-issues
description: Redacta borradores de incidencias de ACC en español para grupos de interferencias reales (o los groupId indicados), como propuestas para aprobación humana. Usar para "redactar issues", "crear incidencias", "preparar incidencias para la reunión".
argument-hint: "[G-… G-… | P1 | P1-P2 | todos]"
allowed-tools: mcp__coord__get_session_status mcp__coord__list_groups mcp__coord__get_group mcp__coord__list_proposals Read
---

# Redactar incidencias

Selección: $ARGUMENTS

1. Resuelve los grupos: IDs explícitos; `P1` / `P1-P2` = `validity: real` en esas bandas; `todos` = todos los
   `real`. Incluye grupos `hygiene_issue` (una incidencia por archivo responsable y regla).
   Excluye grupos con propuesta de incidencia pendiente o aprobada (`mcp__coord__list_proposals`).
2. Lotes de ≤ 20 IDs → subagente **issue-writer**, con las convenciones relevantes de las notas del proyecto
   (ruta `projectNotes` que entrega `mcp__coord__get_session_status`).
3. Informa: incidencias redactadas, grupos omitidos y por qué, dudas, y el enlace a `/aprobaciones`.
   Recuerda que el responsable (persona, rol o empresa en ACC), el tipo/subtipo y la vista 3D se fijan en la UI
   al aprobar; la incidencia se crea en ACC vía Model Coordination (`clashes:assign`) solo tras la aprobación.

Guía de redacción (título, plantilla, responsable, plazos): `{{APP_ROOT}}/docs/domain/issue-writing-guide.md`.
