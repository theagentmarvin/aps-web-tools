# Circuito agente ↔ coordinador: hacerlo visible (propuesta UX)

Fecha: 2026-11-11 · Estado: **propuesta** (no implementada) · Alcance: Coordinación (panel de grupo y de
ubicación), chat, Qué sigue / página del proyecto, Reglas, Aprobaciones.
Mockup navegable (fuera del repo): `loop-mockup.html` en el scratchpad de la sesión que produjo este documento.

El uso de la app y del agente se rige por el *Procedimiento Acceso Herramientas IA* de SalfaCorp.

## 0. Resumen

El circuito existe en el código (regla → propuesta → decisión → lote → ACC; decisión → acierto/corrección →
sugerencia → publicación), pero en la pantalla **no se ve**: el panel dice «El agente propone» aunque la
propuesta venga de una regla, los botones explican sus efectos en un párrafo de 6 líneas, nada confirma qué
aprendió el sistema después de decidir, y el estado de un grupo después de «Aceptar» (¿está en un lote?
¿llegó a ACC?) no aparece en el grupo.

La propuesta agrega cuatro piezas con un mismo lenguaje visual (Motor · Agente IA · Tú · ACC):

1. **Sello de origen** en toda propuesta («Regla EST-004 · acierto 92 % · n=24» / «Agente IA · confianza 0,74» / «Heredada de v41»).
2. **Riel del circuito** de una línea por grupo: Propuesta → Tu decisión → Lote → ACC, y debajo la pista de aprendizaje.
3. **Consecuencias en los botones** (Ahora · Después · Reglas) en lugar del párrafo de ayuda.
4. **Recibo de la decisión** que dice qué cambió y qué aprendió el sistema; y un **tablero del ciclo** en la página del proyecto.

## 1. Cómo se hizo el diagnóstico

- Demo offline (`npm run demo -- --port 3041`, fixtures, `.coordinator-demo/`), v41 y v42 analizadas por la API,
  capturas con Edge sin interfaz (no hay Playwright instalado). Sin ACC, sin agente activo («Agente inactivo»).
- Capturas: `02-grupo-CLIxEST.png` (grupo F-add78d4fc0, 9 ubicaciones), `06-ubicacion.png` (G-9ff7543f88),
  `04-reglas.png`, `05-proyecto.png`.
- Lectura de `FamilyPanel.tsx`, `FamilyDialogs.tsx`, `DetailPanel.tsx`, `ChatPanel.tsx`, `store.ts`,
  `server/families.ts`, `server/coordinator-ui.ts`, `server/rule-suggest.ts` (`accuracy()`), `server/api/contract.ts`.

## 2. Diagnóstico

### P1 · El origen de la propuesta está mal rotulado o escondido (alto)
- `families.proposal` = «El agente propone · Decisión propuesta para el grupo» se muestra **siempre**
  (`FamilyPanel.tsx` › `FamilyProposal`, h3 `#fp-proposal`). En la demo no corrió ningún agente y el grupo
  F-add78d4fc0 lo proponen las reglas EST-004, EST-005 y TOL-001. Lo mismo en la ubicación:
  `detail.proposal` = «Propuesta del agente» con el chip de confianza «Alta» que es la confianza **de la regla**
  (`DetailPanel.tsx`, h3 `#dp-proposal`). Ya registrado como G22 en `coordinator-journey-2026-11.md`.
- La regla aparece al final, en 11 px, **debajo** del párrafo de ayuda («Propuesta de la regla EST-004,
  EST-005, TOL-001», `ruleLine()`), sin acierto ni n. En la ubicación, las reglas están dentro del acordeón
  cerrado «Razonamiento completo y reglas».
- **Defecto de datos:** cuando hay propuesta del agente (`f.pendingProposals[0]`), el panel muestra el chip
  «Sugerida por el agente» y el *razonamiento* del agente, pero los **valores** (Validez/Acción/Corrige/Solución)
  siguen viniendo de `f.proposed` (motor): `store.familyDraft()` nunca lee `pendingProposals[].payload`.
  Si el agente propone algo distinto de la regla, el coordinador ve el texto del agente junto a los valores
  de la regla, y «Aceptar propuesta» acepta **los de la regla**. Hay que verificarlo con un caso de
  `propose_family_decision` real antes de rediseñar; si se confirma, es un bug, no solo UX.
- En Aprobaciones, `batch.originAccepted` = «Aceptada (IA)» se usa también para propuestas del motor
  (`ChatCard.origin: "ai_accepted"` no distingue regla de agente).

### P2 · Los botones no muestran su consecuencia en el momento de decidir (alto)
- `families.actionsHelp` es un párrafo de ~60 palabras siempre visible (6 líneas a 380 px) que explica los tres
  botones a la vez; se deja de leer al tercer grupo. Lo importante (no se escribe en ACC ahora; qué cuenta para
  la regla) está en el diálogo (`approveFootnote`), no en el panel.
- La semántica de «cuenta como acierto» es más fina que el texto: en `rule-suggest.ts › accuracy()` una decisión
  de grupo cuenta **una vez por ubicación cubierta**, contra la regla dominante de **esa ubicación**
  (`ruleIds[0]`); solo comparan **validez y responsable** (corregir solo la acción sigue siendo acierto);
  «Decidir una por una» no cuenta. Ninguna de esas reglas es visible.
- Inconsistencia entre paneles: grupo = Aceptar propuesta / Corregir / Decidir una por una (A/E/X); ubicación =
  Aceptar / Cambiar / Rechazar / Posponer (A/E/X/S). La misma tecla X significa cosas distintas y
  «Corregir» se llama «Cambiar» en la ubicación.
- Tras «Corregir», el botón es «Guardar corrección y aplicar» (`families.useChanges`): «aplicar» se lee como
  «aplicar en ACC», que es otra cosa (aplicar el lote).

### P3 · Después de decidir no hay recibo ni «qué sigue» en el grupo (alto)
- El toast `families.approved` («Propuesta aceptada: 9 ubicaciones, 43 interferencias. Envíala a aprobación
  cuando termines.») desaparece en segundos y no dice nada del aprendizaje.
- El chip «Decidido por {user} · v{version}» es el único estado. El grupo no sabe si ya está en un lote,
  si el lote está aprobado o si en ACC ya existe la incidencia (`TriageFamily.pendingSend`, `issue.accIssueIds`
  y `acc` existen, pero no hay referencia al lote).
- En la barra, «Enviar 0 a aprobación» y «0/84» no se conectan visualmente con el grupo recién decidido.

### P4 · La pista de aprendizaje está en otra página y sin causa-efecto (medio)
- Reglas tiene acierto, n, «corrección más frecuente» (tooltip) y sugerencias con cadena de etapas
  (`SuggestionCard`, `rules.stage.*`), y el recuadro «Cómo funcionan las reglas» explica el ciclo en texto.
  Pero desde el grupo no se ve cuánto lleva la regla, cuántas correcciones iguales hay, ni que «Curar reglas»
  se sugiere con ≥ 5 correcciones sin curar (`next-steps.ts`) o que < 70 % con n ≥ 5 marca «calibrar».
- `RuleSuggestion.feedbackCount` dice cuántas correcciones respaldan una sugerencia, pero no **cuáles**
  (no se puede ir de «tu corrección del martes» a «la sugerencia que generó»).

### P5 · En el chat, propuestas, preguntas y flujos se parecen y el verbo engaña (medio)
- `ProposalCard` usa el mismo fondo violeta para propuesta y pregunta; solo cambia la etiqueta.
- El botón principal dice «Aplicar» (`chat.apply`), y su efecto real es **abrir** el flujo normal
  («Abierta en el flujo normal: revisa y decide ahí.»). «Aplicar» es la palabra de ACC en el resto de la app.
- «Descartar» es solo estado local de la tarjeta: la propuesta sigue pendiente en el servidor y el agente no
  recibe ese rechazo como feedback.

### Lo que ya funciona y conviene reutilizar
- «Qué sigue» ya distingue **Trabajo del agente** (chip violeta) y **Tu decisión** (chip ámbar) — es la semilla
  del lenguaje visual.
- La barra violeta izquierda de «Preparado por el agente» en la ubicación (`agentMade`).
- La cadena de etapas de `SuggestionCard` (Propuesta → Aprobada · pendiente de publicar → Publicada).
- `QuestionAnswer` ya dice «Esta respuesta decidirá N ubicaciones» / «Solo queda como respuesta».

## 3. Principios de diseño

1. **Cuatro actores, cuatro marcas** — forma + palabra + color, nunca solo color:
   | Actor | Glifo | Palabra | Color (texto / fondo) | Uso |
   |---|---|---|---|---|
   | Motor (reglas) | `⚙` | «Regla EST-004» / «Motor» | `#3F4A56` / `#EEF1F4` | propuestas determinísticas |
   | Agente IA | `✦` | «Agente IA» | `#5B21B6` / `#F3EEFF` (violeta actual) | propuestas, preguntas, sugerencias del agente |
   | Coordinador | `●` | «Tú» / «Tu decisión» | `#A32428` / `#F6E9E9` (marca) | decisiones, correcciones |
   | ACC | `▲` | «ACC» | `#0E5A6B` / `#E6F3F5` | lo que ya se escribió en Autodesk |
   El ámbar queda reservado para avisos (cambió, validez mixta), no para un actor.
2. **El origen va primero**: lo primero que se lee en una propuesta es quién la hizo y cuánto se ha acertado.
3. **Consecuencia en el punto de decisión**: Ahora · Después · Reglas, en una línea cada uno, del botón enfocado.
4. **Cerrar cada vuelta**: toda decisión deja un recibo con su efecto en el lote y en las reglas.
5. **Densidad y teclado intactos**: nada nuevo exige clic para decidir; A/E/X siguen igual; lo nuevo cabe en
   380 px y suma ≤ 2 líneas netas al panel (se recupera el espacio del párrafo de ayuda).
6. **Cifras solo del servidor** (regla 6 de `CLAUDE.md`): ningún número del recibo lo calcula el modelo.

## 4. Componentes propuestos

Medidas para el panel derecho real (~380–400 px; `grid-cols-[96px_1fr]`). Copia exacta en español.

### C1 · Sello de origen (`ProvenanceBadge`)

Reemplaza el h3 «El agente propone · Decisión propuesta para el grupo» y el chip «Sugerida por el agente».

```
┌──────────────────────────────────────────────────┐
│ PROPUESTA PARA EL GRUPO                          │
│ [⚙ Regla EST-004 · acierto 92 % · n=24]  +2 ▾    │
│ Validez   Conflicto                              │
│ Acción    Crear incidencia                       │
│ Corrige   CLI · Climatización · consultados: EST │
│ Solución  Bajar el ducto ~270 mm (verificar ...) │
```

Variantes del sello (texto exacto):

| Caso | Sello | Tooltip / ▾ |
|---|---|---|
| Una regla | `⚙ Regla EST-004 · acierto 92 % · n=24` | «Acierto: de 24 decisiones sobre sus ubicaciones, 22 mantuvieron su resultado. Corrección más frecuente: responsable EST → CLI (2).» |
| Regla sin datos | `⚙ Regla EST-004 · sin datos (n=3)` | «Con menos de 5 decisiones no se calcula el acierto.» |
| Regla bajo 70 % | `⚙ Regla EST-004 · acierto 61 % · n=18 · por calibrar` | + enlace «Ver en Reglas» |
| Varias reglas | `⚙ Regla EST-004 · 7 ubic.` `+2 ▾` | ▾ abre: «EST-004 · 7 ubic. · 92 %», «EST-005 · 1 ubic. · sin datos», «TOL-001 · 1 ubic. · 88 %» |
| Respaldo DEF-999 | `⚙ Sin regla (DEF-999) · revisión humana` | «Ninguna regla cubre este caso. Tu decisión puede servir para crear una.» |
| Agente IA | `✦ Agente IA · confianza 0,74` + línea `⚙ La regla EST-004 decía: Conflicto · CLI` | Valores del agente; las diferencias con la regla se marcan con `≠` en la fila |
| Heredada | `↺ Heredada de v41 · decidida por {usuario}` | «Misma decisión que en v41. Confírmala si nada cambió.» |
| Ya decidida | `● Tu decisión · v2 · {usuario}` | reemplaza «Decisión del grupo» |

Diferencia agente ≠ regla (por fila, no solo color):
```
Validez   Dentro de tolerancia  ≠ regla: Conflicto
```
En la ubicación (`DetailPanel`), el mismo sello reemplaza «Propuesta del agente» y el chip de confianza
pasa dentro del sello («⚙ Regla EST-004 · confianza alta»). La barra violeta izquierda se mantiene solo
cuando `origin === "agent"`.

### C2 · Riel del circuito (`LoopRail`) — debajo del encabezado del grupo

Una línea de pasos (24 px) + una línea de texto. Cuatro pasos con glifo de actor; estado por forma:
`●` hecho, `◉` actual, `○` pendiente, `✕` falló.

```
⚙ Propuesta ── ◉ Tu decisión ── ○ Lote ── ○ ACC
Pendiente: decide el grupo (A · E · X).
```
Estados y texto de la segunda línea:

| Estado | Riel | Línea |
|---|---|---|
| Sin decidir | ● ◉ ○ ○ | «Pendiente: decide el grupo (A · E · X).» |
| Decidido, no enviado (`pendingSend > 0` o sin lote) | ● ● ◉ ○ | «Lista para enviar · «Enviar a aprobación» en la barra superior.» |
| En lote listo | ● ● ◉ ○ | «En el lote L-0012 · falta aprobar con passkey.» (enlace) |
| Lote aprobado | ● ● ● ◉ | «Lote aprobado · falta aplicarlo en ACC.» |
| Aplicado | ● ● ● ● | «En ACC: incidencia #103 · 9 de 9 ubicaciones.» |
| Falló en ACC | ● ● ● ✕ | «Falló en ACC: {mensaje}. Revisa el lote.» |
| Una por una | ● ✕ ○ ○ | «Sin decisión de grupo: decides cada ubicación (3 de 9 hechas).» |

Debajo, plegada por defecto en una línea (pista de aprendizaje):
```
Aprendizaje  ● 1 corrección tuya → ✦ sin sugerencia aún → ⚙ —
```
Con datos: «● 3 correcciones «responsable EST → CLI» → ✦ Sugerencia S-014 (calibrar EST-004) → ⚙ Publicada v2».
Clic en la pista: abre Reglas › la regla, con la sugerencia expandida.

### C3 · Botones con consecuencias (`ActionConsequence`)

Mismos tres botones y teclas. El párrafo `families.actionsHelp` se reemplaza por un bloque de 3 líneas que
muestra la consecuencia **del botón con foco o hover** (por defecto, Aceptar). `aria-describedby` de cada
botón apunta a su bloque; el lector de pantalla lo lee al enfocar.

```
[ Aceptar propuesta  A ] [ Corregir  E ] [ Una por una  X ]
Ahora    9 ubicaciones quedan decididas: Conflicto · Crear incidencia · CLI.
Después  Van al próximo lote → apruebas con passkey → 1 incidencia en ACC.
Reglas   +7 aciertos EST-004 · +1 EST-005 · 1 corrección TOL-001.
```
Copia por botón:

- **Aceptar propuesta (A)** — Ahora: «{n} ubicaciones quedan decididas: {validez} · {acción} · {responsable}.» ·
  Después: «Van al próximo lote → apruebas con passkey → {k} incidencia(s) en ACC.» (cierre: «→ se cierran
  {c} interferencias en ACC.») · Reglas: «+{a} aciertos {regla}…» (si el agente propuso distinto:
  «Corrige a {regla}: {de} → {a}. Suma un acierto al agente.»).
- **Corregir (E)** — Ahora: «Cambias validez, acción o responsable para todo el grupo.» · Después: «Igual que
  Aceptar: lote → passkey → ACC.» · Reglas: «Cambiar validez o responsable cuenta como corrección de la regla;
  cambiar solo la acción no.»
- **Una por una (X)** — Ahora: «El grupo queda sin decisión; cada ubicación conserva su propuesta.» · Después:
  «Decides en cada ubicación; nada va al lote hasta entonces.» · Reglas: «No cuenta; cuentan tus decisiones
  por ubicación.»

Botón: «Decidir una por una» → «Una por una» (cabe en 1 línea a 380 px; tooltip con el nombre largo).
Tras corregir: «Guardar corrección y aplicar» → **«Guardar corrección»** (el diálogo de confirmación sigue).
Ubicación: «Cambiar» → **«Corregir»** (misma palabra que en el grupo; tecla E sin cambio).

### C4 · Recibo de la decisión (`DecisionReceipt`)

Aparece **dentro del panel**, arriba de la propuesta, después de confirmar; queda hasta cambiar de grupo
(no es un toast). Mismo texto en `aria-live="polite"`.

```
┌ ● Decisión registrada ─────────────────── Deshacer ┐
│ 9 ubicaciones · 43 interferencias → listas para    │
│ el lote.                                           │
│ Aprendizaje: ⚙ +7 aciertos EST-004 · +1 EST-005 ·  │
│ 1 corrección TOL-001 (Dentro de tolerancia →       │
│ Conflicto).                                        │
│ Siguiente: Enviar a aprobación (12 listas)  →      │
└────────────────────────────────────────────────────┘
```
Variantes:
- Corrección: «● Corrección registrada · responsable EST → CLI en EST-004. Es la 3.ª igual en este proyecto;
  con 5 sin curar, Qué sigue propone «Curar reglas».»
- Regla cruza el umbral: «EST-004 bajó a 68 % (n=25): queda marcada para calibrar en Reglas.» (enlace)
- Agente aceptado: «✦ Aceptaste la propuesta del agente (confianza 0,74). Para la regla EST-004 cuenta como
  corrección: Conflicto → Dentro de tolerancia.»
- Una por una: «Grupo liberado: decide cada ubicación. No cuenta para la regla.»
- Toast: se mantiene corto y con el mismo inicio («Decisión registrada · 9 ubicaciones»).

### C5 · Tablero del ciclo (`CycleLoopCard`) — página del proyecto, bajo «Qué sigue»

Ancho completo de la página del proyecto (≥ 900 px); versión compacta (solo la fila 2) arriba de Reglas.

```
Ciclo v42 · cómo va el circuito                                   Ver lote L-0012
Propuestas         Tus decisiones          Lote              ACC
⚙ 43 motor         ● 30 aceptadas          36 en lote        ▲ 0 aplicadas
✦ 12 agente IA     ● 6 corregidas          aprobado: no
                   ○ 9 pendientes
████████████████████████████░░░░░░  36 de 45 ubicaciones decididas

Aprendizaje        ● 6 correcciones → ✦ 2 sugerencias → ⚙ 1 publicada
Acierto del motor  v40 81 % · v41 86 % · v42 89 %   ▁▃▅   (n=212)
Acierto del agente 9 de 12 aceptadas sin cambios (75 %)
```
La barra de progreso tiene texto, y cada segmento lleva su cifra; el sparkline tiene la serie en texto.

### C6 · Chat y Reglas con el mismo lenguaje

- `ProposalCard`: encabezado «✦ Agente IA propone · Decisión de grupo» (violeta); pregunta: borde punteado y
  «? Pregunta del agente · decide 4 ubicaciones» (o «· no decide nada»); flujo: «▶ Flujo del agente».
- Verbo: «Aplicar» → **«Abrir para decidir»**; «Descartar» → **«Rechazar»**, persistido como rechazo de la
  propuesta (feedback al agente, `kind: reject` con motivo opcional).
- Reglas › sugerencias: el chip de origen ya existe («Agente» violeta / «Coordinador»); agregar glifo y
  «Respaldada por {n} correcciones tuyas · Ver» con enlace a esas correcciones en Feedback.
- Aprobaciones: «Aceptada (IA)» → «Aceptada · motor» / «Aceptada · agente IA»; resumen de origen:
  «Origen: 30 del motor · 6 del agente · 6 corregidas · 0 manuales».

## 5. De dónde salen los datos

| Pieza | Existe hoy | Falta (propuesta de contrato) |
|---|---|---|
| Regla(s) por grupo y peso | `FamilyGroup.ruleId`, `clashIds` (cliente: `ruleLine()`) | `TriageFamily.provenance?: { rules: Array<{ ruleId; nameEs; groups; clashes }> }` (servidor, para no recalcular) |
| Acierto de la regla | `RuleRow.accuracy {agree,n,rate,topCorrection}`, `minAccuracyN` (`GET /rules/overview`) | `GET /rules/accuracy?ids=` liviano, o incluir `accuracy` en `provenance.rules[]` |
| Propuesta del agente (valores) | `pendingProposals[].payload` (sin tipo) | Tipar `payload` como `Partial<FamilyDecisionFields> & { confidence?: number }`; `familyDraft()` debe usarlo cuando existe (ver P1) |
| Confianza de la ubicación | `Proposal.origin`, `ProposalField.confidence`, `ruleIds` | — |
| Heredada | `FamilyInstance.inheritance`, `legacyDecisions`, `Proposal.inherited` | — |
| Paso «Tu decisión» | `TriageFamily.decision`, `state` | — |
| Paso «Lote» | `pendingSend` (solo «no enviado») | `TriageFamily.batch?: { id; state: BatchState; stale: boolean }` |
| Paso «ACC» | `issue.accIssueIds`, `acc` (`AccState`) | `BatchItem.result` por familia (ya existe en el lote; exponer resumen en la familia) |
| Recibo: aciertos/correcciones | Lógica en `rule-suggest.ts › accuracy()` (por ubicación, `ruleIds[0]`, validez + responsable) | `FamilyDecisionResponse.learning: Array<{ ruleId; agree; corrected; label? }>` + `ruleAfter: { ruleId; rate; n; flagged }` — calculado por el servidor con la **misma** función; también en `previewFamilyDecision` para la línea «Reglas» de C3 |
| «3.ª corrección igual · umbral 5» | `CorrectionRow`, umbral de `next-steps.ts` (`THRESHOLDS`) | `learning[].sameCorrectionCount`, `curationThreshold` |
| Sugerencia generada por mis correcciones | `RuleSuggestion.feedbackCount`, `state` | `RuleSuggestion.feedbackIds: string[]` (o `decisionIds`) |
| Tablero: decisiones | `useProgress`, `Batch.origin {accepted,corrected,manual}` | `GET /projects/:id/cycle-loop?testKey` → `{ proposals: {engine, agent}, decisions: {accepted, corrected, oneByOne, pending}, batch: {id,state,items}, acc: {applied, failed}, learning: {corrections, suggestions, published}, accuracyByVersion: [{version, agree, n}], agent: {proposals, acceptedUnchanged} }` |
| Acierto del agente | `GET /learning/calibration` (`byField[].source: "rule" \| "llm"`, `bands`) | reutilizar; agregar total por ciclo |
| Origen en el lote | `ChatCard.origin: ai_accepted \| ai_corrected \| manual` | `proposer: "engine" \| "agent"` por ítem |

Nota de exactitud: el texto del recibo debe salir de la respuesta del servidor, no de un cálculo del cliente,
porque `accuracy()` excluye ubicaciones con decisión propia y decisiones `carriedFrom`; un cálculo paralelo en
el cliente divergiría.

## 6. Plan por fases

**Fase 0 — correcciones (≤ 1 día, solo cliente + i18n)**
1. Rótulo por origen: «Propuesta del motor» / «Propuesta del agente IA» / «Tu decisión» según
   `Proposal.origin` y `pendingProposals.length` (cierra G22). Grupo: «Propuesta para el grupo».
2. Sello simple con la regla dominante arriba (mover `ruleLine()` al encabezado de la tarjeta).
3. «Guardar corrección y aplicar» → «Guardar corrección»; «Cambiar» → «Corregir»; chat «Aplicar» → «Abrir para decidir».
4. Verificar el defecto de P1 (valores del agente no usados); si se confirma, usar el payload en `familyDraft()`.

**Fase 1 — consecuencias y recibo (2–3 días)**
5. C3 con texto estático (sin cifras de reglas) reemplazando `actionsHelp`.
6. C4 con lo que ya devuelve el cliente (ubicaciones, interferencias, siguiente paso) + Deshacer.
7. Servidor: `learning` en `decideFamily` y en `previewFamilyDecision`; activar la línea «Reglas» de C3/C4.
8. Acierto en el sello (`provenance.rules[].accuracy`).

**Fase 2 — riel y lenguaje común (3–5 días)**
9. `TriageFamily.batch` + C2 (riel) en grupo y ubicación.
10. Lenguaje visual común: tokens `--actor-engine|agent|human|acc` en Tailwind, glifos, aplicar a chat, Reglas, Aprobaciones (`proposer` en ítems del lote).
11. Rechazo persistido de propuestas del agente desde el chat.

**Fase 3 — tablero y trazabilidad del aprendizaje (1 semana)**
12. `GET /projects/:id/cycle-loop` + C5 en la página del proyecto y versión compacta en Reglas.
13. `RuleSuggestion.feedbackIds` + pista de aprendizaje clicable (corrección → sugerencia → publicada).
14. Serie de acierto por versión (instantánea por test clasificado).

Medición: tiempo por grupo (pie de página «mediana») no debe subir; en una prueba con 3 coordinadores,
preguntar después de 10 grupos «¿quién propuso esto?» y «¿qué pasa en ACC si aceptas?» (meta: 3/3 correctas).

## 7. Preguntas abiertas para el product owner

1. **Agente vs regla en conflicto**: cuando el agente propone distinto de la regla, ¿se muestra la del agente
   como principal (con «≠ regla») o las dos lado a lado y el coordinador elige? (El mockup usa la primera.)
2. ¿Aceptar la propuesta del agente debe contar como **corrección** de la regla (hoy sí, implícitamente) o
   como neutral? Afecta el acierto de las reglas cuando el agente es bueno.
3. ¿El acierto en el sello se muestra por proyecto o global (todas las pruebas clasificadas, como hoy)?
4. ¿Corregir solo la **acción** debe seguir contando como acierto? (Hoy sí; el texto lo dice explícitamente.)
5. ¿El tablero del ciclo va en la página del proyecto (propuesto) o como pestaña «Circuito» en Reglas?
6. ¿Se quiere el acierto del **agente** visible para el coordinador (riesgo: sobreconfianza) o solo en Reglas?
7. Color de ACC: ¿teal propio o el azul de Autodesk? (No usar marca de Autodesk sin revisar.)
