# Checklist del primer piloto en proyecto real

Uso: imprime o copia esta lista para el piloto, marca cada punto y anota la evidencia (captura, ID de grupo o lote, fecha). Las referencias `§` apuntan a [`docs/research/aps-model-coordination-api.md`](research/aps-model-coordination-api.md) salvo que se indique otra cosa.

Punto de partida honesto: el motor está validado solo con datos sintéticos ([`docs/domain/engine-review-2026-11.md`](domain/engine-review-2026-11.md)). Varios detalles de la API de ACC están marcados **UNVERIFIED** y se verifican aquí, en un tenant real, antes de confiar en ellos.

**Regla del piloto: nada se aplica en ACC hasta completar las fases 1 a 4.**

Responsables sugeridos: **C** = coordinador/a piloto · **G** = gerente BIM · **D** = desarrollador/a del harness · **E** = especialista BIM (reglas).

---

## Fase 0 — Preparación

- [ ] (G) Proyecto piloto elegido: activo, con prueba de interferencias semanal, de tamaño moderado (500–5 000 interferencias), espacio de coordinación V2 de preferencia. Anotar si es V1 o V2.
- [ ] (G) Uso aprobado según el *Procedimiento Acceso Herramientas IA* de SalfaCorp (cuenta y plan de Claude Code corporativos, proyecto autorizado).
- [ ] (C) Instalación completa según [`docs/setup.md`](setup.md): app APS, Custom Integrations, `.env.local` con `VITE_COORD_API=http`, login, passkey (el agente de la app no requiere instalación).
- [ ] (C) `npm run coordinator -- status` muestra sesión APS, fuente `live` y autonomía L1.
- [ ] (C) **Línea base manual**: horas que toma hoy revisar una prueba completa y preparar la reunión (2 semanas anteriores, si es posible). Sin esto no se puede medir ahorro.
- [ ] (D) Anotar versión del repo (commit) y de `rules/` usada en el piloto.

## Fase 1 — Verificación de la API en el tenant real (solo lectura)

Ingerir la prueba más reciente (`/triage` o `npm run coordinator -- ingest`) y verificar:

| ✓ | Punto UNVERIFIED | Cómo verificarlo | Si falla |
|---|---|---|---|
| [ ] | **Unidades y signo de `dist`** (§3.2: se asume metros, negativo = penetración) | Tomar 5 interferencias (3 penetraciones, 2 holguras) y comparar la distancia en la UI con la que muestra ACC Model Coordination. Deben coincidir en mm y en signo. | Detener. Las reglas de severidad y tolerancia dependen de esto. D corrige la ingesta. |
| [ ] | **Estados 1–4 / `status`** (§3.2: no documentado; el estado real sale de grupos asignados/cerrados) | Comparar el estado de 10 interferencias (abiertas, con incidencia, cerradas) entre la UI y ACC. | D ajusta el cálculo de estado desde los endpoints de grupos. |
| [ ] | **`lvid` = `lmvId` del índice** (§4.1) | En la UI, abrir 10 grupos y confirmar que el visor resalta **los mismos elementos** que ACC (A azul, B naranja). Revisar el log del servidor: tasa de coincidencia del auto-chequeo ≥ 90 %. | Si < 90 %: probar `svf2Id` (§4.1 riesgo residual). Registrar si el modelo es SVF2. |
| [ ] | **Compresión gzip de los recursos** (§3.1) | La ingesta termina sin errores de parseo; número de interferencias igual al de ACC. | D revisa la detección por bytes mágicos `1f 8b`. |
| [ ] | **Sintaxis de consultas del Index** y llaves de campos (§4.2) | La ingesta reporta propiedades listas (no `pending`). Para 20 elementos, nivel, categoría, familia/tipo y sistema coinciden con Revit/ACC. | Clasificación degradada: anotar qué propiedades faltan; E revisa `rules/property-aliases.yaml`. |
| [ ] | **URN semilla `File` vs `Document`** (§4, §5) | Las propiedades se resuelven para todos los documentos del conjunto. | D usa `originalSeedFileVersionUrn`. |
| [ ] | **Más de una prueba por versión** (§3.1) | `list_clash_tests` muestra una sola prueba `Success` por versión, o se elige la última por `completedOn`. | Anotar el caso. |
| [ ] | **Reducción de alcance del token del navegador** (`docs/ai/harness-design.md` §8) | Tras iniciar sesión en la UI, la respuesta de `/api/auth/refresh` (DevTools → Network) trae `scope` = `data:read viewables:read` y ningún `refresh_token`. | Registrar; el visor sigue funcionando pero el token del navegador tendría más permisos de los necesarios. |
| [ ] | **Rotación del token de refresco** (§1.2) | Con la UI y Claude Code abiertos más de 60 min, ambos siguen funcionando sin pedir login. | D revisa la serialización de refrescos. |
| [ ] | **Responsables asignables** (§5) | En un borrador de incidencia, el selector "Asignado a" lista usuarios, roles y empresas del proyecto. | Asignación manual en ACC durante el piloto. |

## Fase 2 — Visor con modelos reales

- [ ] Todos los modelos del conjunto cargan; el estado muestra "Visor listo (N/N modelos)". Anotar los que fallen y por qué.
- [ ] Los modelos vinculados quedan alineados (sin desplazamientos entre disciplinas).
- [ ] Rayos X, Aislar y Contexto funcionan; caja de sección (`b`) y ajustar (`z`) encuadran la interferencia.
- [ ] El marcador del punto de interferencia cae en el cruce real (comparar 5 casos con ACC).
- [ ] Rendimiento: con la prueba completa, `j`/`k` responde sin retraso perceptible y el visor enfoca en ≤ 1 s. Anotar número de interferencias y de modelos.
- [ ] Grupos grandes (> 200 elementos por lado) muestran "Resaltado simplificado" sin congelar el navegador.

## Fase 3 — Ceremonia de aprobación con Windows Hello (sin aplicar)

En el proyecto piloto, con un lote real **que no se aplicará**:

- [ ] Registro de passkey: `passkey-enroll` en terminal propia → código → `/ajustes/passkey` → Windows Hello. El código no sirve una segunda vez.
- [ ] `passkey-enroll` y `approve` se niegan a correr dentro de Claude Code.
- [ ] Aprobar un lote pide `APLICAR` (si hay incidencias o ≥ 50 cambios) y Windows Hello con PIN o biometría.
- [ ] Si se excluye un ítem o se edita una incidencia **después** de pedir la firma, la aprobación se rechaza y pide firmar de nuevo.
- [ ] Una firma iniciada y no completada en 2 minutos expira.
- [ ] `npm run coordinator -- verify-approval <batchId> --json` devuelve `"valid": true` y el nombre del aprobador correcto.
- [ ] `/auditoria` muestra la cadena: ejecución del agente → propuesta → decisión → lote → aprobación.
- [ ] Pedirle al agente "aplica el lote" sin aprobación: el hook lo bloquea. Con aprobación: Claude Code pide confirmación y el agente hace primero `dryRun: true`.
- [ ] **Devolver a revisión** el lote al terminar (no aplicar).

## Fase 4 — Semana en modo sombra (solo lectura)

Durante al menos **una prueba completa (una semana)**, el agente propone y C revisa en la UI, pero **no se aplica ningún lote**. C sigue su proceso normal en ACC en paralelo.

- [ ] Ejecutar el flujo **Preparar el ciclo** (Qué sigue) sobre la prueba de la semana.
- [ ] C revisa **todos** los grupos en `/coordinacion/...`, corrigiendo con código de motivo (no aceptar en bloque para "terminar").
- [ ] Comparar con el triage manual de C en ACC: anotar cada diferencia de validez (especialmente cualquier interferencia `real` que el agente propuso cerrar o tolerar).
- [ ] Revisar 10 borradores de incidencia con un modelador receptor: ¿se entienden sin abrir el modelo? ¿un solo responsable? ¿≤ 1000 caracteres, sin markdown visible?
- [ ] Revisar los grupos: ¿un ítem de reunión por grupo? Anotar fragmentación (mismo problema en varios grupos), niveles en inglés/español mezclados, títulos con familias genéricas ("Muro básico"), camisas no correlacionadas.
- [ ] Revisar diferencias de ciclo: nuevas, persistentes, resueltas y **reaparecidas** frente a lo que C sabe del proyecto.
- [ ] Revisar `/auditar-modelo`: ¿los hallazgos de higiene son reales?
- [ ] Registrar las convenciones del proyecto que surjan en `notes.md` (vía el agente, con confirmación).
- [ ] Al cierre: **Descartar** o devolver los lotes de la semana.

**Criterio para pasar a la fase 6:** 0 cierres inseguros en la semana, KPIs de la tabla de abajo registrados, y acuerdo de C y G.

## Fase 5 — Calibrar las reglas pendientes con correcciones reales

El parche [`docs/domain/rules-pending-2026-11.patch`](domain/rules-pending-2026-11.patch) quedó pendiente hasta tener datos reales.

- [ ] Acumular correcciones de al menos una prueba completa (idealmente ≥ 100 correcciones o 2 ciclos).
- [ ] `/curar-reglas` → revisar las sugerencias en **Reglas › Sugerencias**.
- [ ] (E) Evaluar el parche pendiente contra el **feedback real**: pedir al agente en Claude Code, en lenguaje natural, "evalúa `docs/domain/rules-pending-2026-11.patch` con `evaluate_ruleset` incluyendo el feedback del proyecto" (escenarios + fixtures + reproducción del feedback). `/curar-reglas` propone sus propios parches a partir de las correcciones; no recibe este archivo como argumento.
- [ ] (E) Medir el efecto en la carga de revisión (solo sobre fixtures; sirve para comparar, no reemplaza lo anterior):
  ```bash
  # Git Bash
  COORD_DATA_SOURCE=fixtures COORDINATOR_HOME="$(mktemp -d)" npx tsx scripts/review/simulate.ts docs/domain/rules-pending-2026-11.patch sim.json
  npm run eval
  ```
  Puertas obligatorias: **0 cierres inseguros**, **0 falsos negativos críticos**, puntaje de rúbrica no menor al actual.
- [ ] (E + C) Decidir qué partes del parche se aplican. Una persona hace el merge con git; correr `npm test`.
- [ ] Volver a medir la tasa de revisión sobre la misma prueba con las reglas nuevas.
- [ ] Revisar la **calibración** (Reglas › Calibración): ¿las propuestas de confianza "Alta" se aceptan sin cambios ≥ 90 % de las veces?

## Fase 6 — Primera aplicación controlada

- [ ] Lote pequeño: ≤ 10 cambios de estado y 1–2 incidencias, todos P2–P4, nada de seguridad de personas ni aberturas estructurales.
- [ ] Comprobar con ACC (pre-chequeo) → aprobar con Windows Hello → revisar la **simulación** (cuerpos exactos) → Aplicar.
- [ ] En ACC: los cierres aparecen con el motivo esperado (recordar: "revisada" se aplica como cierre por tolerancia `MINIMAL_OVERLAP`); las incidencias se crearon vinculadas a las interferencias.
- [ ] **Pushpin** (§3.3, UNVERIFIED): el pin de cada incidencia nueva cae en la interferencia en el visor de ACC. Si cae desplazado, anotar el desfase y detener la creación de incidencias hasta corregir.
- [ ] Reintentar el mismo lote no duplica nada (idempotencia).
- [ ] La incidencia queda asignada a la persona/rol/empresa elegida y con fecha límite correcta.
- [ ] Ampliar el tamaño de lote solo después de dos aplicaciones limpias.

---

## KPIs a registrar (por prueba)

Fuente: **Reportes**, **Reglas › Calibración** y la barra de sesión de la UI, salvo indicación.

| KPI | Definición | Meta piloto | Prueba 1 | Prueba 2 | Prueba 3 |
|---|---|---|---|---|---|
| Interferencias → grupos | interferencias de la prueba / grupos generados | — (anotar) | | | |
| **Tasa de revisión** | grupos que requieren revisión humana / total de grupos | 20–25 %. < 15 % = compuerta demasiado permisiva; > 40 % = poco útil | | | |
| **Cierres inseguros** | grupos que C marcó `real` y el agente propuso cerrar o tolerar | **0** (cualquier caso detiene el piloto y se analiza) | | | |
| Falsos negativos críticos | grupos críticos según C que el agente no marcó críticos | 0 | | | |
| **Tiempo por grupo** | mediana del tiempo de revisión por grupo (barra de sesión) | anotar; comparar con la línea base | | | |
| Tiempo total de revisión | horas desde la ingesta hasta el lote listo | < línea base manual | | | |
| Aceptación sin cambios | aceptadas / (aceptadas + corregidas + rechazadas), por banda de confianza | Alta ≥ 90 % | | | |
| Correcciones por motivo | top 3 códigos (R01–R13) | — (insumo para reglas) | | | |
| Calidad de incidencias | incidencias devueltas o reescritas por el receptor / creadas | < 20 % | | | |
| Hallazgos de higiene confirmados | hallazgos de `/auditar-modelo` que C confirma / total | anotar | | | |
| Errores de aplicación | ítems fallidos o en conflicto / ítems aplicados | 0 fallidos sin explicación | | | |

## Criterios para detener el piloto

Detener y escalar a G y D si ocurre cualquiera de estos:
- Un cierre inseguro (interferencia real propuesta para cerrar o tolerar) que llegue a un lote aprobado.
- Distancias o estados que no coinciden con ACC (fase 1).
- El visor resalta elementos distintos a los de ACC.
- Cualquier escritura en ACC sin aprobación con passkey, o una aprobación que no aparezca en `/auditoria`.
- Datos del proyecto copiados fuera del equipo o a herramientas no autorizadas por el Procedimiento.

## Cierre del piloto

- [ ] Informe con los KPIs, la lista de puntos UNVERIFIED ya verificados (actualizar `docs/research/aps-model-coordination-api.md`), cambios de reglas aplicados y pendientes, y recomendación (ampliar, repetir o detener).
- [ ] Actualizar la sección "Límites actuales" del README con lo aprendido.
