---
name: curar-reglas
description: Revisa las correcciones acumuladas de los coordinadores y propone cambios a las reglas de clasificación (rules/*.yaml) con evaluación, para que un humano los apruebe y haga merge. Usar para "curar reglas", "aprender de las correcciones", "mejorar reglas".
argument-hint: "[projectId | desde AAAA-MM-DD]"
disable-model-invocation: true
context: fork
agent: rules-curator
background: false
---

Revisa el feedback no curado (filtro opcional: $ARGUMENTS) y propone cambios de reglas siguiendo tus
instrucciones. Devuelve el resumen de propuestas creadas, candidatos descartados y patrones que requieren
decisión humana.
