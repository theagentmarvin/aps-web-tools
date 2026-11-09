# Propuestas de cambio de reglas, noviembre 2026 (FP-017/FP-019, FP-018, DUP-007, FP-006 por origen)

Autor: curador de reglas (agente). Fecha: 2026-11-09. Estado: **propuestas, sin aplicar y sin aprobar**. Nada de esto edita `rules/`: cada propuesta es un unified diff que el usuario revisa y aprueba en la página Reglas de la app.
Origen: §3 "Rule improvements the families surfaced" de `docs/domain/solution-families-proposal.md`, medido sobre datos reales.

Datos: proyecto ACC `da524c2d…`, conjunto `71941e30…` **v11**, test `T-3bde5861` (5.549 interferencias MC, 2.619 conflictos únicos tras G0), caché del store leída con los módulos del servidor (`Coordinator.loadRaw` + `runEngine`, mismas opciones que `classify`). Motor del repo al 2026-11-09 (ya incluye familias F1 e invariante 8, por eso la línea base es **245 grupos / 31 familias**, no los 201 / 33 del documento de familias).

## 0. Resumen

| Propuesta | Reglas | Conflictos únicos cambiados (MC) | Validez antes → después (únicos) | Grupos | Grupos en revisión | Familias con real | real → cerrable | Cierres inseguros | Escenarios (26) |
|---|---|---|---|---|---|---|---|---|---|
| P1 Red conectada a su artefacto/equipo | FP-017, FP-019 | 707 (1.414) | real 1.063→807 · tol 563→112 · FP 558→1.265 | 245→203 | 140→141 | 26→24 | 256, justificados uno a uno (§A), todos con humanReview | **0** | 25/26 = hoy, 0 inseguros |
| P2 Cubre-tubería (PIPE COVER) | FP-018 | 104 (208) | real 1.063→959 · FP 558→662 | 245→230 | 140→142 | 26→24 | 104, justificados uno a uno (§A), todos con humanReview | **0** | 25/26 = hoy, 0 inseguros |
| P3 Modelos de estructura superpuestos | DUP-007 | 182 (312) | sin cambios de validez (DEF-999 real → DUP-007 real, higiene a COORD) | 245→208 | 140→**103** | 26→26 (pasan a PT12 por par de archivos) | 0 | **0** | 25/26 = hoy, 0 inseguros |
| P1+P2+P3 juntas | 4 reglas | 993 (1.934) | real 1.063→703 · tol 563→112 · FP 558→1.369 · NI 435→435 | 245→**151** | 140→106 | 26→22 (familias de diseño, sin PT12/PT13: 23→18) | 360 | **0** | 25/26 = hoy, 0 inseguros |
| P4 FP-006 por archivo de origen | FP-006 (+ ajuste DUP-007) | 16 (32), medido fuera de línea | real 16 → FP | — | — | — | 16, justificados (§4) | **0** | no se puede cargar aún |
| Inconsistencia AP→lavamanos (432 tolerated / 96 real) | la resuelve FP-017 (P1) | 528 | 432 tol + 96 real → 528 FP con una sola regla | — | — | familias con validez mixta 6→4 | — | — | — |

"Cierres inseguros = 0" en este documento significa: (a) en los 26 escenarios EV ningún `real` esperado pasa a cerrable (`scripts/eval.ts` con las reglas candidatas), y (b) en v11 ninguna interferencia que hoy es `real` pasa a `false_positive`/`tolerated` sin justificación individual: las 360 que cambian están listadas una por una en el §A con su evidencia geométrica, ninguna atraviesa al anfitrión, y **todas quedan en revisión humana** (confianza 0,65 < 0,70 y `humanReview: true`): ninguna se cierra sola (`newClosuresAutoOk = 0`). Si el coordinador no confirma, siguen abiertas.

**Registro: no se pudo registrar ninguna propuesta.** `propose_rule_change` exige `feedbackIds` con al menos 1 ID existente y el store tiene 0 registros de feedback (§6). No se aplicó ningún atajo.

**Numeración.** El documento de familias llama FP-016 a "red conectada a su artefacto" y FP-017 a "envolvente". FP-016 ya está tomado por "Instalación por pasada modelada" (`core/group/labels.ts`, `tests/engine/phase2.test.ts` y `docs/domain/rules-pending-2026-11.patch`), así que aquí: **FP-017** = tubería conectada a su artefacto sanitario, **FP-018** = cubre-tubería, **FP-019** = ducto conectado a su equipo de clima (el fan-coil, que el documento de familias incluía dentro de su FP-016).

Las tres propuestas son independientes entre sí y con el patch pendiente: se verificó que aplican limpiamente en cualquier orden (P1→P2→P3, P3→P2→P1, P2→P1→P3) y antes o después de `rules-pending-2026-11.patch` (contexto de 2 líneas, sin líneas `name:` en el contexto, que el patch pendiente modifica).

---

## 1. P1: FP-017 + FP-019, red conectada a su propio artefacto o equipo

### Diff

```diff
--- a/rules/classification-rules.yaml
+++ b/rules/classification-rules.yaml
@@ -340,4 +340,28 @@
             rationale: "Elemento enterrado o apoyado en la topografía ({b.category}). Las excavaciones se coordinan aparte; excluir topografía de las pruebas." }
 
+  # FP-017/FP-019: the network's own connection to its fixture/equipment. Placed in FP (before TOL-003)
+  # so the verdict no longer depends on the generic MEP×MEP hard tolerance (10 mm; 5 mm gravity):
+  # the stub's depth inside the fixture body is family geometry, not a design conflict.
+  # New rules: confidence < 0.70 + humanReview until proven on a second project.
+  - id: FP-017
+    name: branch pipe connected to its own plumbing fixture
+    nameEs: "Tubería conectada a su artefacto sanitario"
+    when:
+      clash: { penetrationMm: { lte: 50 } }
+      a: { elementClass: [pipe, gravity_pipe], discipline: [AP, ALC, SAN], sizeMm: { lte: 65 } }
+      b: { category: Plumbing Fixtures }
+    then: { validity: false_positive, nature: hard, rootCause: not_applicable, responsibleDiscipline: COORD, secondaryDiscipline: "$a", severity: none, confidence: 0.65, suggestedAction: close_not_issue, humanReview: true,
+            rationale: "{a.category} de {a.discipline} Ø{a.sizeMm} mm entra {clash.penetrationMm} mm en el artefacto '{b.family}': es la conexión de la red a su propio artefacto (desagüe o alimentación), no una interferencia. Revisar una instancia en el visor: si un tramo recto atraviesa el mueble en vez de terminar en él, reclasificar como real." }
+
+  - id: FP-019
+    name: duct connected to its own fan-coil / air-handling unit
+    nameEs: "Ducto conectado a su equipo de clima"
+    when:
+      clash: { penetrationMm: { lte: 150 } }
+      a: { elementClass: duct, discipline: CLI }
+      b: { category: Mechanical Equipment, discipline: CLI, family: { matches: 'fan ?coil|ventiloconvector|\bfcu\b|\bahu\b|\buma\b|manejadora|air ?handl|cassette' } }
+    then: { validity: false_positive, nature: hard, rootCause: not_applicable, responsibleDiscipline: COORD, secondaryDiscipline: CLI, severity: none, confidence: 0.65, suggestedAction: close_not_issue, humanReview: true,
+            rationale: "Ducto de {a.sizeMm} mm entra {clash.penetrationMm} mm en el equipo '{b.family}': es la conexión de impulsión/retorno del propio equipo, no una interferencia. Revisar una instancia: si el ducto atraviesa el gabinete en vez de conectarse, reclasificar como real." }
+
 # ---------------------------------------------------------------------------
 # SEI — Seismic joints (always real, even inside tolerance).
```

### Fundamento (es)

En v11, 707 conflictos únicos son la conexión de una red a su propio artefacto o equipo: 657 tuberías y fittings de AP (Ø13–16) y ALC (Ø38–41) contra el lavamanos "Bathroom Sink (Yacht)" (vanitorio de 1.670 mm) y 50 ductos de inyección CLI de 356 mm contra el fan-coil vertical "FANCOIL-4-PIPE-NO RISER". Ninguna regla los reconoce como conexión: FP-003 exige el mismo nombre de sistema (el artefacto informa "Sanitary 13" y la tubería de AP su propio sistema de agua fría o caliente) y el mismo archivo (aquí el artefacto y la tubería vienen de las dos copias de MECHANICAL.rvt, docs 1 y 2). Por eso caen en la tolerancia genérica MEP×MEP o en MM-005/MM-002 "la red atraviesa el equipo".

Evidencia de que son conexiones y no cruces: con la caja (bbox) de cada elemento, el tramo de tubería o ducto está **contenido** en la extensión del artefacto a lo largo de su eje (690 de los 707: los 657 del lavamanos y 33 del fan-coil) o **termina dentro** de él (17, todos ductos del fan-coil). De los 256 que hoy son `real`, 239 están contenidos y 17 terminan dentro. **Ninguno lo atraviesa** (0 casos con un extremo a cada lado). La penetración máxima es 40 mm en el lavamanos y 114 mm en el fan-coil, coherente con el largo de un conector.

Acotaciones para no cerrar cruces reales:
- FP-017 solo para tuberías AP/ALC/SAN de Ø ≤ 65 mm (ramales de artefacto) contra la categoría Plumbing Fixtures y con penetración ≤ 50 mm. Un colector Ø110 que pasa por un artefacto no entra.
- FP-019 solo para ductos (no `duct_large`) de CLI contra equipos de CLI cuya familia es fan-coil/UMA/AHU/cassette y con penetración ≤ 150 mm. El ducto troncal de 1.270 mm que toca el mismo fan-coil **sigue real**: es el único conflicto que queda en esa familia y es el que hay que mirar.
- Las reglas van en la sección FP, antes de TOL-003. Así la penetración deja de decidir el veredicto de una conexión (ver §5).
- Reglas nuevas: confianza 0,65 y `humanReview: true`. El coordinador mira una instancia antes de aprobar el cierre del lote; si un tramo recto atraviesa el mueble, lo reclasifica. Alcance `project` hasta confirmarlo en un segundo proyecto (el curador no relaja reglas que protegen `real` con evidencia de un solo proyecto sin dejarlas en revisión).

### Efecto medido (v11)

| Métrica | Antes | Después |
|---|---|---|
| Únicos por validez | real 1.063 · tolerated 563 · FP 558 · NI 435 | real 807 · tolerated 112 · FP 1.265 · NI 435 |
| MC por validez | real 2.576 · tolerated 1.142 · FP 978 · NI 853 | real 2.064 · tolerated 240 · FP 2.392 · NI 853 |
| Transiciones (únicos) | | MM-002 real→FP-017 111 · MM-005 real→FP-017 96 · TOL-003 tol→FP-017 450 · MM-005 real→FP-019 49 · TOL-003 tol→FP-019 1 |
| real → cerrable | | 256 (512 MC), todos con humanReview; geometría: 239 contenido, 17 termina dentro, 0 atraviesa |
| Grupos | 245 (real 195 · FP 17 · tol 15 · NI 18) | 203 (real 153 · FP 20 · tol 12 · NI 18) |
| Grupos en revisión | 140 | 141 (los grupos MM-005 de lavamanos y fan-coil eran `auto_ok` como real; ahora son 3 lotes de cierre en revisión: "528 × … (AP×SIN)", "129 × … (ALC×SIN)", "50 × Ducto conectado a su equipo de clima") |
| Familias | 31, 26 con real, 6 con validez mixta | 30, 24 con real, 4 con validez mixta |
| Familias afectadas | #1 (ALC vs lavamanos, 111 real + 18 tol), #15 (AP vs lavamanos, 96 real + 432 tol), fan-coil (50 real + 1 tol) | las dos de lavamanos se funden en una familia PT14 "regla FP-017" (657 FP); fan-coil queda 50 FP + 1 real |
| Escenarios EV (26) | 25/26, rúbrica 97,3, 0 inseguros, 0 FN críticos | 25/26, rúbrica 97,3, 0 inseguros, 0 FN críticos (la única falla, EV-05, es la misma de hoy: depende del patch M1 de la matriz y falla en el sentido seguro) |

---

## 2. P2: FP-018, cubre-tubería contra las tuberías que envuelve

### Diff

```diff
--- a/rules/classification-rules.yaml
+++ b/rules/classification-rules.yaml
@@ -333,4 +333,16 @@
             rationale: "Revestimiento/pavimento '{a.type}' sobre {b.category} estructural: superposición de capas por modelado, no interferencia." }
 
+  # FP-018: a pipe enclosure (pipe cover / shaft box) is modeled AROUND the pipes; the clash is the
+  # design intent. Fire and gas pipes are left out (life safety keeps its own review).
+  # New rule: confidence < 0.70 + humanReview until proven on a second project.
+  - id: FP-018
+    name: pipe enclosure (pipe cover / shaft box) vs the pipes it encloses
+    nameEs: "Cubre-tubería contra las tuberías que envuelve"
+    when:
+      a: { elementClass: [pipe, gravity_pipe, pipe_large], discipline: { notIn: [INC, GAS] } }
+      b: { category: [Mechanical Equipment, Plumbing Fixtures, Specialty Equipment, Generic Models], anyOf: [ { family: { matches: 'pipe ?(cover|chase|enclosure|box)|cubre ?tuberia|forro de tuberia|shaft ?box|cajon (de )?(tuberias?|shaft)' } }, { type: { matches: 'pipe ?(cover|chase|enclosure|box)|cubre ?tuberia|forro de tuberia|shaft ?box|cajon (de )?(tuberias?|shaft)' } } ] }
+    then: { validity: false_positive, nature: hard, rootCause: not_applicable, responsibleDiscipline: COORD, secondaryDiscipline: "$a", severity: none, confidence: 0.65, suggestedAction: close_not_issue, humanReview: true,
+            rationale: "{a.category} {a.systemName} Ø{a.sizeMm} mm queda dentro del cubre-tubería '{b.family}' ({clash.penetrationMm} mm): el envolvente se modela alrededor de las tuberías por diseño. Verificar una vez la holgura interior (Ø + aislación + 25 mm) y el registro para mantención." }
+
   - id: FP-015
     name: topography or site
```

### Fundamento (es)

El equipo mecánico "PIPE COVER" (doc MECHANICAL.rvt, nivel 401 ROOF) es un envolvente que se modela **alrededor** de los montantes de CAL (Ø41–54, 72 conflictos) y AP (Ø54, 32 conflictos). MM-005 lo lee como "la red atraviesa un equipo" y emite 104 conflictos reales (familias #10 y #12 del documento de familias). Evidencia por caja: 94 tramos terminan dentro del envolvente (el montante entra a la caja) y 10 están contenidos; ninguno lo atraviesa de lado a lado. Penetración 10–78 mm, es decir la tubería queda dentro de la caja.

Acotaciones: solo tuberías (no ductos ni bandejas), excluye INC y GAS (seguridad de las personas mantiene su revisión), y el anfitrión tiene que llamarse cubre-tubería por familia o tipo (`pipe cover/chase/enclosure/box`, `cubre tubería`, `forro de tubería`, `shaft box`, `cajón de tuberías/shaft`) dentro de Mechanical Equipment, Plumbing Fixtures, Specialty Equipment o Generic Models. Confianza 0,65 y `humanReview`: el coordinador verifica una vez la holgura interior (Ø + aislación + 25 mm) y el registro para mantención; si la holgura no alcanza, la familia se reabre como real. Es una convención de nombres de este proyecto: alcance `project`.

### Efecto medido (v11)

| Métrica | Antes | Después |
|---|---|---|
| Únicos por validez | real 1.063 · FP 558 | real 959 · FP 662 (tolerated y NI sin cambio) |
| MC por validez | real 2.576 · FP 978 | real 2.368 · FP 1.186 |
| Transiciones | | MM-005 real→FP-018 104 (208 MC) |
| real → cerrable | | 104, todos con humanReview; 94 terminan dentro, 10 contenidos, 0 atraviesan |
| Grupos | 245 (real 195) | 230 (real 178, FP 19): 17 grupos "Equipo mecánico PIPE COVER atravesado por 8 tuberías…" pasan a 2 lotes "72 × Cubre-tubería… (CAL×CLI)" y "32 × … (AP×CLI)" |
| Grupos en revisión | 140 | 142 |
| Familias | 31, 26 con real | 30, 24 con real (salen las dos familias PT09 PIPE COVER) |
| Escenarios EV (26) | 25/26, 97,3, 0 inseguros | 25/26, 97,3, 0 inseguros |

---

## 3. P3: DUP-007, modelos de estructura superpuestos

### Diff

```diff
--- a/rules/classification-rules.yaml
+++ b/rules/classification-rules.yaml
@@ -219,4 +219,19 @@
             rationale: "La losa de ARQ '{a.type}' duplica la losa estructural '{b.type}'. ARQ debe modelar solo pavimento/sobrelosa sobre la losa de EST vinculada." }
 
+  # DUP-007: structure × structure from DIFFERENT model files = two structural models superimposed
+  # (revisions loaded together, a foreign model, or a linked copy). NOT a closure: validity stays
+  # `real` (as DUP-003), but the owner is COORD and the action is hygiene_issue, so G2 batches it per
+  # file pair: one model-set decision instead of N design issues to the "mover".
+  # New rule: confidence < 0.70 + humanReview; in projects with a legitimately split structure
+  # (e.g. concrete + steel files) the coordinator re-routes the group to EST as a design issue.
+  - id: DUP-007
+    name: superimposed structural models (structure vs structure from different files)
+    nameEs: "Modelos de estructura superpuestos"
+    when:
+      clash: { sameModelFile: false, sameExternalId: false }
+      both: { anyOf: [ { elementClass: { inSet: STRUCTURE } }, { category: { matches: '^(slab edges?|bordes? de losa)$' } } ] }
+    then: { validity: real, nature: duplicate, rootCause: duplicate_model, responsibleDiscipline: COORD, secondaryDiscipline: EST, severity: low, confidence: 0.6, suggestedAction: hygiene_issue, humanReview: true,
+            rationale: "{a.category} '{a.type}' de {a.documentName} se superpone con {b.category} '{b.type}' de {b.documentName}: dos modelos de estructura distintos ocupan el mismo lugar (revisiones cargadas juntas, modelo ajeno o copia vinculada). COORD define qué archivo es el vigente y lo deja solo en el conjunto de modelos; si ambos archivos son partes legítimas de la estructura (p. ej. hormigón y acero), tratarlo como incidencia de diseño a EST." }
+
 # ---------------------------------------------------------------------------
 # FP — False positives: hosted, connected, nested, accepted-by-design.
```

### Fundamento (es)

182 conflictos únicos (312 MC) son estructura contra estructura de **archivos distintos**: MODELING TEST S3 y S4 (dos revisiones de la misma estructura, familias S301/S401) y STRUCTURAL_VDC (modelo de muestra ajeno, familias en inglés), más la copia vinculada de VDC que viene dentro de MECHANICAL.rvt (doc 2). Ninguna regla los cubre (FP-006 exige el mismo archivo), así que caen en DEF-999: "real", responsable @mover, confianza 0,4, 43 grupos en revisión, como si fueran 182 problemas de diseño.

DUP-007 **no cierra nada**: deja la validez en `real` (igual que DUP-003, instancias duplicadas) y cambia lo que importa para decidir: `nature: duplicate`, `rootCause: duplicate_model`, responsable COORD (secundario EST), severidad low y `suggestedAction: hygiene_issue`. Con eso G2 los agrupa como lotes de higiene y la capa de familias los pone en PT12 por par de archivos: la decisión pasa a ser "cuál modelo de estructura es el vigente", una por par de archivos, que es lo que pide el documento de familias. Va al final de la sección DUP, antes de FP: no puede quitarle casos a DUP-001…006 y solo captura pares en que ambos lados son clase estructural (o borde de losa).

Se eligió `real` + `hygiene_issue` en vez de `needs_info` porque la capa de familias manda todo `needs_info` a PT13 por archivo individual (no por par) y porque no hay nada que preguntar al modelador: el conjunto de modelos está mal armado. Riesgo: en un proyecto con estructura repartida legítimamente en varios archivos (hormigón + acero, torre + zócalo) los cruces entre archivos sí son de diseño; por eso confianza 0,6, `humanReview` y la instrucción en el fundamento de reasignar a EST. Alcance `project`.

Incluye los 16 conflictos "copia vinculada de VDC dentro de MECHANICAL.rvt contra STRUCTURAL_VDC", que son el mismo archivo de origen visto dos veces. Esos no son superposición sino uniones del mismo modelo: los cierra FP-006 por archivo de origen (§4), que hoy no se puede expresar en YAML.

### Efecto medido (v11)

| Métrica | Antes | Después |
|---|---|---|
| Únicos / MC por validez | sin cambios | sin cambios (0 transiciones de validez) |
| Transiciones | | DEF-999 real → DUP-007 real: 182 únicos (312 MC) |
| Grupos | 245; 43 grupos DEF-999 | 208; 6 grupos de higiene DUP-007 (por archivo/par) |
| Grupos en revisión | 140 | **103** |
| Familias | 31: 3 PT12 "superpuestos" (S3+S4 52, S3+VDC 46, S4+VDC 68) + 1 PT14 "mismo archivo de origen" (16 real) | 31: las 3 PT12 siguen igual; la PT14 pasa a PT12 "STRUCTURAL_VDC + STRUCTURAL_VDC · DUP-007" (16 real) hasta que llegue P4 |
| Escenarios EV (26) | 25/26, 97,3, 0 inseguros | 25/26, 97,3, 0 inseguros |

---

## 4. P4: FP-006 por archivo de origen (requiere código; no registrable aún)

### Por qué no basta con YAML

FP-006 compara `sameModelFile` (linaje del documento MC). Un elemento de STRUCTURAL_VDC que llega a través de la copia vinculada dentro de MECHANICAL.rvt tiene `modelFile` = linaje de MECHANICAL, así que una unión pilar–fundación de VDC vista "copia vs original" sale `sameModelFile: false` y cae en DEF-999 como real. El DSL no tiene ningún hecho que diga "archivo de origen": los campos de elemento no se pueden comparar entre lados (solo los `sameX` fijos de `core/rules/fields.ts`) y un campo desconocido es error de carga, así que `candidateRulesDir` (y por tanto `propose_rule_change`) rechazaría el patch.

### Cambio de código necesario (para quien implemente `core/`)

Hecho nuevo de choque `sameOriginFile` en `CLASH_FIELDS` y en `core/enrich/clash.ts`:
- origen de un elemento = linaje (`lineageUrn`) del documento donde su `externalId` aparece **sin** prefijo de vínculo (`server/group-titles.ts` ya normaliza `<linkUid>-<8hex>/<uid>` y guarda el original en `raw["__coord/linkedExternalId"]`); si no aparece sin vínculo en ningún documento, su propio `modelFile`;
- `sameOriginFile` = ambos orígenes existen y son iguales (implica `sameModelFile` cuando no hay vínculos).
`server/engine.ts` ya resuelve un origen parecido para las familias (`originOf`), pero por nombre de archivo y solo para la firma; conviene usar el linaje y exponerlo al DSL.

### Diff que seguiría (no carga hasta que exista el hecho)

```diff
--- a/rules/classification-rules.yaml
+++ b/rules/classification-rules.yaml
@@ -267,5 +267,5 @@
     when:
-      clash: { sameModelFile: true }
+      clash: { sameOriginFile: true }
       both: { discipline: EST }
     then: { validity: false_positive, nature: hard, rootCause: not_applicable, responsibleDiscipline: COORD, severity: none, confidence: 0.9, suggestedAction: close_not_issue,
-            rationale: "Uniones de geometría dentro del modelo estructural ({a.category} con {b.category}). Se resuelven con 'unir geometría', no son interferencias de coordinación." }
+            rationale: "Uniones de geometría dentro del modelo estructural ({a.category} con {b.category}), incluidas las vistas a través de una copia vinculada del mismo archivo. Se resuelven con 'unir geometría', no son interferencias de coordinación." }
```
y, si P3 ya está aprobada, en DUP-007: `clash: { sameModelFile: false, sameExternalId: false, sameOriginFile: false }`, para que las uniones del mismo origen no queden como "superposición".

### Fundamento (es) y efecto medido fuera de línea

Calculado con el linaje real de los documentos sobre la clasificación de v11 (script en el scratchpad, sin tocar `rules/` ni `core/`): **16 conflictos únicos (32 MC)** pasarían de DEF-999 real a FP-006: 11 "pilar (copia de VDC en MECHANICAL.rvt doc 2) vs fundación (STRUCTURAL_VDC doc 5)" y 5 "fundación (copia) vs pilar (VDC)". Justificación uno a uno: en los 16 los dos elementos tienen como origen el mismo archivo STRUCTURAL_VDC.rvt; son la unión pilar–fundación de un mismo modelo, vista una vez por el archivo original y otra por la copia vinculada. No hay ningún caso de origen distinto. Es un cierre de confianza 0,9 (regla existente), pero la copia vinculada en sí sigue siendo un problema de higiene del conjunto (ya lo reporta la estadística de higiene de elementos vinculados).

Hallazgo adicional para el mismo hecho: MECHANICAL.rvt está cargado dos veces con linajes distintos (docs 1 y 2, mismos UniqueId). Por eso **todos** los choques MEP×MEP de este test son "MECHANICAL contra su copia" (los 313 conflictos MEP×MEP del test son entre los docs 1 y 2) y FP-003 (componentes conectados del mismo sistema) nunca dispara porque exige `sameModelFile`. Con `sameOriginFile`, FP-003 podría usarlo también; no se propone aquí porque la decisión correcta es sacar la copia del conjunto de modelos.

---

## 5. La inconsistencia del motor que expusieron las familias (432 tolerated vs 96 real)

**Qué pasa.** La familia #15 (AP Ø16 + fittings Ø13 contra "Bathroom Sink (Yacht)") tiene 528 conflictos únicos de la misma situación física: la alimentación de agua fría/caliente que entra al lavamanos. El motor da 432 `tolerated` (TOL-003) y 96 `real` (MM-005). La #1 (ALC Ø38–41 contra el mismo lavamanos) da 111 `real` (MM-002) y 18 `tolerated`.

**Causa.** Ninguna regla FP reconoce la conexión red–artefacto (FP-003 exige mismo sistema y mismo archivo, y no se cumplen), así que el primer filtro que la toca es TOL-003, que compara la penetración con la tolerancia del par de la matriz: `@MEP × @MEP` 10 mm para AP y `gravity_pipe × @MEP_ANY` 5 mm para ALC. Lo que pasa de ese umbral sigue a MM-005/MM-002 y sale real. Pero la penetración de un conector dentro de un artefacto no mide un error de diseño: es cuánto se mete el stub dentro de la geometría de la familia (0–40 mm aquí, según el tipo de fitting y la posición del conector). El umbral corta una misma decisión en dos veredictos: 288+162 casos ≤ 10 mm (tolerated) y 45+123+39 casos entre 5 y 50 mm (real).

**Arreglo mínimo.** Reconocer la conexión **antes** de la tolerancia: FP-017 (y FP-019 para el fan-coil) en la sección FP, que en el orden de evaluación va antes que TOL. Medido: los 528 + 129 pasan a un solo veredicto (`false_positive`, en revisión) y las familias con validez mixta bajan de 6 a 4. No se propone tocar la tolerancia: subir `@MEP × @MEP` a 40–50 mm cerraría también cruces reales entre redes (MM-010), y la tolerancia por pares de clase no distingue "conectado" de "cruzado".

Las 4 familias mixtas que quedan son umbrales legítimos (cruces o redes enterradas donde la penetración sí importa): PT07 losa de fundación vs ALC (48 real + 16 tol), dos PT08 ALC×ALC / ALC×AP (9+3 y 1+4) y el fan-coil (50 FP + 1 real, el ducto troncal que se dejó real a propósito). No requieren cambio de reglas; el guardia de validez mixta de las familias los muestra al aprobar.

---

## 6. Registro de las propuestas: bloqueado por el esquema de `propose_rule_change`

Se escribió un cliente MCP (stdio, modo LIVE: sin `COORD_DATA_SOURCE` ni `COORDINATOR_HOME`, igual que `scripts/mcp-smoke.ts --live`) que arranca `server/mcp/index.ts` y llama `propose_rule_change` una vez por P1, P2 y P3. Sesión: `dataSource: live`, autonomía efectiva L1 (suficiente). Las tres llamadas fallaron igual:

```
MCP error -32602: Input validation error: Invalid arguments for tool propose_rule_change:
Too small: expected array to have >=1 items at feedbackIds
```

Causa exacta:
1. `ProposeRuleChangeInput.feedbackIds` es `z.array(z.string()).min(1)` (`server/mcp/contracts.ts`) y además `Coordinator.proposeRuleChange` rechaza IDs que no existan en el store (`not_found`).
2. El store tiene **0 registros de feedback** (`list_feedback` devuelve `total: 0`). Estas propuestas nacen del análisis de familias sobre datos reales, no de correcciones de coordinadores, así que no hay IDs legítimos que citar. Inventar o crear feedback para pasar la validación sería saltarse el control, y no se hizo.
3. Secundario: `evaluation` acepta solo `baselineRubricScore`, `candidateRubricScore`, `unsafeClosureRate` y `criticalFalseNegatives`; las métricas sobre datos reales (únicos, grupos, familias, real→cerrable) solo caben en el `rationale` (≤ 1.500 caracteres). Los `rationale` preparados ya las incluyen (948–1.166 caracteres).

Para registrarlas, el usuario puede elegir:
- (a) permitir en el esquema una fuente de evidencia que no sea feedback (p. ej. `feedbackIds` opcional cuando viene `evidenceRef: "doc:solution-families-proposal.md#3"` o el `testKey` medido), o
- (b) que un coordinador registre en la app las correcciones que respaldan cada regla (por ejemplo, corregir un grupo de lavamanos, uno de PIPE COVER y uno de superposición) y luego volver a ejecutar el cliente con esos IDs.

El cliente, los patches y los `rationale` quedan listos en el scratchpad de la sesión (`register.mts`, `proposals.json`, `p1.patch`, `p2.patch`, `p3.patch`). P4 (FP-006 por origen) no se puede registrar en ningún caso hasta que exista el hecho `sameOriginFile`, porque `candidateRulesDir` exige que las reglas carguen.

---

## 7. Cómo se midió (reproducible, solo lectura)

1. Copia de las reglas del repo a carpetas del scratchpad (`base/`, `p1/`, `p2/`, `p3/`, `pall/`), edición de la copia y `diff -U2` para obtener cada patch. `rules/` no se tocó.
2. Cada patch se validó con `Coordinator.candidateRulesDir` (lo mismo que hace `propose_rule_change`): aplica limpio y carga (84/83/83/86 reglas, sin advertencias nuevas).
3. Motor sobre la caché real de v11 con los módulos del servidor: `runEngine` con las mismas opciones que `Coordinator.classify` (disciplinas del proyecto, `levelMap`, política de revisión de la config) para grupos y familias, y `runCoordination` con las mismas opciones para los hechos por conflicto. Comparación por clave de conflicto único (par de `externalId`), con conteo MC.
4. Evidencia geométrica por conflicto: caja (bbox, en metros) del elemento que se mueve contra la del anfitrión a lo largo del eje principal del primero, con 30 mm de margen: `contenido` (todo el tramo dentro de la extensión del anfitrión), `termina_dentro` (un extremo dentro), `atraviesa` (un extremo a cada lado), `fuera`.
5. Escenarios: `scripts/eval.ts` no recibe un directorio de reglas, así que se corrió una copia idéntica que solo cambia `loadRulesFromDisk()` por `loadRulesFromDisk({ dir })` sobre cada candidato, más `Coordinator.evaluateRuleset` (suites `eval_scenarios` y `feedback_replay`, esta última vacía por falta de feedback). Resultado para P1, P2, P3 y P1+P2+P3: 25/26, rúbrica 97,3 (igual que hoy), 0 cierres inseguros, 0 falsos negativos críticos, 0 regresiones; la única falla es EV-05, pendiente del patch M1 de la matriz y en el sentido seguro, igual que con las reglas actuales.

---

## A. Anexo: cada conflicto `real` que pasa a cerrable, uno por uno

Todos quedan con `humanReview: true` y confianza 0,65: el cierre es una propuesta en revisión, no un cierre automático. Justificación por fila: **J1** = el tramo está contenido en la extensión del artefacto/equipo/envolvente a lo largo de su eje (no sale por el otro lado: es una conexión o un tramo encerrado); **J2** = el tramo termina dentro del artefacto/equipo/envolvente (conexión o entrada al envolvente). No hay ninguna fila con el tramo atravesando al anfitrión, ni sin caja. Documentos: doc 1 y doc 2 son las dos copias de MECHANICAL.rvt. Clave = par de UniqueId (abreviado a los últimos 8 caracteres de cada uno).

Totales: FP-017 J1: 207 · FP-019 J2: 17 · FP-019 J1: 32 · FP-018 J2: 94 · FP-018 J1: 10 · total 360.

| # | Regla (antes → después) | Clave | IDs MC | Se mueve | Anfitrión | Nivel | Pen. mm | Geometría |
|---|---|---|---|---|---|---|---|---|
| 1 | MM-002 → FP-017 | 000981f6·0009dcb5 | 11150772189949, 1662579542784214 | Pipes ALC Sanitary 13 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 10.8 | J1 |
| 2 | MM-002 → FP-017 | 000985e0·0009dc54 | 3801205551435004, 8018240627310680 | Pipes ALC Sanitary 13 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 10.8 | J1 |
| 3 | MM-002 → FP-017 | 000985e8·0009dc36 | 1142461818865022, 2104661736169299 | Pipes ALC Sanitary 12 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 10.8 | J1 |
| 4 | MM-002 → FP-017 | 0009ec92·0009dd24 | 2983684876370943, 3911189180643159 | Pipes ALC Sanitary 13 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 27 | J1 |
| 5 | MM-005 → FP-017 | 0009ccb1·000aa9a9 | 4735817984828312, 6972549259428486 | Pipes AP Domestic Hot Water 19 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 6 | MM-005 → FP-017 | 0009ccb1·000aa9d7 | 2123324251703606, 3938242948770411 | Pipes AP Domestic Cold Water 19 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 7 | MM-002 → FP-017 | 0009ccb1·0009ed9f | 3533045159412076, 7242896964113819 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 40 | J1 |
| 8 | MM-002 → FP-017 | 0009ccb1·0009edaa | 4424595626827022, 5895076180104502 | Pipes ALC Sanitary 5 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 7.9 | J1 |
| 9 | MM-002 → FP-017 | 0009ccb1·0009edaf | 437648366801293, 6132223903752584 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 6.2 | J1 |
| 10 | MM-005 → FP-017 | 0009d5be·000aa99f | 524548673135853, 7081843365745351 | Pipes AP Domestic Hot Water 9 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 19.1 | J1 |
| 11 | MM-005 → FP-017 | 0009d5be·000aa9d5 | 3021998657036390, 5959048888859660 | Pipes AP Domestic Cold Water 34 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 12 | MM-002 → FP-017 | 0009d5be·0009eda8 | 1627010955867848, 5089748592349729 | Pipe Fittings ALC Sanitary 18 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 40 | J1 |
| 13 | MM-002 → FP-017 | 0009d5be·0009edab | 1090849813191480, 6337740596775047 | Pipes ALC Sanitary 18 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 7.9 | J1 |
| 14 | MM-002 → FP-017 | 0009d5be·0009edb1 | 3783306336594672, 8785962965076757 | Pipe Fittings ALC Sanitary 18 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 6.2 | J1 |
| 15 | MM-005 → FP-017 | 0009d662·000aabd3 | 5111198361803872, 7365097973369949 | Pipes AP Domestic Hot Water 72 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 19.1 | J1 |
| 16 | MM-005 → FP-017 | 0009d662·000aac01 | 3277373580292726, 7905557843907553 | Pipes AP Domestic Cold Water 122 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 17 | MM-002 → FP-017 | 0009d662·0009ed94 | 2578509061724548, 3781863612630836 | Pipes ALC Sanitary 5 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 7.9 | J1 |
| 18 | MM-002 → FP-017 | 0009d662·0009ed96 | 3190245624840517, 4268634496016500 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 40 | J1 |
| 19 | MM-002 → FP-017 | 0009d662·0009edb3 | 3839422952820782, 5639876353776538 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 6.2 | J1 |
| 20 | MM-005 → FP-017 | 0009d67a·000aabc9 | 296707236199639, 1041415082130116 | Pipes AP Domestic Hot Water 68 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 21 | MM-005 → FP-017 | 0009d67a·000aabff | 3100690626341853, 6053267872063844 | Pipes AP Domestic Cold Water 128 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 22 | MM-002 → FP-017 | 0009d67a·0009edb7 | 1683898261370808, 8040730357249358 | Pipes ALC Sanitary 5 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 7.9 | J1 |
| 23 | MM-002 → FP-017 | 0009d67a·0009edba | 3465095686194136, 4398538955682937 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 36.5 | J1 |
| 24 | MM-005 → FP-017 | 0009d6dc·000aace7 | 396636721621124, 1159218487495092 | Pipes AP Domestic Hot Water 94 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 25 | MM-005 → FP-017 | 0009d6dc·000aad15 | 1356821935473903, 7428411283015734 | Pipes AP Domestic Cold Water 160 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 26 | MM-002 → FP-017 | 0009d6dc·0009eddd | 408650029589546, 910543067772590 | Pipes ALC Sanitary 3 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 7.9 | J1 |
| 27 | MM-002 → FP-017 | 0009d6dc·0009eddf | 2843596461227308, 2897500807783341 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 40 | J1 |
| 28 | MM-002 → FP-017 | 0009d6dc·0009edfc | 1972501990426739, 2913881954532814 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 6.2 | J1 |
| 29 | MM-005 → FP-017 | 0009d7fd·000aacdd | 4278774444628435, 5729290084338740 | Pipes AP Domestic Hot Water 90 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 19.1 | J1 |
| 30 | MM-005 → FP-017 | 0009d7fd·000aad13 | 2275545512062034, 5141429812736110 | Pipes AP Domestic Cold Water 166 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 19.1 | J1 |
| 31 | MM-002 → FP-017 | 0009d7fd·0009ee00 | 3421390077075411, 6351244897173973 | Pipes ALC Sanitary 3 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 14.6 | J1 |
| 32 | MM-002 → FP-017 | 0009d7fd·0009ee03 | 2785839792750933, 3478208419698207 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 36.5 | J1 |
| 33 | MM-005 → FP-017 | 0009d80f·000aad71 | 2084137772489513, 3427570123682999 | Pipes AP Domestic Hot Water 101 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 19.1 | J1 |
| 34 | MM-005 → FP-017 | 0009d80f·000aad9f | 1958107676243614, 5720168483262470 | Pipes AP Domestic Cold Water 179 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 19.1 | J1 |
| 35 | MM-002 → FP-017 | 0009d80f·0009ee26 | 2525612412823762, 7780821245514148 | Pipes ALC Sanitary Yacht 20, 22, 25, 27 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 14.6 | J1 |
| 36 | MM-002 → FP-017 | 0009d80f·0009ee28 | 3692891050467544, 7999117508798011 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 40 | J1 |
| 37 | MM-002 → FP-017 | 0009d80f·0009ee45 | 804179237228762, 6434257063654739 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 6.2 | J1 |
| 38 | MM-005 → FP-017 | 0009d898·000aad67 | 1341165880715949, 6340813734109741 | Pipes AP Domestic Hot Water 101 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 39 | MM-005 → FP-017 | 0009d898·000aad9d | 1137846822350324, 7621987265489698 | Pipes AP Domestic Cold Water 185 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 40 | MM-002 → FP-017 | 0009d898·0009ee49 | 7239169618566800, 7281518488818812 | Pipes ALC Sanitary Yacht 20, 22, 25, 27 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 14.6 | J1 |
| 41 | MM-002 → FP-017 | 0009d898·0009ee4c | 947894623699974, 952799739414089 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 36.5 | J1 |
| 42 | MM-005 → FP-017 | 0009d92e·000aab3d | 427672139510667, 5486627412163737 | Pipes AP Domestic Hot Water 57 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 19.1 | J1 |
| 43 | MM-005 → FP-017 | 0009d92e·000aab73 | 874478981468195, 1525829388329107 | Pipes AP Domestic Cold Water 109 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 44 | MM-002 → FP-017 | 0009d92e·0009ee3a | 3057727867150787, 4548522488804658 | Pipe Fittings ALC Sanitary 26 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 40 | J1 |
| 45 | MM-002 → FP-017 | 0009d92e·0009ee3d | 58142036209691, 2176050662014313 | Pipes ALC Sanitary 26 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 14.6 | J1 |
| 46 | MM-002 → FP-017 | 0009d92e·0009ee43 | 1249919871279503, 8772510121245513 | Pipe Fittings ALC Sanitary 26 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 6.2 | J1 |
| 47 | MM-005 → FP-017 | 0009da3d·000aab47 | 4682888168323925, 6702308764151215 | Pipes AP Domestic Hot Water 61 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 48 | MM-005 → FP-017 | 0009da3d·000aab75 | 5898754325879612, 8678316849527040 | Pipes AP Domestic Cold Water 103 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 49 | MM-002 → FP-017 | 0009da3d·0009ee31 | 601661611082448, 6242792300073414 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 40 | J1 |
| 50 | MM-002 → FP-017 | 0009da3d·0009ee3c | 2786341943475475, 6669183469097376 | Pipes ALC Sanitary Yacht 20, 22, 25, 27 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 14.6 | J1 |
| 51 | MM-002 → FP-017 | 0009da3d·0009ee41 | 2163115182679528, 3375738507155583 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 6.2 | J1 |
| 52 | MM-005 → FP-017 | 0009da9e·000aaab3 | 4590999993377861, 7425979551330878 | Pipes AP Domestic Hot Water 43 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 53 | MM-005 → FP-017 | 0009da9e·000aaae9 | 2424121442452695, 5588853146483465 | Pipes AP Domestic Cold Water 88 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 19.1 | J1 |
| 54 | MM-002 → FP-017 | 0009da9e·0009edf1 | 4492133559281398, 4665978007373848 | Pipe Fittings ALC Sanitary 23 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 40 | J1 |
| 55 | MM-002 → FP-017 | 0009da9e·0009edf4 | 1836238186803552, 3113550093087947 | Pipes ALC Sanitary 23 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 14.6 | J1 |
| 56 | MM-002 → FP-017 | 0009da9e·0009edfa | 3085120234332095, 3532217443044083 | Pipe Fittings ALC Sanitary 23 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 6.2 | J1 |
| 57 | MM-005 → FP-017 | 0009db44·000aaabd | 622004997484124, 8708886676789645 | Pipes AP Domestic Hot Water 48 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 19.1 | J1 |
| 58 | MM-005 → FP-017 | 0009db44·000aaaeb | 59209532222339, 2253381973400559 | Pipes AP Domestic Cold Water 78 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 19.1 | J1 |
| 59 | MM-002 → FP-017 | 0009db44·0009ede8 | 2059959959744424, 7498982619656583 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 40 | J1 |
| 60 | MM-002 → FP-017 | 0009db44·0009edf3 | 1383180676608787, 6601035040913319 | Pipes ALC Sanitary 3 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 7.9 | J1 |
| 61 | MM-002 → FP-017 | 0009db44·0009edf8 | 320380280485636, 4554528082935874 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 6.2 | J1 |
| 62 | MM-005 → FP-017 | 0009dc36·000aaa29 | 779295976328778, 8129919089381875 | Pipes AP Domestic Hot Water 29 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 20.7 | J1 |
| 63 | MM-005 → FP-017 | 0009dc36·000aaa5f | 6713909622359410, 8646350089118318 | Pipes AP Domestic Cold Water 59 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 20.7 | J1 |
| 64 | MM-005 → FP-017 | 0009dc54·000aaa33 | 1784460350267871, 7547713099137972 | Pipes AP Domestic Hot Water 33 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 20.7 | J1 |
| 65 | MM-005 → FP-017 | 0009dc54·000aaa61 | 1719910235538656, 3499265806199737 | Pipes AP Domestic Cold Water 53 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 20.7 | J1 |
| 66 | MM-005 → FP-017 | 0009dcb5·000aac5d | 2901805826370048, 7903281306789599 | Pipes AP Domestic Hot Water 83 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 20.7 | J1 |
| 67 | MM-005 → FP-017 | 0009dcb5·000aac8b | 1780365314782444, 2911633303234194 | Pipes AP DCW Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 101 FIRST FLOOR | 20.7 | J1 |
| 68 | MM-005 → FP-017 | 0009dd24·000aac53 | 2711466102964739, 6503967506822358 | Pipes AP Domestic Hot Water 2 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 20.7 | J1 |
| 69 | MM-005 → FP-017 | 0009dd24·000aac89 | 6246630497598396, 6528490278305237 | Pipes AP Domestic Cold Water 147 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 101 FIRST FLOOR | 20.7 | J1 |
| 70 | MM-005 → FP-017 | 000aaf18·0009f74c | 2447352652128058, 8608929475309053 | Pipes AP Domestic Hot Water 112 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 71 | MM-005 → FP-017 | 000aaf22·0009f74b | 1785205535725297, 7493612519876777 | Pipes AP Domestic Hot Water 116 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 72 | MM-005 → FP-017 | 000aaf4e·0009f74c | 536532836854345, 7461245997377935 | Pipes AP Domestic Cold Water 204 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 73 | MM-005 → FP-017 | 000aaf50·0009f74b | 1519892070908854, 2435505486131660 | Pipes AP Domestic Cold Water 198 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 74 | MM-005 → FP-017 | 000aafa2·0009f757 | 308765616001894, 8495012937893016 | Pipes AP Domestic Hot Water 123 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 20.7 | J1 |
| 75 | MM-005 → FP-017 | 000aafac·0009f758 | 2703462081470954, 7362529938034343 | Pipes AP Domestic Hot Water 127 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 20.7 | J1 |
| 76 | MM-005 → FP-017 | 000aafd8·0009f757 | 411911219461701, 753019259329055 | Pipes AP Domestic Cold Water 223 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 20.7 | J1 |
| 77 | MM-005 → FP-017 | 000aafda·0009f758 | 4517023114377310, 5076634832813592 | Pipes AP Domestic Cold Water 217 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 20.7 | J1 |
| 78 | MM-005 → FP-017 | 000ab02c·0009f755 | 421666761715690, 5639026106571343 | Pipes AP Domestic Hot Water 134 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 19.1 | J1 |
| 79 | MM-005 → FP-017 | 000ab036·0009f756 | 1584817776497400, 2445619893005616 | Pipes AP Domestic Hot Water 138 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 19.1 | J1 |
| 80 | MM-005 → FP-017 | 000ab062·0009f755 | 1201601271734319, 3273923589891457 | Pipes AP Domestic Cold Water 242 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 81 | MM-005 → FP-017 | 000ab064·0009f756 | 1852986211034917, 6142743865668901 | Pipes AP Domestic Cold Water 236 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 19.1 | J1 |
| 82 | MM-005 → FP-017 | 000ab0b6·0009f753 | 2071709769213839, 3954611887532716 | Pipes AP Domestic Hot Water 145 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 83 | MM-005 → FP-017 | 000ab0c0·0009f754 | 6635093708671165, 7971800647500426 | Pipes AP Domestic Hot Water 149 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 84 | MM-005 → FP-017 | 000ab0ec·0009f753 | 6480598946494640, 6582632943218498 | Pipes AP Domestic Cold Water 261 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 85 | MM-005 → FP-017 | 000ab0ee·0009f754 | 5680341263416283, 7604000594205678 | Pipes AP Domestic Cold Water 255 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 86 | MM-005 → FP-017 | 000ab142·0009f74e | 300631984624425, 8953762281518634 | Pipes AP Domestic Hot Water 156 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 19.1 | J1 |
| 87 | MM-005 → FP-017 | 000ab14c·0009f74d | 484245721581058, 1461320610006825 | Pipes AP Domestic Hot Water 160 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 88 | MM-005 → FP-017 | 000ab178·0009f74e | 3176351943339077, 7320708259377902 | Pipes AP Domestic Cold Water 280 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 89 | MM-005 → FP-017 | 000ab17a·0009f74d | 1803229926790270, 4480215342397694 | Pipes AP Domestic Cold Water 274 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 90 | MM-005 → FP-017 | 000ab1cc·0009f75a | 6938449020055382, 8940576923897739 | Pipes AP DHW Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 20.7 | J1 |
| 91 | MM-005 → FP-017 | 000ab1d6·0009f759 | 2086137672686964, 4879640186147328 | Pipes AP Domestic Hot Water 171 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 20.7 | J1 |
| 92 | MM-005 → FP-017 | 000ab202·0009f75a | 33338330373288, 1718391555353121 | Pipes AP Domestic Cold Water 299 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 20.7 | J1 |
| 93 | MM-005 → FP-017 | 000ab204·0009f759 | 3050756039050437, 6317912330425784 | Pipes AP DCW Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 20.7 | J1 |
| 94 | MM-005 → FP-017 | 000ab256·0009f750 | 5356018105748873, 5622029380780225 | Pipes AP Domestic Hot Water 178 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 19.1 | J1 |
| 95 | MM-005 → FP-017 | 000ab260·0009f74f | 7498233801470162, 8853721113405753 | Pipes AP Domestic Hot Water 182 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 96 | MM-005 → FP-017 | 000ab28c·0009f750 | 2602897891398304, 8207128728492359 | Pipes AP Domestic Cold Water 318 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 19.1 | J1 |
| 97 | MM-005 → FP-017 | 000ab28e·0009f74f | 1304227741630383, 7111198363462856 | Pipes AP Domestic Cold Water 312 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 19.1 | J1 |
| 98 | MM-005 → FP-017 | 000ab2e0·0009f752 | 1422648735823361, 5110106867592964 | Pipes AP Domestic Hot Water 189 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 19.1 | J1 |
| 99 | MM-005 → FP-017 | 000ab2ea·0009f751 | 3335617407710063, 3502322800323419 | Pipes AP Domestic Hot Water 193 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 19.1 | J1 |
| 100 | MM-005 → FP-017 | 000ab316·0009f752 | 608454248425518, 7064885374442205 | Pipes AP Domestic Cold Water 337 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 19.1 | J1 |
| 101 | MM-005 → FP-017 | 000ab318·0009f751 | 4924796468186278, 6306452125705317 | Pipes AP Domestic Cold Water 331 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 19.1 | J1 |
| 102 | MM-002 → FP-017 | 0009f731·0009f759 | 1287739209704274, 2154286862516435 | Pipes ALC Sanitary 13 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 10.8 | J1 |
| 103 | MM-002 → FP-017 | 0009f73c·0009f758 | 3047449333366486, 8937554336714192 | Pipes ALC Sanitary 13 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 10.8 | J1 |
| 104 | MM-002 → FP-017 | 0009f741·0009f757 | 105279765447050, 7376239007741500 | Pipes ALC Sanitary 31 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 10.8 | J1 |
| 105 | MM-002 → FP-017 | 0009f74b·0009f775 | 5897197040380506, 6177900607280546 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 40 | J1 |
| 106 | MM-002 → FP-017 | 0009f74b·0009f780 | 1044860633430623, 5854139194718615 | Pipes ALC Sanitary 5 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 7.9 | J1 |
| 107 | MM-002 → FP-017 | 0009f74b·0009f785 | 3711001913468165, 3996617819116568 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 6.2 | J1 |
| 108 | MM-002 → FP-017 | 0009f74c·0009f77e | 1095048555430598, 5122982583744329 | Pipe Fittings ALC Sanitary 39 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 40 | J1 |
| 109 | MM-002 → FP-017 | 0009f74c·0009f781 | 3254515961453086, 7599212928188764 | Pipes ALC Sanitary 39 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 7.9 | J1 |
| 110 | MM-002 → FP-017 | 0009f74c·0009f787 | 5224176330257210, 6558315284934330 | Pipe Fittings ALC Sanitary 39 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 6.2 | J1 |
| 111 | MM-002 → FP-017 | 0009f74d·0009f76b | 3760950884236292, 6453103153641368 | Pipes ALC Sanitary 5 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 7.9 | J1 |
| 112 | MM-002 → FP-017 | 0009f74d·0009f76c | 5641051618423273, 8533018160365783 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 40 | J1 |
| 113 | MM-002 → FP-017 | 0009f74d·0009f789 | 3726410454506472, 5482177370305877 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 6.2 | J1 |
| 114 | MM-002 → FP-017 | 0009f74e·0009f78d | 5473489492297697, 8121351155492009 | Pipes ALC Sanitary 5 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 7.9 | J1 |
| 115 | MM-002 → FP-017 | 0009f74e·0009f78f | 4583051042090417, 7474945186242787 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 36.5 | J1 |
| 116 | MM-002 → FP-017 | 0009f74f·0009f792 | 3245712396238974, 8366482693647749 | Pipes ALC Sanitary 3 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 7.9 | J1 |
| 117 | MM-002 → FP-017 | 0009f74f·0009f794 | 2971530873531560, 7611316071600487 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 40 | J1 |
| 118 | MM-002 → FP-017 | 0009f74f·0009f7b1 | 4035807793476263, 6738097290779153 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 6.2 | J1 |
| 119 | MM-002 → FP-017 | 0009f750·0009f7b5 | 219320266199224, 1271763442646934 | Pipes ALC Sanitary 3 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 14.6 | J1 |
| 120 | MM-002 → FP-017 | 0009f750·0009f7b8 | 3697669996412876, 5714093129477285 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 36.5 | J1 |
| 121 | MM-002 → FP-017 | 0009f751·0009f7bc | 5525942694669635, 8607645558022136 | Pipes ALC Sanitary Yacht 20, 22, 25, 27 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 14.6 | J1 |
| 122 | MM-002 → FP-017 | 0009f751·0009f7be | 935253789354912, 2852684144624819 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 40 | J1 |
| 123 | MM-002 → FP-017 | 0009f751·0009f7db | 5998236122426392, 6314716357231476 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 6.2 | J1 |
| 124 | MM-002 → FP-017 | 0009f752·0009f7df | 5280353624594751, 7940190611998083 | Pipes ALC Sanitary Yacht 20, 22, 25, 27 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 14.6 | J1 |
| 125 | MM-002 → FP-017 | 0009f752·0009f7e2 | 113142468745898, 4431081246047413 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 36.5 | J1 |
| 126 | MM-002 → FP-017 | 0009f753·0009f7d0 | 4818024391325357, 7284426984599842 | Pipe Fittings ALC Sanitary 66 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 40 | J1 |
| 127 | MM-002 → FP-017 | 0009f753·0009f7d3 | 2698708163058726, 7735997999515516 | Pipes ALC Sanitary 66 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 14.6 | J1 |
| 128 | MM-002 → FP-017 | 0009f753·0009f7d9 | 319586267564973, 1583049591093156 | Pipe Fittings ALC Sanitary 66 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 6.2 | J1 |
| 129 | MM-002 → FP-017 | 0009f754·0009f7c7 | 1218838076534938, 7891001581024079 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 40 | J1 |
| 130 | MM-002 → FP-017 | 0009f754·0009f7d2 | 774900131951821, 8333226320912665 | Pipes ALC Sanitary Yacht 20, 22, 25, 27 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 14.6 | J1 |
| 131 | MM-002 → FP-017 | 0009f754·0009f7d7 | 315104222474278, 3811757819511478 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 6.2 | J1 |
| 132 | MM-002 → FP-017 | 0009f755·0009f7a6 | 3398652329672734, 5651977512149417 | Pipe Fittings ALC Sanitary 51 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 40 | J1 |
| 133 | MM-002 → FP-017 | 0009f755·0009f7a9 | 4937800881280980, 5988246618723827 | Pipes ALC Sanitary 51 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 14.6 | J1 |
| 134 | MM-002 → FP-017 | 0009f755·0009f7af | 278029853063596, 4753698262328775 | Pipe Fittings ALC Sanitary 51 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 6.2 | J1 |
| 135 | MM-002 → FP-017 | 0009f756·0009f79d | 3628410815213547, 7938450155031316 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 40 | J1 |
| 136 | MM-002 → FP-017 | 0009f756·0009f7a8 | 1717299166193395, 7924757220634617 | Pipes ALC Sanitary 3 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 7.9 | J1 |
| 137 | MM-002 → FP-017 | 0009f756·0009f7ad | 4993377148867719, 5787164495372440 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 201 SECOND FLOOR | 6.2 | J1 |
| 138 | MM-002 → FP-017 | 0009f75a·0009f764 | 1349576041098222, 5460621018990363 | Pipes ALC Sanitary 13 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 201 SECOND FLOOR | 27 | J1 |
| 139 | MM-005 → FP-017 | 000a04a3·0009f847 | 1432955068540121, 5311368481269516 | Pipes AP DHW Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 19.1 | J1 |
| 140 | MM-005 → FP-017 | 000a0619·0009f846 | 5583105495320398, 7809123721762013 | Pipes AP DHW Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 19.1 | J1 |
| 141 | MM-005 → FP-017 | 000a0a14·0009f847 | 1759409039880910, 5649651360767820 | Pipes AP DCW Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 19.1 | J1 |
| 142 | MM-005 → FP-017 | 000a0a3e·0009f846 | 474905189719134, 6509619733589163 | Pipes AP DCW Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 19.1 | J1 |
| 143 | MM-005 → FP-017 | 000a9f71·0009f852 | 1624535934339838, 2955870725192286 | Pipes AP DHW Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 20.7 | J1 |
| 144 | MM-005 → FP-017 | 000a9f7b·0009f853 | 65864641541596, 1734627496255165 | Pipes AP Domestic Hot Water 7 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 20.7 | J1 |
| 145 | MM-005 → FP-017 | 000a9fa7·0009f852 | 3009741845372859, 7856806087509904 | Pipes AP Domestic Cold Water 10 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 20.7 | J1 |
| 146 | MM-005 → FP-017 | 000a9fa9·0009f853 | 6079583909483615, 7946146914860773 | Pipes AP DCW Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 20.7 | J1 |
| 147 | MM-005 → FP-017 | 000aa06e·0009f850 | 8103019773094437, 8402640962336083 | Pipes AP DHW Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 19.1 | J1 |
| 148 | MM-005 → FP-017 | 000aa078·0009f851 | 2513168326008036, 8631415900993026 | Pipes AP Domestic Hot Water 10 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 19.1 | J1 |
| 149 | MM-005 → FP-017 | 000aa0a4·0009f850 | 4305146283153151, 6700787359825913 | Pipes AP Domestic Cold Water 16 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 19.1 | J1 |
| 150 | MM-005 → FP-017 | 000aa0a6·0009f851 | 1684218278688366, 6700637180358255 | Pipes AP DCW Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 19.1 | J1 |
| 151 | MM-005 → FP-017 | 000aa16b·0009f84e | 3662798297408613, 8257018147422886 | Pipes AP DHW Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 19.1 | J1 |
| 152 | MM-005 → FP-017 | 000aa175·0009f84f | 1490640933884568, 7884856425061727 | Pipes AP Domestic Hot Water 13 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 19.1 | J1 |
| 153 | MM-005 → FP-017 | 000aa1a1·0009f84e | 2479788514962054, 6752574311353053 | Pipes AP Domestic Cold Water 22 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 19.1 | J1 |
| 154 | MM-005 → FP-017 | 000aa1a3·0009f84f | 3337039118828911, 6551508143559073 | Pipes AP DCW Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 19.1 | J1 |
| 155 | MM-005 → FP-017 | 000aa412·0009f849 | 4723754549571369, 5214165532608731 | Pipes AP DHW Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 19.1 | J1 |
| 156 | MM-005 → FP-017 | 000aa41c·0009f848 | 1480651403914345, 5684075369760630 | Pipes AP Domestic Hot Water 16 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 19.1 | J1 |
| 157 | MM-005 → FP-017 | 000aa448·0009f849 | 6602536825082042, 7043652980577483 | Pipes AP Domestic Cold Water 28 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 19.1 | J1 |
| 158 | MM-005 → FP-017 | 000aa44a·0009f848 | 6541416439312646, 7149054021925337 | Pipes AP DCW Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 19.1 | J1 |
| 159 | MM-005 → FP-017 | 000aa49c·0009f855 | 2271040943014176, 4740380062805708 | Pipes AP DHW Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 20.7 | J1 |
| 160 | MM-005 → FP-017 | 000aa4a6·0009f854 | 2182822727556490, 5204810722656202 | Pipes AP Domestic Hot Water 27 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 20.7 | J1 |
| 161 | MM-005 → FP-017 | 000aa4d2·0009f855 | 809006312528022, 8516754876350752 | Pipes AP Domestic Cold Water 47 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 20.7 | J1 |
| 162 | MM-005 → FP-017 | 000aa4d4·0009f854 | 2969258006328080, 5242037088508966 | Pipes AP DCW Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 20.7 | J1 |
| 163 | MM-005 → FP-017 | 000aa526·0009f84b | 4671595199375819, 5838371932561288 | Pipes AP DHW Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 19.1 | J1 |
| 164 | MM-005 → FP-017 | 000aa530·0009f84a | 2160056984569939, 5932183473567663 | Pipes AP Domestic Hot Water 38 Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 19.1 | J1 |
| 165 | MM-005 → FP-017 | 000aa55c·0009f84b | 1049477874018910, 6792169771983451 | Pipes AP Domestic Cold Water 66 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 19.1 | J1 |
| 166 | MM-005 → FP-017 | 000aa55e·0009f84a | 1546793730625062, 8625373596366777 | Pipes AP DCW Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 19.1 | J1 |
| 167 | MM-005 → FP-017 | 000aa5b0·0009f84d | 7225706899546106, 8668943910785597 | Pipes AP DHW Ø16 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 19.1 | J1 |
| 168 | MM-005 → FP-017 | 000aa5ba·0009f84c | 786522605844514, 8205169189238583 | Pipes AP Domestic Hot Water 49 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 19.1 | J1 |
| 169 | MM-005 → FP-017 | 000aa5e6·0009f84d | 586491255581720, 6276958424396346 | Pipes AP Domestic Cold Water 85 Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 19.1 | J1 |
| 170 | MM-005 → FP-017 | 000aa5e8·0009f84c | 1558247742867682, 6200573337129782 | Pipes AP DCW Ø16 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 19.1 | J1 |
| 171 | MM-002 → FP-017 | 0009f82c·0009f854 | 3648777198233124, 6166802656140177 | Pipes ALC Sanitary 13 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 10.8 | J1 |
| 172 | MM-002 → FP-017 | 0009f837·0009f853 | 5222216476453312, 6268428086868955 | Pipes ALC Sanitary 13 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 10.8 | J1 |
| 173 | MM-002 → FP-017 | 0009f83c·0009f852 | 1240607733020996, 9000089749981995 | Pipes ALC Sanitary 82 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 10.8 | J1 |
| 174 | MM-002 → FP-017 | 0009f846·0009f870 | 5161611672417307, 6166854411981140 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 40 | J1 |
| 175 | MM-002 → FP-017 | 0009f846·0009f87b | 2423968914100366, 7973261884905969 | Pipes ALC Sanitary 5 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 7.9 | J1 |
| 176 | MM-002 → FP-017 | 0009f846·0009f880 | 3450504479928436, 5182601000776822 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 6.2 | J1 |
| 177 | MM-002 → FP-017 | 0009f847·0009f879 | 2800367625769516, 3124474505202389 | Pipe Fittings ALC Sanitary 90 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 40 | J1 |
| 178 | MM-002 → FP-017 | 0009f847·0009f87c | 1838361205243029, 7357074005589700 | Pipes ALC Sanitary 90 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 7.9 | J1 |
| 179 | MM-002 → FP-017 | 0009f847·0009f882 | 5759719570038190, 5812919297824864 | Pipe Fittings ALC Sanitary 90 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 6.2 | J1 |
| 180 | MM-002 → FP-017 | 0009f848·0009f866 | 900148361604546, 3156150032349244 | Pipes ALC Sanitary 5 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 7.9 | J1 |
| 181 | MM-002 → FP-017 | 0009f848·0009f867 | 4206639637901516, 8492475798827721 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 40 | J1 |
| 182 | MM-002 → FP-017 | 0009f848·0009f884 | 1209653340466447, 6652574608128930 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 6.2 | J1 |
| 183 | MM-002 → FP-017 | 0009f849·0009f888 | 4297240120134215, 5464535269888943 | Pipes ALC Sanitary 5 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 7.9 | J1 |
| 184 | MM-002 → FP-017 | 0009f849·0009f88a | 3063500092007789, 4618737954525097 | Pipe Fittings ALC Sanitary 5 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 36.5 | J1 |
| 185 | MM-002 → FP-017 | 0009f84a·0009f88d | 1460935480854036, 6414789341955629 | Pipes ALC Sanitary 3 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 7.9 | J1 |
| 186 | MM-002 → FP-017 | 0009f84a·0009f88f | 1302480147695737, 8626855293308601 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 40 | J1 |
| 187 | MM-002 → FP-017 | 0009f84a·0009f8ac | 1864900451369709, 3210793664576442 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 6.2 | J1 |
| 188 | MM-002 → FP-017 | 0009f84b·0009f8b0 | 5105166777592557, 7418349444193795 | Pipes ALC Sanitary 3 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 20.6 | J1 |
| 189 | MM-002 → FP-017 | 0009f84b·0009f8b3 | 4345219263962927, 6779717368316206 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 36.5 | J1 |
| 190 | MM-002 → FP-017 | 0009f84c·0009f8b7 | 1933741531856620, 8776117690976049 | Pipes ALC Sanitary Yacht 20, 22, 25, 27 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 20.6 | J1 |
| 191 | MM-002 → FP-017 | 0009f84c·0009f8b9 | 813461312192558, 3643493697734094 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 40 | J1 |
| 192 | MM-002 → FP-017 | 0009f84c·0009f8d6 | 6327768872446707, 7130367229283619 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 6.2 | J1 |
| 193 | MM-002 → FP-017 | 0009f84d·0009f8da | 4913792700751156, 8642221877977271 | Pipes ALC Sanitary Yacht 20, 22, 25, 27 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 20.6 | J1 |
| 194 | MM-002 → FP-017 | 0009f84d·0009f8dd | 1081396977777206, 6133869922426958 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 36.5 | J1 |
| 195 | MM-002 → FP-017 | 0009f84e·0009f8cb | 964346878945892, 3882769731659447 | Pipe Fittings ALC Sanitary 116 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 40 | J1 |
| 196 | MM-002 → FP-017 | 0009f84e·0009f8ce | 1416885346665937, 5910849054993949 | Pipes ALC Sanitary 116 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 20.6 | J1 |
| 197 | MM-002 → FP-017 | 0009f84e·0009f8d4 | 1670470806922882, 2016855011777429 | Pipe Fittings ALC Sanitary 116 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 6.2 | J1 |
| 198 | MM-002 → FP-017 | 0009f84f·0009f8c2 | 999556820468630, 2086926283519736 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 40 | J1 |
| 199 | MM-002 → FP-017 | 0009f84f·0009f8cd | 3433874669777926, 7174781480998927 | Pipes ALC Sanitary Yacht 20, 22, 25, 27 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 20.6 | J1 |
| 200 | MM-002 → FP-017 | 0009f84f·0009f8d2 | 480325171884311, 7168232498279659 | Pipe Fittings ALC Sanitary Yacht 20, 22, 25, 27 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 6.2 | J1 |
| 201 | MM-002 → FP-017 | 0009f850·0009f8a1 | 219454680876273, 3721266887646723 | Pipe Fittings ALC Sanitary 102 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 40 | J1 |
| 202 | MM-002 → FP-017 | 0009f850·0009f8a4 | 6440460084303649, 8416495486961212 | Pipes ALC Sanitary 102 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 20.6 | J1 |
| 203 | MM-002 → FP-017 | 0009f850·0009f8aa | 2215330594235245, 8172929936054032 | Pipe Fittings ALC Sanitary 102 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 6.2 | J1 |
| 204 | MM-002 → FP-017 | 0009f851·0009f898 | 5022575918696511, 6934707362011377 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 40 | J1 |
| 205 | MM-002 → FP-017 | 0009f851·0009f8a3 | 5301165761506345, 7827637344868598 | Pipes ALC Sanitary 3 Ø41 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 7.9 | J1 |
| 206 | MM-002 → FP-017 | 0009f851·0009f8a8 | 412509456932255, 6640885403418272 | Pipe Fittings ALC Sanitary 3 Ø38 (doc 2) | 'Bathroom Sink (Yacht)' (doc 1) | 301 THIRD FLOOR | 6.2 | J1 |
| 207 | MM-002 → FP-017 | 0009f855·0009f85f | 102621521678573, 7204261564628455 | Pipes ALC Sanitary 13 Ø41 (doc 1) | 'Bathroom Sink (Yacht)' (doc 2) | 301 THIRD FLOOR | 27 | J1 |
| 208 | MM-005 → FP-019 | 00078983·000a341e | 6120053437124536, 6466965223576993 | Ducts CLI Mechanical Supply Air 1 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 101 FIRST FLOOR | 114.3 | J2 |
| 209 | MM-005 → FP-019 | 000aca95·0007a372 | 3337535132603361, 4142611783039443 | Ducts CLI Mechanical Supply Air 6 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 101 FIRST FLOOR | 114.3 | J2 |
| 210 | MM-005 → FP-019 | 000b21a5·0007a4a3 | 3684904921374088, 6946429578606771 | Ducts CLI Mechanical Supply Air 23 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 101 FIRST FLOOR | 114.3 | J2 |
| 211 | MM-005 → FP-019 | 000b21a5·000a64f0 | 2639049492101738, 5238806070895866 | Ducts CLI Mechanical Supply Air 16 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 101 FIRST FLOOR | 114.3 | J2 |
| 212 | MM-005 → FP-019 | 000a295b·0007a394 | 2269668058641478, 7265082483377768 | Ducts CLI Mechanical Supply Air 5 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 101 FIRST FLOOR | 114.3 | J2 |
| 213 | MM-005 → FP-019 | 000a2f1a·0007a39d | 1691578293596762, 5183416506443334 | Ducts CLI Mechanical Supply Air 8 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 101 FIRST FLOOR | 114.3 | J2 |
| 214 | MM-005 → FP-019 | 000a32fb·0007a3c0 | 1336965953808886, 2083407170599398 | Ducts CLI Mechanical Supply Air 10 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 101 FIRST FLOOR | 114.3 | J2 |
| 215 | MM-005 → FP-019 | 000a3664·0007a491 | 1882260051106833, 2653366284824242 | Ducts CLI Mechanical Supply Air 19 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 101 FIRST FLOOR | 114.3 | J2 |
| 216 | MM-005 → FP-019 | 000a3665·0007a49a | 2586497312822785, 6894985651235357 | Ducts CLI Mechanical Supply Air 21 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 101 FIRST FLOOR | 114.3 | J2 |
| 217 | MM-005 → FP-019 | 000a3777·0007a369 | 4294580917775463, 5370538442173193 | Ducts CLI Mechanical Supply Air 4 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 101 FIRST FLOOR | 114.3 | J2 |
| 218 | MM-005 → FP-019 | 000a37ed·0007a47f | 888410441241938, 3961989540208382 | Ducts CLI Mechanical Supply Air 15 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 101 FIRST FLOOR | 114.3 | J2 |
| 219 | MM-005 → FP-019 | 000a37ee·0007a488 | 5516296346967581, 8680293152529154 | Ducts CLI Mechanical Supply Air 17 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 101 FIRST FLOOR | 114.3 | J2 |
| 220 | MM-005 → FP-019 | 000a384d·0007a2ff | 8504800289772391, 8750041551170031 | Ducts CLI Mechanical Supply Air 2 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 101 FIRST FLOOR | 114.3 | J2 |
| 221 | MM-005 → FP-019 | 000a386c·0007a310 | 1584793105826151, 4440221569071467 | Ducts CLI Mechanical Supply Air 3 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 101 FIRST FLOOR | 114.3 | J2 |
| 222 | MM-005 → FP-019 | 000a38c3·0007a46c | 4562407404619872, 6501678647942186 | Ducts CLI Mechanical Supply Air 11 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 101 FIRST FLOOR | 114.3 | J2 |
| 223 | MM-005 → FP-019 | 000a38c4·0007a475 | 609325798851435, 2616325049741524 | Ducts CLI Mechanical Supply Air 13 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 101 FIRST FLOOR | 114.3 | J2 |
| 224 | MM-005 → FP-019 | 0007a462·000aea4c | 62584318018223, 3677245556461651 | Ducts CLI 1027 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 101 FIRST FLOOR | 114.3 | J2 |
| 225 | MM-005 → FP-019 | 0007a4d8·000b4732 | 389959737044856, 4380648404544451 | Ducts CLI Mechanical Supply Air 9 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 201 SECOND FLOOR | 71.4 | J1 |
| 226 | MM-005 → FP-019 | 0007a4e2·000b3b78 | 3921043864836968, 5740281655516311 | Ducts CLI Mechanical Supply Air 14 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 201 SECOND FLOOR | 71.4 | J1 |
| 227 | MM-005 → FP-019 | 0007a4eb·000b3b79 | 2261905937982413, 5041608612614950 | Ducts CLI Mechanical Supply Air 18 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 201 SECOND FLOOR | 71.4 | J1 |
| 228 | MM-005 → FP-019 | 0007a4f5·000b3b75 | 1062899297893309, 6774752400388026 | Ducts CLI Mechanical Supply Air 22 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 201 SECOND FLOOR | 71.4 | J1 |
| 229 | MM-005 → FP-019 | 0007a4fe·000b3b7c | 376480269033552, 1555594445508758 | Ducts CLI Mechanical Supply Air 25 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 201 SECOND FLOOR | 71.4 | J1 |
| 230 | MM-005 → FP-019 | 0007a507·000b3b71 | 140965239750822, 2961829390726012 | Ducts CLI Mechanical Supply Air 27 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 201 SECOND FLOOR | 71.4 | J1 |
| 231 | MM-005 → FP-019 | 0007a510·000b3b72 | 5605836007895786, 5974626348380978 | Ducts CLI Mechanical Supply Air 29 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 201 SECOND FLOOR | 71.4 | J1 |
| 232 | MM-005 → FP-019 | 0007a519·000b0a79 | 4218887424371933, 7005604928250792 | Ducts CLI Mechanical Supply Air 31 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 201 SECOND FLOOR | 71.4 | J1 |
| 233 | MM-005 → FP-019 | 0007a522·000b4733 | 5475216313757183, 6376553184641076 | Ducts CLI Mechanical Supply Air 33 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 201 SECOND FLOOR | 71.4 | J1 |
| 234 | MM-005 → FP-019 | 0007a52b·000b3b7a | 3592344326045668, 6603690167552993 | Ducts CLI Mechanical Supply Air 35 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 201 SECOND FLOOR | 71.4 | J1 |
| 235 | MM-005 → FP-019 | 0007a533·000b3b7b | 1110718638275954, 6203630765229543 | Ducts CLI Mechanical Supply Air 37 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 201 SECOND FLOOR | 71.4 | J1 |
| 236 | MM-005 → FP-019 | 0007a53c·000b3b76 | 3434875023539087, 4900271025056661 | Ducts CLI Mechanical Supply Air 39 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 201 SECOND FLOOR | 71.4 | J1 |
| 237 | MM-005 → FP-019 | 0007a544·000b3b77 | 5782522498251, 6423916678157156 | Ducts CLI Mechanical Supply Air 41 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 201 SECOND FLOOR | 71.4 | J1 |
| 238 | MM-005 → FP-019 | 0007a54c·000b3b73 | 4729754816446538, 8437809079576532 | Ducts CLI Mechanical Supply Air 43 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 201 SECOND FLOOR | 71.4 | J1 |
| 239 | MM-005 → FP-019 | 0007a554·000b3b74 | 5553621006484423, 5774363249619352 | Ducts CLI Mechanical Supply Air 45 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 201 SECOND FLOOR | 71.4 | J1 |
| 240 | MM-005 → FP-019 | 0007a55c·000b23cc | 163828009624462, 2979629689152119 | Ducts CLI Mechanical Supply Air 47 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 201 SECOND FLOOR | 71.4 | J1 |
| 241 | MM-005 → FP-019 | 0007a5fc·000b473a | 720299560393000, 1590010142149098 | Ducts CLI Mechanical Supply Air 12 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 301 THIRD FLOOR | 71.4 | J1 |
| 242 | MM-005 → FP-019 | 0007a603·000b3ba3 | 3419578606312514, 6415404235542316 | Ducts CLI Mechanical Supply Air 20 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 301 THIRD FLOOR | 71.4 | J1 |
| 243 | MM-005 → FP-019 | 0007a60a·000b3ba4 | 4503098714282712, 6388576589767854 | Ducts CLI Mechanical Supply Air 26 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 301 THIRD FLOOR | 71.4 | J1 |
| 244 | MM-005 → FP-019 | 0007a611·000b3ba0 | 7783734026171189, 8785958155785816 | Ducts CLI Mechanical Supply Air 30 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 301 THIRD FLOOR | 71.4 | J1 |
| 245 | MM-005 → FP-019 | 0007a618·000b3ba7 | 4917779078684359, 5716241669139575 | Ducts CLI Mechanical Supply Air 34 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 301 THIRD FLOOR | 71.4 | J1 |
| 246 | MM-005 → FP-019 | 0007a61f·000b3b9c | 1305306375878564, 3315314149822267 | Ducts CLI Mechanical Supply Air 38 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 301 THIRD FLOOR | 71.4 | J1 |
| 247 | MM-005 → FP-019 | 0007a626·000b3b9d | 1047847498341112, 1820430830119672 | Ducts CLI Mechanical Supply Air 42 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 301 THIRD FLOOR | 71.4 | J1 |
| 248 | MM-005 → FP-019 | 0007a62d·000b3b7d | 2531643907678989, 3181328457875135 | Ducts CLI Mechanical Supply Air 46 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 301 THIRD FLOOR | 71.4 | J1 |
| 249 | MM-005 → FP-019 | 0007a634·000b473b | 2951333112893654, 4756869795926060 | Ducts CLI Mechanical Supply Air 49 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 301 THIRD FLOOR | 71.4 | J1 |
| 250 | MM-005 → FP-019 | 0007a63b·000b3ba5 | 1937745510414407, 4399634950347120 | Ducts CLI Mechanical Supply Air 51 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 301 THIRD FLOOR | 71.4 | J1 |
| 251 | MM-005 → FP-019 | 0007a642·000b3ba6 | 6214422757281368, 6837297424645834 | Ducts CLI Mechanical Supply Air 53 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 301 THIRD FLOOR | 71.4 | J1 |
| 252 | MM-005 → FP-019 | 0007a649·000b3ba1 | 2678607746780016, 8658368983595242 | Ducts CLI Mechanical Supply Air 55 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 301 THIRD FLOOR | 71.4 | J1 |
| 253 | MM-005 → FP-019 | 0007a650·000b3ba2 | 1427365471411276, 1452283223415480 | Ducts CLI Mechanical Supply Air 57 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 301 THIRD FLOOR | 71.4 | J1 |
| 254 | MM-005 → FP-019 | 0007a657·000b3b9e | 2669139980875147, 4648034922985121 | Ducts CLI Mechanical Supply Air 59 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 301 THIRD FLOOR | 71.4 | J1 |
| 255 | MM-005 → FP-019 | 0007a65e·000b3b9f | 3761100229571647, 5692575908228193 | Ducts CLI Mechanical Supply Air 61 Ø356 (doc 1) | 'FANCOIL-4-PIPE-NO RISER' (doc 2) | 301 THIRD FLOOR | 71.4 | J1 |
| 256 | MM-005 → FP-019 | 0007a665·000b3b7e | 5088409178620901, 7389054666891118 | Ducts CLI Mechanical Supply Air 63 Ø356 (doc 2) | 'FANCOIL-4-PIPE-NO RISER' (doc 1) | 301 THIRD FLOOR | 71.4 | J1 |
| 257 | MM-005 → FP-018 | 000a68ed·000a9cac | 966369046419731, 6346462962712146 | Pipes CAL Hydronic Supply 38 Ø41 (doc 1) | 'PIPE COVER' (doc 2) | 101 FIRST FLOOR | 46.3 | J2 |
| 258 | MM-005 → FP-018 | 000a6945·000a9cac | 4162762593788736, 8070620636704319 | Pipes CAL CHWS Ø41 (doc 1) | 'PIPE COVER' (doc 2) | 101 FIRST FLOOR | 46.3 | J2 |
| 259 | MM-005 → FP-018 | 000a9cac·000a66e8 | 7566441296871457, 8207788386596690 | Pipes CAL HHWR Ø41 (doc 1) | 'PIPE COVER' (doc 2) | 101 FIRST FLOOR | 46.3 | J2 |
| 260 | MM-005 → FP-018 | 000a9cac·000a673c | 2961611639187244, 5418591610791143 | Pipes CAL HHWS Ø41 (doc 1) | 'PIPE COVER' (doc 2) | 101 FIRST FLOOR | 46.3 | J2 |
| 261 | MM-005 → FP-018 | 000899fa·000abdc8 | 5122021182113588, 8946195485455840 | Pipes AP DCW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 54.8 | J2 |
| 262 | MM-005 → FP-018 | 000899fb·000abdc8 | 274572594039673, 3763734691372785 | Pipes AP DHW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 65.5 | J2 |
| 263 | MM-005 → FP-018 | 000a5f32·000a9c27 | 979691164488851, 6370637971301241 | Pipes CAL CHWS Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 65.5 | J2 |
| 264 | MM-005 → FP-018 | 000a4e93·000a95a2 | 6416265466627885, 6531127187768535 | Pipes CAL HHWR Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 65.5 | J2 |
| 265 | MM-005 → FP-018 | 000a5197·000a95a2 | 1792559246688779, 6352697304082313 | Pipes CAL HHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 53.9 | J2 |
| 266 | MM-005 → FP-018 | 000a548b·000a95a2 | 113266352825061, 7458957579976792 | Pipes CAL Hydronic Supply 38 Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 58.3 | J2 |
| 267 | MM-005 → FP-018 | 000a570c·000a95a2 | 22008041835347, 4452706911408757 | Pipes CAL CHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 65.5 | J2 |
| 268 | MM-005 → FP-018 | 000a57ea·000a9c1e | 3073301223745079, 8098847090288087 | Pipes CAL CHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 65.5 | J2 |
| 269 | MM-005 → FP-018 | 000a41ac·000a9c36 | 1425714337453069, 1792216664813441 | Pipes CAL CHWS Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 65.5 | J2 |
| 270 | MM-005 → FP-018 | 000a9f5b·000abdb4 | 5257200264258116, 5635990688692573 | Pipes AP DCW Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 65.5 | J2 |
| 271 | MM-005 → FP-018 | 000a9f5c·000abdb4 | 1005488163768737, 8665374953224538 | Pipes AP DHW Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 28.5 | J2 |
| 272 | MM-005 → FP-018 | 000aa058·000abdd1 | 963264274721697, 5386084967943242 | Pipes AP DCW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 54.8 | J2 |
| 273 | MM-005 → FP-018 | 000aa059·000abdd1 | 227218708448542, 5313282968677961 | Pipes AP DHW Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 65.5 | J2 |
| 274 | MM-005 → FP-018 | 000aa155·000abde4 | 1059847282975913, 1193290359043757 | Pipes AP DCW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 54.8 | J2 |
| 275 | MM-005 → FP-018 | 000aa156·000abde4 | 498622797074619, 3934668684880763 | Pipes AP DHW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 65.5 | J2 |
| 276 | MM-005 → FP-018 | 000aa3fc·000abdc7 | 6283964322480737, 7983033228645300 | Pipes AP DCW Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 65.5 | J2 |
| 277 | MM-005 → FP-018 | 000aa3fd·000abdc7 | 6003284111652919, 7380913010983182 | Pipes AP DHW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 58.5 | J2 |
| 278 | MM-005 → FP-018 | 000aa486·000abd96 | 301381302525708, 871132489415677 | Pipes AP DCW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 28.8 | J2 |
| 279 | MM-005 → FP-018 | 000aa487·000abd96 | 3467351908155164, 4692875088476218 | Pipes AP DHW Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 65.5 | J2 |
| 280 | MM-005 → FP-018 | 000aa510·000abdd0 | 805125060399286, 2664818903331077 | Pipes AP DCW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 65.5 | J2 |
| 281 | MM-005 → FP-018 | 000aa511·000abdd0 | 7089107916793608, 7710121859904662 | Pipes AP DHW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 58.5 | J2 |
| 282 | MM-005 → FP-018 | 000aa59a·000abde3 | 3333869864657691, 5637523003356224 | Pipes AP DCW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 65.5 | J2 |
| 283 | MM-005 → FP-018 | 000aa59b·000abde3 | 3896724276278853, 5572820614261541 | Pipes AP DHW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 58.5 | J2 |
| 284 | MM-005 → FP-018 | 0007d9ed·000a9c27 | 1393774507196147, 8927726366160939 | Pipes CAL Hydronic Supply 38 Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 58.4 | J2 |
| 285 | MM-005 → FP-018 | 0007d9f9·000a9c27 | 8287795212845815, 8918737655946036 | Pipes CAL HHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 53.9 | J2 |
| 286 | MM-005 → FP-018 | 0007da07·000a9c27 | 2839287695484341, 4162734288731965 | Pipes CAL Hydronic Supply 12 Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 65.5 | J2 |
| 287 | MM-005 → FP-018 | 0007dcbf·000a9c38 | 3595633844653885, 6413596268993869 | Pipes CAL CHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 65.5 | J2 |
| 288 | MM-005 → FP-018 | 0007dcc0·000a9c38 | 3414978143732236, 8341444058666680 | Pipes CAL Hydronic Supply 38 Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 53.2 | J2 |
| 289 | MM-005 → FP-018 | 0007dcc1·000a9c38 | 4534225126811377, 5690986256660259 | Pipes CAL HHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 59 | J2 |
| 290 | MM-005 → FP-018 | 0007dcc2·000a9c38 | 798914684601718, 4344753552597274 | Pipes CAL Hydronic Supply 12 Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 65.5 | J2 |
| 291 | MM-005 → FP-018 | 0007deb1·000a9c1e | 3370482644184008, 6938794985521266 | Pipes CAL Hydronic Supply 38 Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 58.4 | J2 |
| 292 | MM-005 → FP-018 | 0007deb2·000a9c1e | 1371891944147916, 5431144938276926 | Pipes CAL HHWS Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 53.9 | J2 |
| 293 | MM-005 → FP-018 | 0007deb3·000a9c1e | 1613733944094463, 3219118015818902 | Pipes CAL Hydronic Supply 12 Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 65.5 | J2 |
| 294 | MM-005 → FP-018 | 0007dec0·000a9c37 | 5585821689535627, 6794258642282399 | Pipes CAL CHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 65.5 | J2 |
| 295 | MM-005 → FP-018 | 0007dec1·000a9c37 | 2768281106709863, 6180480947442161 | Pipes CAL Hydronic Supply 38 Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 53.2 | J2 |
| 296 | MM-005 → FP-018 | 0007dec2·000a9c37 | 21516700429202, 1005589297588433 | Pipes CAL HHWS Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 59 | J2 |
| 297 | MM-005 → FP-018 | 0007dec3·000a9c37 | 901008705691324, 3315840481909122 | Pipes CAL Hydronic Supply 12 Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 65.5 | J2 |
| 298 | MM-005 → FP-018 | 0007df2d·000a9c36 | 548849295208117, 666197816690492 | Pipes CAL Hydronic Supply 38 Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 53.2 | J2 |
| 299 | MM-005 → FP-018 | 0007df2e·000a9c36 | 5757013659753395, 8242284810818005 | Pipes CAL HHWS Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 59 | J2 |
| 300 | MM-005 → FP-018 | 0007df2f·000a9c36 | 4911069949370210, 7326718710792924 | Pipes CAL HHWR Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 65.5 | J2 |
| 301 | MM-005 → FP-018 | 000a9d75·000a71e3 | 4913941449308975, 7953909620875872 | Pipes CAL CHWS Ø41 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 51.7 | J2 |
| 302 | MM-005 → FP-018 | 000a9d75·000a721f | 3449300481715497, 6364303294753404 | Pipes CAL Hydronic Supply 38 Ø41 (doc 1) | 'PIPE COVER' (doc 2) | 301 THIRD FLOOR | 51.7 | J2 |
| 303 | MM-005 → FP-018 | 000a9d75·000a725e | 4989563219361808, 8381486493875169 | Pipes CAL HHWS Ø41 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 23.6 | J2 |
| 304 | MM-005 → FP-018 | 000a9d75·000a72a1 | 1061477103521142, 5830922435214684 | Pipes CAL Hydronic Supply 12 Ø41 (doc 2) | 'PIPE COVER' (doc 1) | 301 THIRD FLOOR | 51.7 | J2 |
| 305 | MM-005 → FP-018 | 000a8d8b·000a9d08 | 7251849892552073, 7809531784065107 | Pipes CAL Hydronic Supply 12 Ø41 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 51.7 | J2 |
| 306 | MM-005 → FP-018 | 000a8db5·000a9d08 | 7784177763876954, 8307689500188062 | Pipes CAL HHWS Ø41 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 51.7 | J2 |
| 307 | MM-005 → FP-018 | 000a8dd8·000a9d08 | 17880137052938, 4301618841659691 | Pipes CAL Hydronic Supply 38 Ø41 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 25.1 | J2 |
| 308 | MM-005 → FP-018 | 000a8dfa·000a9d08 | 2117384822538249, 3779498620545840 | Pipes CAL CHWS Ø41 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 51.7 | J2 |
| 309 | MM-005 → FP-018 | 000a8e17·000a9d08 | 3342362069761493, 8810786673486883 | Pipes CAL Hydronic Supply 12 Ø41 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 32.9 | J2 |
| 310 | MM-005 → FP-018 | 000a8e2a·000a9d75 | 4563868512408784, 5197124321808294 | Pipes CAL Hydronic Supply 12 Ø41 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 13.2 | J2 |
| 311 | MM-005 → FP-018 | 000a8eab·000a9d08 | 1594041088716018, 3495282198349586 | Pipes CAL HHWS Ø41 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 27.4 | J2 |
| 312 | MM-005 → FP-018 | 000a8ebf·000a9d08 | 6916313082214108, 7744769776259416 | Pipes CAL Hydronic Supply 38 Ø41 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 17.3 | J2 |
| 313 | MM-005 → FP-018 | 000a8ed1·000a9d08 | 2984884426922405, 6139972972836635 | Pipes CAL CHWS Ø41 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 16 | J2 |
| 314 | MM-005 → FP-018 | 000a8f13·000a9d75 | 4044920935902424, 6461748775809916 | Pipes CAL HHWS Ø41 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 18.7 | J2 |
| 315 | MM-005 → FP-018 | 000a8f25·000a9d75 | 105952044355050, 5647218859311988 | Pipes CAL Hydronic Supply 38 Ø41 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 29 | J2 |
| 316 | MM-005 → FP-018 | 000a8f39·000a9d75 | 415968213799129, 970827978943636 | Pipes CAL CHWS Ø41 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 33.9 | J2 |
| 317 | MM-005 → FP-018 | 000ab90e·000abdc8 | 3671203225093740, 8598176120742628 | Pipes AP DHW Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 27.1 | J2 |
| 318 | MM-005 → FP-018 | 000ab922·000abdc7 | 1717212998729288, 4177594681615971 | Pipes AP DHW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 78.3 | J2 |
| 319 | MM-005 → FP-018 | 000ab959·000abdc7 | 1092476904770569, 4305281923192795 | Pipes AP DCW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 29.7 | J2 |
| 320 | MM-005 → FP-018 | 000ab97e·000abdc8 | 421250301263976, 8217860328813880 | Pipes AP DCW Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 78.3 | J2 |
| 321 | MM-005 → FP-018 | 000a7f14·000a9cac | 2175836261471629, 3199405424340821 | Pipes CAL CHWS Ø41 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 59.8 | J1 |
| 322 | MM-005 → FP-018 | 000a7f21·000a9cac | 2505537927384419, 4508248644343932 | Pipes CAL Hydronic Supply 38 Ø41 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 59.9 | J1 |
| 323 | MM-005 → FP-018 | 000a7f2e·000a9cac | 5218652023269899, 5345956775479127 | Pipes CAL HHWS Ø41 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 21.5 | J1 |
| 324 | MM-005 → FP-018 | 000a7f3b·000a9cac | 185591839842155, 3431739489214725 | Pipes CAL HHWR Ø41 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 55.3 | J1 |
| 325 | MM-005 → FP-018 | 0007da1f·000a9c27 | 2138340254658447, 8768651751896472 | Pipes CAL CHWS Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 74 | J2 |
| 326 | MM-005 → FP-018 | 0007dae0·000a9c27 | 4081609929926812, 8805199635458309 | Pipes CAL Hydronic Supply 38 Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 77.1 | J2 |
| 327 | MM-005 → FP-018 | 0007db3c·000a9c27 | 5310960688613817, 8104917416372882 | Pipes CAL HHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 41.6 | J2 |
| 328 | MM-005 → FP-018 | 0007db88·000a9c27 | 4795753743667089, 6137250759936505 | Pipes CAL Hydronic Supply 12 Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 50.2 | J1 |
| 329 | MM-005 → FP-018 | 0007dcc3·000a9c38 | 2015732432182817, 8848741833328233 | Pipes CAL CHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 64.1 | J2 |
| 330 | MM-005 → FP-018 | 0007dcc7·000a9c38 | 506952248346351, 2203204903948055 | Pipes CAL Hydronic Supply 38 Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 42.2 | J2 |
| 331 | MM-005 → FP-018 | 0007dccb·000a9c38 | 6777557882691311, 7414108251507755 | Pipes CAL HHWS Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 77.5 | J2 |
| 332 | MM-005 → FP-018 | 0007dccf·000a9c38 | 2898413742893577, 6008992397533610 | Pipes CAL Hydronic Supply 12 Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 50.2 | J1 |
| 333 | MM-005 → FP-018 | 0007deb4·000a9c1e | 3399653861827550, 7733484872953856 | Pipes CAL CHWS Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 74 | J2 |
| 334 | MM-005 → FP-018 | 0007deb7·000a9c1e | 4580210311045332, 5583344464981690 | Pipes CAL Hydronic Supply 38 Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 77.1 | J2 |
| 335 | MM-005 → FP-018 | 0007deba·000a9c1e | 602122638077894, 3149737948284864 | Pipes CAL HHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 41.6 | J2 |
| 336 | MM-005 → FP-018 | 0007debd·000a9c1e | 50102801954440, 1922254690369061 | Pipes CAL Hydronic Supply 12 Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 50.2 | J1 |
| 337 | MM-005 → FP-018 | 0007dec4·000a9c37 | 5262135998212722, 5633410612544388 | Pipes CAL CHWS Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 64.1 | J2 |
| 338 | MM-005 → FP-018 | 0007dec7·000a9c37 | 5545088381893007, 6463247052582530 | Pipes CAL Hydronic Supply 38 Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 42.2 | J2 |
| 339 | MM-005 → FP-018 | 0007deca·000a9c37 | 451014520989206, 2151603713706914 | Pipes CAL HHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 77.5 | J2 |
| 340 | MM-005 → FP-018 | 0007decd·000a9c37 | 3697582136855728, 8763132691800983 | Pipes CAL Hydronic Supply 12 Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 50.2 | J1 |
| 341 | MM-005 → FP-018 | 0007df20·000a95a2 | 149819354840266, 5942169988200178 | Pipes CAL CHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 74 | J2 |
| 342 | MM-005 → FP-018 | 0007df23·000a95a2 | 1922398856980306, 7038005718344695 | Pipes CAL Hydronic Supply 38 Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 77.1 | J2 |
| 343 | MM-005 → FP-018 | 0007df26·000a95a2 | 4161617490440652, 6521118586829014 | Pipes CAL HHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 41.6 | J2 |
| 344 | MM-005 → FP-018 | 0007df29·000a95a2 | 5505693051544203, 7210216183919193 | Pipes CAL HHWR Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 50.2 | J1 |
| 345 | MM-005 → FP-018 | 0007df30·000a9c36 | 2141609395604236, 3703885086457095 | Pipes CAL CHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 64.1 | J2 |
| 346 | MM-005 → FP-018 | 0007df33·000a9c36 | 5422866145581839, 6684620579778110 | Pipes CAL Hydronic Supply 38 Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 42.2 | J2 |
| 347 | MM-005 → FP-018 | 0007df36·000a9c36 | 4246510879024540, 4251427992353310 | Pipes CAL HHWS Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 77.5 | J2 |
| 348 | MM-005 → FP-018 | 0007df39·000a9c36 | 7520156572129358, 8453366437021676 | Pipes CAL HHWR Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 50.2 | J1 |
| 349 | MM-005 → FP-018 | 000abbd2·000abdb4 | 1409958018824505, 3286537090431432 | Pipes AP DHW Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 27.1 | J2 |
| 350 | MM-005 → FP-018 | 000abbd5·000abd96 | 6809395930750778, 7136760918569576 | Pipes AP DHW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 50.5 | J2 |
| 351 | MM-005 → FP-018 | 000abbd8·000abd96 | 3514661845054213, 4697894587565328 | Pipes AP DCW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 30.2 | J2 |
| 352 | MM-005 → FP-018 | 000abbda·000abdb4 | 1144838865736457, 4158942928579175 | Pipes AP DCW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 50.5 | J2 |
| 353 | MM-005 → FP-018 | 000abbfd·000abdd1 | 3114668412212281, 3832994062757049 | Pipes AP DHW Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 27.1 | J2 |
| 354 | MM-005 → FP-018 | 000abc00·000abdd0 | 1613512747293096, 7954871846134536 | Pipes AP DHW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 78.3 | J2 |
| 355 | MM-005 → FP-018 | 000abc03·000abdd0 | 3962404067005139, 6454557152174216 | Pipes AP DCW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 30.2 | J2 |
| 356 | MM-005 → FP-018 | 000abc05·000abdd1 | 3159718242684517, 5373046570595889 | Pipes AP DCW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 74 | J2 |
| 357 | MM-005 → FP-018 | 000abc26·000abde4 | 3837288201640339, 8512189163663045 | Pipes AP DHW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 27.1 | J2 |
| 358 | MM-005 → FP-018 | 000abc29·000abde3 | 4674520989919709, 6126652216791094 | Pipes AP DHW Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 78.3 | J2 |
| 359 | MM-005 → FP-018 | 000abc2c·000abde3 | 856160589968712, 5859436413770750 | Pipes AP DCW Ø54 (doc 1) | 'PIPE COVER' (doc 2) | 401 ROOF | 30.2 | J2 |
| 360 | MM-005 → FP-018 | 000abc2e·000abde4 | 529088379104039, 2333195478451684 | Pipes AP DCW Ø54 (doc 2) | 'PIPE COVER' (doc 1) | 401 ROOF | 74 | J2 |

