---
name: auditar-modelo
description: Auditoría de higiene de modelos a partir de las interferencias — duplicados, copias de otras disciplinas, ARQ remodelando estructura, elementos sin nivel o sistema, modelos genéricos, documentos sin disciplina. Usar para "auditar modelo", "calidad del modelo", "por qué hay tantos falsos positivos", "higiene".
argument-hint: "[testKey]"
context: fork
agent: model-hygiene-auditor
background: false
---

Audita la higiene de los modelos de la prueba $ARGUMENTS (o la prueba activa si no se indica).
Sigue tus instrucciones y devuelve el informe en el formato definido en ellas.
