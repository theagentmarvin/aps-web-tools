---
name: curar-reglas
description: Busca condiciones nuevas y reglas que ajustar (get_rule_insights + correcciones de coordinadores) y propone reglas nuevas, calibraciones, retiros o restauraciones con evidencia, para que un humano las apruebe y publique en Reglas (passkey). Usar para "curar reglas", "aprender de las correcciones", "mejorar reglas", "reglas sin uso".
argument-hint: "[projectId | testKey | desde AAAA-MM-DD]"
disable-model-invocation: true
context: fork
agent: rules-curator
background: false
---

Busca qué cubrir, calibrar, retirar o restaurar (filtro opcional: $ARGUMENTS) siguiendo tus instrucciones:
primero `mcp__coord__get_rule_insights`, luego el feedback no curado. Devuelve el resumen de sugerencias creadas
(con su tipo: nueva · calibración · condiciones · retiro · restauración), candidatos descartados y patrones que
requieren decisión humana. Nunca apruebas ni publicas: eso lo hace el coordinador en Reglas.
