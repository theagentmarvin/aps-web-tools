---
name: informe-semanal
description: Genera el informe semanal de coordinación en español — evolución entre versiones del conjunto de modelos, persistentes, avance por disciplina, higiene, propuestas y decisiones de la semana, con narrativa ejecutiva para la reunión. Usar para "informe semanal", "reporte de coordinación", "estado para la reunión", "KPIs".
argument-hint: "[proyecto] [html|md|xlsx]"
allowed-tools: mcp__coord__get_session_status mcp__coord__list_clash_tests mcp__coord__list_model_set_versions mcp__coord__summarize_clashes mcp__coord__diff_test_versions mcp__coord__list_groups mcp__coord__list_proposals mcp__coord__get_model_hygiene_stats Read
---

# Informe semanal

Argumentos: $ARGUMENTS

1. Identifica la prueba actual y la de la semana anterior (misma vista, versión previa más cercana a 7 días).
   Si falta alguna en caché, ingiere y clasifica (avisa del tiempo).
2. Cifras **solo** desde herramientas: `mcp__coord__diff_test_versions` (por `disciplinePair`),
   `mcp__coord__summarize_clashes` (`validity`, `severity`), `mcp__coord__list_proposals` (estados de la semana),
   `mcp__coord__get_model_hygiene_stats` (3 hallazgos principales). KPIs según
   `{{APP_ROOT}}/docs/domain/clash-triage-methodology.md` (paso 9).
3. Escribe una **narrativa ejecutiva** (≤ 250 palabras): tendencia, 3 focos con groupId, persistentes más
   antiguos, decisiones pendientes y recomendación para la reunión. Cada número que cites debe estar en las
   salidas de las herramientas. Sin nombres de personas.
4. `mcp__coord__generate_report` con `kind: "weekly"`, el formato pedido (html por defecto) y `narrative`.
   Comprueba que la narrativa coincide con `headline`; si no, corrige y regenera.
5. Entrega la ruta del archivo y un resumen de 5 líneas.
