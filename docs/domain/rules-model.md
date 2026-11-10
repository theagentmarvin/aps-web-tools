# Reglas: cómo funcionan y quién hace qué

Página **Reglas** de la UI · motor en `core/` · archivos en `rules/`.

## Qué es una regla
Una regla dice qué hacer con un tipo de interferencia: «si una instalación atraviesa una viga → Conflicto,
responsable la instalación, crear incidencia». Las reglas están en `rules/classification-rules.yaml`. El motor
las prueba **en orden y aplica la primera que coincide**, y con eso arma las propuestas que el coordinador ve en
Coordinación (validez, responsable, severidad, acción). Lo que ninguna regla cubre cae en la **regla de
respaldo DEF-999**: Conflicto con revisión humana. Es el lado seguro.

Las **alertas automáticas** (`annotations`, ANN-001…006) no son reglas: agregan etiquetas como
`seguridad_personas` o `requiere_calculista`, que obligan a revisión humana. No se retiran ni se calibran desde la UI.

## Quién hace qué
| | Agente | Coordinador |
|---|---|---|
| Descubrir condiciones nuevas | Sí: `get_rule_insights` al final de cada ciclo (lo que cae en DEF-999 o en falta de información, reglas corregidas, reglas sin uso, reglas de la Biblioteca que volverían a servir) | No (por diseño) |
| Proponer regla nueva | Sí (`propose_rule_change`, `changeKind: new`) | No |
| Calibrar resultado y umbrales (mm, tolerancias) | Propone | Sí: «Calibrar» |
| Editar condiciones | Propone | Sí: «⋯ › Editar condiciones» (formulario guiado o YAML avanzado) |
| Retirar / restaurar | Propone (también en lote) | Sí: «⋯ › Retirar», Biblioteca › «Restaurar» |
| Aprobar y publicar | **Nunca** | Sí: aprobar y publicar con passkey |

Todo cambio, venga del agente o del coordinador, es la misma **sugerencia** con el mismo ciclo:
**propuesta → aprobada → publicada** (y «Revertir»). Publicar pide la passkey, vuelve a evaluar las reglas
(sin regresiones en los escenarios ni en las decisiones ya tomadas), deja respaldo y queda en la auditoría.

## Precedencia (la primera que coincide gana)
- Una regla nueva entra **al final de su sección** (HYG > DUP > FP > SEI > TOL > CLR > NI > INC > ELV > EST > AE >
  MA > MM), siempre antes de DEF-999. El servidor elige el lugar, no el autor.
- Calibrar o editar **mantiene la posición** de la regla.
- Antes de enviar, «Ver impacto» muestra cuántas interferencias y ubicaciones cambian en el test elegido, qué
  reglas la tapan («esta regla nunca se aplicaría porque X la tapa») y a cuáles les quita interferencias.

## Biblioteca
Retirar una regla la mueve a `rules/classification-rules.archive.yaml`. El motor **no** lee ese archivo. Guarda
la regla completa y las reglas que la precedían en su sección, para que «Restaurar» la devuelva a la misma
precedencia. Sus interferencias pasan a la siguiente regla que coincida o, en último caso, a DEF-999 (revisión
humana). La publicación de un retiro solo pasa si todo escenario de evaluación que cambia cae en DEF-999.

## Seguridad (reglas duras de `CLAUDE.md`)
- El servidor rechaza una regla que cerraría (No es problema / Dentro de tolerancia) interferencias de estructura
  o de seguridad de las personas sin revisión humana. Las pasadas en estructura las decide el calculista.
- Textos (nombre, motivo) sin URLs, correos ni menciones @.
- Nadie edita `rules/` a mano: la única escritura es «Publicar».

## Columnas de la tabla
- **En este proyecto**: interferencias y ubicaciones cuya regla ganadora es esa, en el test elegido. Un clic
  abre Coordinación filtrada por la regla (`?regla=ID`, chip removible). «Sin uso» = 0 en todos los tests.
- **Acierto**: de las decisiones humanas sobre sus ubicaciones, cuántas mantuvieron su resultado (n). Con menos
  de 5 decisiones dice «sin datos»; bajo 70 % se marca para calibrar.
