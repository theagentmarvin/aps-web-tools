---
name: triage
description: Triage rápido de un clash test (elegido o ya en caché) — clasificación determinística, panorama por disciplina y revisión IA solo de los grupos que requieren revisión humana, sin redactar incidencias. Usar para "triage", "panorama", "qué hay en este test", "cuántas son reales".
argument-hint: "[testKey o nombre de vista]"
allowed-tools: mcp__coord__get_session_status mcp__coord__set_active_context mcp__coord__list_clash_tests mcp__coord__ingest_clash_test mcp__coord__run_classification mcp__coord__summarize_clashes mcp__coord__list_groups mcp__coord__get_group mcp__coord__list_proposals Read
---

# Triage

Objetivo: $ARGUMENTS

1. `mcp__coord__get_session_status`. Resuelve la prueba (testKey activo, argumento o
   `mcp__coord__list_clash_tests`); si no está en caché, `mcp__coord__ingest_clash_test`.
2. `mcp__coord__run_classification` (`proposeAutoAccepted: true` si el nivel es ≥ L1).
3. `mcp__coord__summarize_clashes` por `disciplinePair` y por `validity`; si hay más de un nivel, también por
   `level` (topN 10).
4. `mcp__coord__list_groups` con `filter.needsReview: true` → lotes de ≤ 20 IDs → subagente **clash-triager**.
   Además, envía una **muestra QA** de grupos auto-aceptados (5 %, mínimo 2) en un lote marcado
   `MUESTRA QA: confirma o discrepa; propone solo si discrepas`.
5. Responde en ≤ 15 líneas: panorama (reales / falsos positivos / toleradas / requieren información),
   top 5 grupos por prioridad (groupId, etiqueta, banda), cuántos esperan decisión humana, discrepancias QA,
   y sugiere el flujo «Redactar incidencias» para los reales.

Criterios de clasificación: `{{APP_ROOT}}/docs/domain/clash-taxonomy.md`. No muestres listas de clashes.
