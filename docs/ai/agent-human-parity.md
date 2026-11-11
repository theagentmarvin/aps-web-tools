# Paridad híbrida agente ↔ humano

Responsable: especialista IA. Fecha: 2026-11-10. Estado: auditoría; WS-E implementó P0, P1, `propose_family_exception` y la lista de lectura del Chat (filas marcadas «WS-E»).

**Objetivo.** La app tiene que ser híbrida: lo que el coordinador puede hacer en la UI web, el agente
(Claude Code con el harness, y el agente de chat `coordinador-chat` dentro de la app) también puede hacerlo,
y viceversa. La diferencia está en quién decide: **el agente propone y el humano aprueba en la UI**.
Las asimetrías válidas son solo las que exige una regla dura (`CLAUDE.md`, `docs/ai/harness-design.md` §4 y §8).

**Fuentes revisadas** (el código manda sobre este documento):
- Superficie humana:
  - `server/api/router.ts` (todas las rutas `add(...)`);
  - `src/lib/api/http.ts` y `src/lib/api/coordinator-api.ts` (qué rutas llama de verdad la UI);
  - `src/router.tsx`, `src/routes/*`, `src/features/**`;
  - `src/features/triage/useTriageHotkeys.ts` y `actions.ts`.
- Superficie del agente:
  - `server/mcp/contracts.ts` (`TOOLS`, 37 herramientas al auditar; 43 tras WS-E) y `server/mcp/server.ts`, que registra exactamente `TOOLS`;
  - `.claude/agents/*`, `.claude/skills/*` y `.claude/settings.json` (instalados);
  - `harness-staging/.claude/{agents,skills,settings.json}` (en staging);
  - `server/chat/bridge.ts` (`CHAT_DISALLOWED`, `--allowedTools`) y `server/chat/agent.ts`. El chat usa la copia instalada de `coordinador-chat.md` si existe; si no, la de staging. Hoy solo existe la de staging.

## 1. Quién tiene cada herramienta

Abreviaturas que usa la matriz:

| Sigla | Agente | Herramientas `mcp__coord__*` |
|---|---|---|
| **CC** | Agente principal de Claude Code | Todas. `get_*`/`list_*`/`propose_*` y otras están en `allow`; `apply_approved_proposals` está en `ask` y además pasa por el hook `guard-apply`. `ask_coordinator` está en `allow` solo en la versión de staging. |
| **T** | `clash-triager` | Instalado: grupos, clashes, propiedades, `propose_classification`/`group_action`/`status_change`, `withdraw`. Staging agrega `get_family`, `list_questions`, `propose_family_decision` y `ask_coordinator`. |
| **IW** | `issue-writer` | `get_group`, `get_element_properties`, `list_proposals`, `draft_issue`, `withdraw_proposal` |
| **HA** | `model-hygiene-auditor` | Solo lectura: sesión, higiene, `summarize`, grupos, propiedades |
| **RC** | `rules-curator` | `list_feedback`, `get_group`, `evaluate_ruleset`, `propose_rule_change`, Read/Grep/Glob. Staging (WS-R) agrega `get_rule_insights` y la propuesta estructurada (nueva · calibración · condiciones · retiro · restauración) |
| **Chat** | `coordinador-chat` (staging) | Lectura de grupos, familias, clashes, propiedades, selección, propuestas, preguntas y `list_issue_checks`. Propone familias, clasificación, acciones de grupo, cambios de estado e incidencias. También tiene `withdraw`, `ask_coordinator` y `record_feedback`. WS-E agregó sesión, diff, higiene, `list_meeting_notes`, `list_disciplines`, `list_batches`, `get_batch`, `list_decisions`, `get_agenda`, `list_reminders` y `propose_family_exception`; WS-R agregó `get_rule_insights` (lista `CHAT_READ_TOOLS` en `server/chat/bridge.ts`); luego `propose_rule_change` y `list_feedback`. WS-N agregó `get_next_steps`, `start_flow`, `get_flow_status` (solo en modo chat), `propose_discipline_mapping` y `generate_report`. **No tiene** `Read`. **Tiene bloqueados** apply, ingest, `run_classification` y `evaluate_ruleset`. |
| **Flujos** | `coordinador-flujos` (WS-N; solo la copia **instalada**) | Lanzado por el servidor para UN flujo del catálogo (`server/flows/catalog.ts`): las herramientas de su skill y de sus subagentes (T, IW, HA, RC), `Agent`, `Read`/`Grep`/`Glob`. **Nunca**: apply, `start_flow`/`get_flow_status` (sin recursión), Bash, PowerShell, Edit, Write, MultiEdit, NotebookEdit, WebFetch, WebSearch, Skill. MCP en modo `COORD_FLOW=1` (sin apply ni herramientas de flujo). |

Skills: en `.claude/skills/` están instalados `coordinar-test`, `triage`, `redactar-issues`, `informe-semanal`, `auditar-modelo` (fork a HA) y `curar-reglas` (fork a RC, solo humano). En `harness-staging/` están `preparar-ciclo`, `acta` y `coordinar-test` como alias.

## 2. Matriz de capacidades

Estados posibles: **parity** · **agent-missing** · **human-missing** · **intentional** (asimetría intencional, con la regla que la justifica) · **en curso (WS-x)**.

### A. Sesión y descubrimiento
| # | Capacidad | Humano (ruta + UI) | Agente (herramienta · quién) | Estado |
|---|---|---|---|---|
| 1 | Iniciar o cerrar sesión APS | `POST /auth/login`, `/auth/logout` · `AuthGate` | `get_session_status` muestra el estado y `loginUrl` · CC, HA, RC | intentional: credenciales humanas (CLAUDE.md, procedimiento paso 1) |
| 2 | Estado de sesión | `GET /auth/status`, `/session`, `/me`, `/agent/status` | `get_session_status` · CC, HA, RC, Chat (WS-E) | parity |
| 3 | Explorar hubs, proyectos, conjuntos de modelos, versiones, tests y vistas | `GET /hubs`, `/projects[/:id]`, `…/model-sets`, `…/tests`, `…/views` · `projects.tsx`, `project.tsx` | `list_projects`, `list_model_sets`, `list_model_set_versions`, `list_clash_tests` · CC | parity |
| 4 | Fijar el contexto activo | URL de la ruta | `set_active_context` · CC | parity |
| 5 | Inicio: cola, lotes, actividad, KPIs | `GET /home` existe, pero `/inicio` redirige a proyectos (sin página) | `get_session_status.pending` (solo conteos) | intentional (WS-F): la página Inicio se quitó a propósito para simplificar la navegación; la cola vive en Proyectos y Aprobaciones |

### B. Ingesta y motor
| # | Capacidad | Humano | Agente | Estado |
|---|---|---|---|---|
| 6 | Ingestar un test | `POST …/tests/:accTestId/ingest`, `GET /ingest-jobs/:id` · botones «Analizar»/«Actualizar» en `TestChecks` | `ingest_clash_test` · CC (bloqueado en Chat) | parity |
| 7 | Clasificar (motor) | `ingest` con `classify:true` | `run_classification` (también hace dry-run con `rulesetRef`) · CC | parity |
| 8 | Matriz documento × documento | `GET …/clash-grid` · `ClashGridView` | `summarize_clashes` con `documentPair`/`disciplinePair` · CC, T, HA, Chat | parity |
| 9 | Diferencias entre versiones | Delta en las tarjetas de test, filtro `delta`, `GET /triage/…/changes` | `diff_test_versions` · CC, Chat (WS-E) | parity |
| 10 | Higiene de modelos (H1–H10) | `GET /tests/:id/hygiene` · pestaña «Higiene» del conjunto de modelos en `project.tsx` (`HygienePanel`) | `get_model_hygiene_stats` · CC, HA | parity (WS-F) |

### C. Revisión de grupos (triage)
| # | Capacidad | Humano | Agente | Estado |
|---|---|---|---|---|
| 11 | Listar y filtrar grupos | `GET /triage/:p/:ms`, `/tests/:id/groups` · `GroupList`, `FilterBar` | `list_groups` · todos | parity |
| 12 | Detalle de grupo, clashes y propiedades | `GET …/groups/:id`, `…/clashes`, `POST …/elements/properties` · `DetailPanel` | `get_group`, `list_clashes`, `get_element_properties` · CC, T, IW, HA, Chat | parity |
| 13 | Selección en el visor | Visor Forge | `get_selection_context` · Chat | parity |
| 14 | Aceptar una propuesta (`a`, `A` masivo) | `POST /triage/decisions` con `accept` | No tiene | intentional: el humano decide (reglas 1 y 4) |
| 15 | Corregir validez, prioridad o responsable (`v`, `1`–`4`, `e`) | `decisions` con `correct` | `propose_classification`, `propose_group_action` (`set_priority`, `assign_responsible`) · CC, T, Chat | parity |
| 16 | Rechazar (`x`, `X`) | `decisions` con `reject` | `withdraw_proposal`, solo sobre propuestas propias | intentional: rechazar es una decisión humana |
| 17 | Posponer (`s`) | `decisions` con `postpone` | `needs_info`/`request_info`; opción `postpone` en `ask_coordinator` | parity |
| 18 | Nota sobre un grupo (`n`) | `decisions` con `note` | Campo `rationale` de cada propuesta | parity |
| 19 | Borrador de incidencia (`i`) | Editor de incidencia en el detalle | `draft_issue` · CC (vía IW), Chat | parity |
| 20 | Fusionar, dividir o mover clashes | `actions.merge`/`split` (corrección del campo `group`) | `propose_group_action` con `merge`/`split`/`move_clashes` · CC, T, Chat | parity |
| 21 | Deshacer o rehacer (`u`, `Ctrl+z`) | `decisions` con `undo` | `withdraw_proposal` | intentional: el historial de decisiones es humano |
| 22 | Cerrar como no problema o marcar revisado | Acción de cierre en la decisión | `propose_status_change`; el servidor lo rechaza para `real`/`needs_info` · CC, T, Chat | parity |
| 23 | Reabrir un grupo cerrado en ACC | Sin acción en la UI. Solo aparece en el lote si el agente lo propuso | `propose_status_change` con `reopen` | **human-missing** |
| 24 | Historial de decisiones humanas | `GET /decisions` · `DetailPanel` | `list_decisions` (sin nombres; nota `untrusted`) · CC, Chat | parity (WS-E) |
| 25 | Confirmar decisiones heredadas en bloque | `GET`/`POST /tests/:id/inherited-confirmations` · «⋯» › «Confirmar heredadas sin cambio (N)» (lista por motivo, acuse aparte para pasadas en estructura y seguridad de personas, conteo escrito; validado en el servidor) | `propose_group_action` `{type: "confirm_inherited"}`; `get_group.previousDecision.confirmReasons` · CC, Chat | parity (WS-C): el agente propone, el humano confirma |
| 26 | Cambios recientes de propuestas | `GET /triage/…/changes` (sondeo cada 10 s, tecla `R`) | `list_proposals` | parity |

### D. Familias de solución
| # | Capacidad | Humano | Agente | Estado |
|---|---|---|---|---|
| 27 | Ver familias y su detalle | `GET /tests/:id/families[/:fid]` · `FamilyPanel`, `FamilyRows` | `list_families`, `get_family` · CC (`preparar-ciclo`), T (staging), Chat | parity |
| 28 | Decidir una familia | `POST /families/:id/decision` con `proposalId` · `FamilyPanel` | `propose_family_decision` · CC (`acta`), T (staging), Chat | parity: el agente propone, el humano aprueba con muestreo |
| 29 | Vista previa del efecto de una decisión | `POST /families/:id/decision-preview` | `get_family` da la mezcla de validez, pero no la vista previa | **agent-missing** (bajo) |
| 30 | Excepción de instancia (con motivo) o su retiro | `POST`/`DELETE /families/:id/exceptions` · `FamilyDialogs` | `propose_family_exception` (el servidor rechaza cerrar `real`/`needs_info`); el humano la acepta en Familia › ubicaciones (`POST /families/:id/exceptions` + `proposalId`) · CC, Chat | parity (WS-E; falta en T) |
| 31 | Separar una instancia (detach) | `POST /families/:id/detach` · menú «⋯» del panel de familia › «Separar una ubicación…», con confirmación (`FamilyMoreMenu`) | `propose_group_action` con `move_groups`/`detach_clashes` | parity (WS-F) |
| 32 | Fusionar familias | `POST /families/merge` · menú «⋯» del panel de familia › «Fusionar con otra familia…», con confirmación. Una familia separada puede volver a fusionarse (alias resuelto en `familyViews`) | `propose_group_action` con `merge_families`/`split_family` | parity (WS-F) |
| 33 | Aplicar o rechazar una reagrupación propuesta | `POST /proposals/:id/regroup` `{testId, decision}` (bug de `http.ts` corregido; test de contrato `tests/server/api-route-contract.test.ts`) | Crea la propuesta | parity (WS-E) |
| 34 | Contar las decisiones de familia en los lotes | Barra del espacio de trabajo (`progress.ts`: listas = decisiones de grupo sin lote + familias con `pendingSend` > 0; hechas incluye instancias heredadas), pie «N decisiones», página de proyecto | `TriageFamily.pendingSend` en `families`/triage; el lote ya incluía las familias | parity |
| 35 | Plantilla de incidencia por familia, tipo de incidencia, enlaces profundos a ACC | Plantilla PROBLEMA/UBICACIÓN/ACCIÓN en incidencias de grupo; tipo por proyecto (Disciplinas › Incidencias ACC) o al aprobar; «Abrir en ACC» enlazado | `draft_issue` sigue la misma guía; `get_issue_settings` lee el tipo | parity (WS-B) |
| 36 | Familias más gruesas y etiquetas de par | Firma v7 (27 grupos en vez de 83 en fixtures); par por disciplina del sistema; decisiones antiguas «por revisar» | `get_family.legacyDecisions`; mismas familias vía `list_families` | parity (WS-C) |

### E. Reunión (M4)
| # | Capacidad | Humano | Agente | Estado |
|---|---|---|---|---|
| 37 | Agenda de la reunión por disciplina | `GET /tests/:id/agenda` · `MeetingViews`, lente Reunión | `get_agenda` (tabla del servidor, títulos `untrusted`) · CC, Chat | parity (WS-E) |
| 38 | Leer las notas de reunión | `GET /tests/:id/notes` | `list_meeting_notes` · CC (`/acta`), Chat (WS-E) | parity |
| 39 | Escribir notas de reunión | `PUT /tests/:id/notes/:type/:id` | No tiene | intentional: la nota es el registro humano que `/acta` lee como dato no confiable (F4) |
| 40 | Vista guardada (cámara) de una familia | `GET`/`PUT …/families/:id/view` | No tiene; no hay visor | **agent-missing** (bajo; basta con poder leer si existe) |

### F. Seguimiento de incidencias (M3)
| # | Capacidad | Humano | Agente | Estado |
|---|---|---|---|---|
| 41 | Veredictos de verificación de incidencias | `GET /tests/:id/issue-checks` · `IssueViews` | `list_issue_checks`, que incluye la columna `decision` · CC (`preparar-ciclo`), Chat | parity |
| 42 | Aceptar o rechazar un veredicto (`a` en la lente Incidencias) | `POST …/issue-checks/:id/decision` | No tiene | intentional: es la evidencia humana del gate M5; no existe `propose_issue_update` (core-features §2 y §6) |
| 43 | Recordatorios por disciplina | `GET /tests/:id/reminders` · `triage.tsx` | `list_reminders` (plantilla y conteos del servidor; líneas `untrusted`) · CC, Chat | parity (WS-E) |
| 44 | Gate M5 de evidencia | `GET /issue-checks/gate` existe, sin llamador en la UI | No tiene | **human-missing** (al agente también le falta) |

### G. Preguntas (X3)
| # | Capacidad | Humano | Agente | Estado |
|---|---|---|---|---|
| 45 | Preguntar al coordinador | — | `ask_coordinator` · CC, T (staging), Chat | intentional: canal del agente al humano |
| 46 | Responder una pregunta | `POST /questions/:id/answer` · `DetailPanel`, `LensBar` | No tiene | intentional: responder es humano |
| 47 | Ver preguntas y respuestas | `GET /tests/:id/questions` y el payload de triage | `list_questions` · CC, T (staging), Chat | parity |

### H. Disciplinas
| # | Capacidad | Humano | Agente | Estado |
|---|---|---|---|---|
| 48 | Ver códigos, mapeos y resolución por documento | `GET /projects/:id/disciplines` · `DisciplinesPanel` | `list_disciplines` · CC, Chat (WS-E) | parity |
| 49 | Asignar la disciplina de un documento (y regla opcional) | `PUT …/documents/:lineageKey/discipline` · `DisciplineDialog` | `propose_discipline_mapping` · CC (bloqueado en Chat) | parity |
| 50 | Editar, reordenar o borrar reglas de nombre, y previsualizarlas | `PUT /projects/:id/disciplines/rules`, `POST …/preview` | Solo propone una regla nueva; no puede proponer reordenar ni borrar | **agent-missing** (bajo) |
| 51 | Decidir una sugerencia de disciplina | `POST …/disciplines/proposals/:id/decision` | No tiene | intentional: el humano confirma los mapeos |
| 52 | Mapeo disciplina → asignatario de ACC (empresa / rol / usuario) y tipo de incidencia del proyecto | `GET/PUT /projects/:id/issue-settings…`, `GET …/issue-types` · `IssueSettingsPanel` (Disciplinas); en el lote, confirmar o cambiar por incidencia | `get_issue_settings` (usuarios enmascarados) + `propose_issue_responsible`; el humano acepta en la UI. No hay propuesta de tipo de incidencia | parity (WS-B; tipo: agent-missing, bajo) |

### I. Lotes y aplicación en ACC
| # | Capacidad | Humano | Agente | Estado |
|---|---|---|---|---|
| 53 | Enviar a aprobación (lote `ready`) | `POST /batches` · triage | Las propuestas caen solas en el lote borrador | intentional: el humano arma el lote |
| 54 | Ver lotes, su detalle y el estado de aplicación | `GET /batches`, `/batches/:id`, `…/apply-status` · `approvals.tsx`, `batch.tsx` | `list_batches`, `get_batch` (estado, ítems por operación, último preflight, validez de la aprobación, `stale`; sin firmas, nonces ni nombres) · CC, Chat; nunca subagentes | parity (WS-E) |
| 55 | Preflight contra ACC, lote obsoleto y re-base | `POST /batches/:id/preflight`; `POST /batches/:id/rebase` «Llevar decisiones a vN» (lote nuevo `ready` sin aprobar; el viejo queda `discarded` con `supersededBy`). Sin «Aplicar igualmente» | `get_session_status.pending.staleBatches` (lote, versión, `canRebase`, pista hacia `/aprobaciones/L-…`); solo apply con dry-run | intentional: el re-base arma un lote y eso es humano (regla 1); el agente lo ve y lo señala |
| 56 | Excluir ítems o editar la incidencia de un ítem | `PATCH /batches/:id/items[/:itemId/issue]` · `BatchDiffTable` | Retirar y volver a redactar (`withdraw` + `draft_issue`) antes de que el lote pase a `ready` | intentional: curar el lote es humano (tipo y asignatario: WS-B) |
| 57 | Devolver o descartar un lote | `POST …/return`, `…/discard` | No tiene | intentional (regla 1) |
| 58 | Aprobar con WebAuthn; registrar passkey | `POST …/approve`, `/webauthn/*` · `batch.tsx`, `passkey.tsx` | No tiene | intentional (regla 1; harness-design §8) |
| 59 | Aplicar un lote aprobado en ACC | `POST /batches/:id/apply` (dry-run por defecto) | `apply_approved_proposals` · solo CC, primero con dry-run, con `ask` y `guard-apply` | parity (con resguardos) |

### J. Aprendizaje y reglas
| # | Capacidad | Humano | Agente | Estado |
|---|---|---|---|---|
| 60 | Registrar una corrección o feedback | `POST /feedback`; decisión `correct` con `suggestRule` | `record_feedback` · CC, Chat | parity |
| 61 | Ver correcciones | `GET /learning/corrections` · `rules.tsx` | `list_feedback` · CC, RC (incluye las correcciones hechas en la UI) | parity |
| 62 | Ver el feedback que registró el agente (`record_feedback` desde el chat o CC) | `GET /learning/feedback?source=` · Reglas › pestaña «Feedback» con columna Origen (UI / Agente / UI (decisión)), sin nombres | `list_feedback` | parity (WS-F) |
| 63 | Calibración de confianza por banda | `GET /learning/calibration` · Reglas › Historial › Calibración, `detail-accordion` | No tiene | **agent-missing** (bajo) |
| 64 | Catálogo de reglas | Reglas › Reglas: activas agrupadas por par de disciplinas (nombre, resultado, «En este proyecto: N interferencias · M ubicaciones» → Coordinación filtrada `?regla=`, «Acierto» con n), Biblioteca de retiradas, alertas automáticas (solo lectura). `GET /rules/overview`, `/rules/:id` | `Read rules/` · CC, RC; `get_rule_insights` · CC, RC, Chat | parity (WS-R) |
| 65 | Descubrir reglas nuevas | No (por diseño) | `get_rule_insights` (DEF-999 / falta información por par, reglas corregidas, sin uso, reactivables) + `propose_rule_change` `changeKind: new` · RC (`/curar-reglas`), `/preparar-ciclo` paso 7 | intentional (WS-R): el agente descubre y propone; el servidor fija la precedencia (fin de su sección, antes de DEF-999) |
| 65b | Calibrar, editar condiciones, retirar y restaurar una regla | Reglas › «Calibrar» (validez, responsable, severidad, acción, umbrales mm) y «⋯» «Editar condiciones» (formulario guiado o YAML avanzado; mantiene la posición) / «Retirar» → Biblioteca / «Restaurar». «Ver impacto» antes de enviar (`POST /rule-suggestions/preview`: interferencias, ubicaciones, reglas que la tapan o que tapa, seguridad). `POST /rule-suggestions` crea la sugerencia con origen «Coordinador» | `propose_rule_change` estructurado (`calibrate`, `edit`, `retire` en lote, `restore`) o patch · RC | parity (WS-R): misma sugerencia y mismo flujo; el servidor rechaza cerrar estructura o seguridad de las personas sin revisión humana |
| 66 | Evaluar el ruleset y su impacto en datos reales | «Ver impacto» en cada cambio y efecto en lenguaje simple en cada sugerencia; «Publicar» re-ejecuta `evaluate_ruleset`. Evaluar libremente sigue en `npm run eval` | `evaluate_ruleset`, `run_classification` con dry-run y `rulesetRef`; impacto en la respuesta de `propose_rule_change` estructurado | parity (WS-R) |
| 67 | Aprobar, rechazar, publicar y revertir una sugerencia de regla | `POST /rule-suggestions/:id/decision` (propuesta → aprobada · pendiente de publicar); `POST …/publish` y `…/revert` con passkey (re-evaluación sin regresiones —un retiro pasa solo si todo escenario afectado cae en DEF-999—, respaldo, auditoría `rule.published` / `rule.reverted`). El coordinador puede aprobar su propia sugerencia; publicar siempre pide passkey | `list_proposals` con `kind: rule_change`: la columna summary empieza con la etapa (`[aprobada · pendiente de publicar]`, `[publicada]`, `[revertida]`) | intentional (G15): el agente lee la etapa; nunca aprueba, publica ni revierte (no hay herramienta MCP; rutas solo humanas con CSRF + passkey) |

### K. Informes, notas de proyecto, auditoría y chat
| # | Capacidad | Humano | Agente | Estado |
|---|---|---|---|---|
| 68 | Informes (semanal, resumen, higiene, digest) | Menú «Informe del ciclo» en la cabecera del conjunto (`project.tsx`): HTML para imprimir y `.md` desde `GET /reports`, más los archivos del agente (`GET /reports/files`, `/reports/files/:name`; HTML en iframe sin scripts) | `generate_report` (archivo en `.coordinator/reports/`) · CC | parity (WS-F). La página `/reportes` sigue quitada a propósito |
| 69 | Auditoría | `GET /audit` existe, pero `/auditoria/*` redirige | No tiene (el hook escribe el log y `.coordinator` está denegado) | intentional (WS-F): la página Auditoría se quitó a propósito; el log sigue en el servidor |
| 70 | Leer las notas de proyecto (convenciones) | `GET /projects/:id/notes` · sección plegable «Convenciones del proyecto» en `project.tsx` (`ProjectNotesPanel`) | `get_session_status.projectNotes` + `Read notes.md` · CC (Chat no) | parity (WS-F) |
| 71 | Escribir notas de proyecto | `POST /projects/:id/notes` · «Agregar convención» con vista previa y casilla de confirmación; solo agrega líneas (fechadas, «confirmado por coordinador», sin nombre) | `Edit notes.md`, solo tras confirmación · CC | parity (WS-F) |
| 72 | Asignatarios de ACC (personas) | `GET /projects/:id/assignees` · editor del lote | No tiene | intentional (regla 7: sin datos personales) |
| 73 | Conversar con el agente | `POST /chat/messages`, SSE, `history`, `status` · `ChatPanel` | — | intentional: canal del humano al agente |
| 74 | Cancelar el turno del chat | `POST /chat/:id/cancel` (bug de `http.ts` corregido en WS-E) | — | intentional: canal del humano |
| 75 | Tarjetas de propuesta en el chat | Tarjeta con acción, validez y destino seleccionable; preguntas respondibles en la tarjeta | Las tarjetas salen de datos del servidor, nunca del texto del modelo | parity (WS-D) |
| 76 | Actualizar el agente (instalar `harness-staging/` en `.claude/` + `CLAUDE.md`) | `GET /harness/status` (aviso «Hay una actualización del agente (N archivos)» en el shell); `GET /harness/diff?path=` y `GET /harness/install-options` (CSRF); `POST /harness/install` con CSRF + mismo origen + `Sec-Fetch-Site: same-origin` + passkey fresca sobre los hashes exactos de los archivos; prueba los hooks nuevos, respalda en `backups/harness-<fecha>/`, verifica y audita `harness.installed`. Se rechaza si el servidor lo inició un agente (`CLAUDECODE`). Alternativa: `npm run setup` (TTY, fuera de Claude Code). Lanzador `Coordinador BIM.cmd` | No tiene: ninguna herramienta MCP ni del chat llega a estas rutas (test `tests/server/harness-install.test.ts`) | intentional (WS-L; regla 8 y harness-design: el agente nunca modifica su propio harness; solo humano) |
| 77 | Saber qué sigue en el ciclo | `GET /next-steps?projectId&testKey` · tarjeta «Qué sigue» en `project.tsx` y en el panel «Flujos» del shell (incluye «Actualizar el agente» cuando falta) | `get_next_steps` (lectura, mismas cifras; sin el paso de actualización del agente) · CC, Chat, Flujos | parity (WS-N) |
| 78 | Ejecutar un flujo de dominio (preparar-ciclo, triage, acta, redactar-issues, informe-semanal, auditar-modelo, curar-reglas) | `POST /flows/:flowId/run` (CSRF + mismo origen) tras un diálogo de confirmación (qué hace, qué deja, alcance, tope USD) | `start_flow` · **solo Chat**, con acuerdo del coordinador; catálogo cerrado, uno por proyecto, tope diario (`flows.dailyAgentCap`, 10). CC usa las skills (`/triage`, …). Subagentes y el agente de flujos **no** tienen `start_flow` | parity (WS-N); intentional para subagentes y flujos (sin recursión) |
| 79 | Seguir / cancelar un flujo | `GET /flows/runs`, `GET /flows/runs/:id`, SSE `GET /flows/runs/:id/events`, `POST /flows/runs/:id/cancel` (CSRF) · panel «Flujos» y tarjeta «Flujo» del chat | `get_flow_status` (lectura) · Chat. Cancelar es humano | intentional (cancelar: canal del humano) |
| 80 | Lo que produce un flujo | Las mismas tarjetas, preguntas, borradores, sugerencias de reglas e informes de siempre; se deciden en la UI | Solo propuestas, preguntas e informes (`coordinador-flujos`); nunca apply, aprobar, publicar ni instalar | intentional (reglas 1, 4, 8) |

### Conteo

| Estado | Filas |
|---|---|
| parity | 49 |
| intentional | 24 |
| human-missing | 3 (#23, #44, #66) |
| agent-missing | 4 (#29, #40, #50, #63) |
| en curso | 0 |
| **Total** | **80** |

Recuento tras integrar WS-A…F (2026-11-10); #76 agregado en WS-L (2026-11-11); #77–#80 en WS-N (2026-11-11, `docs/domain/next-steps-and-flows.md`).

## 3. Hallazgos que no son de herramientas

1. **Dos bugs de contrato entre la UI y el servidor** (#33 y #74) que rompen la paridad en modo live.
   - El humano no puede aplicar las reagrupaciones que propone el agente. Esto deja inútil `propose_group_action` con `move_groups`, `merge_families`, etc., que `core-features-agent-analysis.md` §6 daba como sustituto de los gestos de fusionar y separar.
   - Tampoco puede cancelar un turno del chat.
   - En modo mock funcionan, por eso no se ven en desarrollo.
2. **Lo instalado y lo de staging no coinciden.**
   - `coordinador-chat`, `preparar-ciclo`, `acta`, el triager con familias y el `allow` de `ask_coordinator` existen solo en `harness-staging/`.
   - Hasta que un humano ejecute `npm run coordinator -- setup`, el CC instalado pide confirmación en `ask_coordinator` y el triager instalado no ve familias.
3. **El agente de chat tiene una lista de lectura estrecha** para su papel en la reunión.
   - No tiene `list_meeting_notes`, `diff_test_versions`, `list_disciplines`, `get_model_hygiene_stats` ni `get_session_status`.
   - Son herramientas de solo lectura y su riesgo es bajo.
4. **Hay rutas del servidor sin UI:**
   - `/home`, `/reports`, `/audit`;
   - `/projects/:id/notes` (GET y POST);
   - `/families/merge`, `/families/:id/detach`, `/families/:id/confirm-inherited` (esta última en WS-C);
   - `/issue-checks/gate`.

   La paridad humana se consigue en buena parte con páginas sobre rutas que ya existen, sin backend nuevo.

## 4. Adiciones mínimas para llegar a paridad (por valor para el ciclo semanal)

Reglas comunes a todo lo que se agregue:
- Las lecturas van como `list_*`/`get_*` con `RO_LOCAL` y `minLevel 0`, así quedan permitidas por los comodines de `settings.json` y no hace falta tocar `.claude/`.
- Toda escritura del agente es un `propose_*` con `LOCAL_WRITE` y `minLevel 1`, que cae en el lote borrador. La aplica un humano en la UI.
- Ninguna lectura devuelve firmas, nonces, tokens, correos ni nombres de personas. Usa roles, disciplinas o `actor.type`.
- El texto humano (notas, respuestas, comentarios) se devuelve como `untrusted`.
- Los subagentes no reciben herramientas de lote.

| Prio | Adición | Superficie | Entrada y salida | Resguardos |
|---|---|---|---|---|
| **P0** | Corregir los bugs #33 y #74 | UI (`src/lib/api/http.ts`) | `applyRegroup(proposalId, testId, decision)` → `POST /proposals/:id/regroup` `{testId, decision:"apply"\|"reject"}`. `cancelChat(messageId)` → `POST /chat/:id/cancel` | Sin cambios de seguridad. Agregar un test de contrato entre las rutas de `http.ts` y las de `router.ts` para que la deriva no vuelva |
| **P1** | `list_batches` + `get_batch` | MCP, lectura | `list_batches {projectId?, state?: ("draft"\|"ready"\|"approved"\|"applied"\|"partial"\|"discarded")[], limit≤25, cursor?}` → tabla `batchId, testKey, state, items, byOp{assign,close,reopen}, excluded, approvedAt?, stale?` (el campo `stale` viene de WS-A). `get_batch {batchId}` → ítems resumidos (`proposalId`, `op`, `groupId`, clashes, excluido), último preflight (conteos, sin cuerpos) y `apply-status` | Envuelve `ui.listBatches`/`getBatch`/`applyStatus`. Sin datos de aprobación (firma, credencial, nonce). Para CC y Chat; nunca para subagentes. Permite que el procedimiento paso 1 («menciona lotes aprobados sin aplicar») y el dry-run usen el `batchId` correcto |
| **P1** | `list_decisions` | MCP, lectura | `{testKey?, projectId?, since?, kind?: ("accept"\|"correct"\|"reject"\|"postpone"\|"note"\|"undo")[], targetType?, limit≤50, cursor?}` → tabla `decisionId, at, kind, targetType, targetId, fields[], reasonCode, bulkSize, undone`; la nota va como `untrusted` | Envuelve `ui.listDecisions`. **Sin `userName`/`userId`** (regla 7). Base de «decisiones de la semana» en `/informe-semanal` y de lo ya decidido en `/acta` y `/preparar-ciclo`. Para CC, Chat y T |
| **P1** | `get_agenda` + `list_reminders` | MCP, lectura | `get_agenda {testKey?, cap?≤200}` → la misma tabla que `coord.agendaFor`. `list_reminders {testKey?, discipline?[]}` → `discipline, issueIds[], counts, text` (plantilla del servidor) | Los números y el orden los pone el servidor; el agente solo narra. Es la alternativa de solo lectura a `generate_report` con `kind: agenda\|reminders` (§2 de core-features), apta para el Chat, que tiene `generate_report` bloqueado. Los títulos de ACC van como `untrusted` |
| **P2** | Página **Reportes** y panel **Higiene** | UI y rutas | Página `/reportes` sobre el `GET /reports` existente. Ruta nueva `GET /reports/files?projectId=` que lista los archivos de `generate_report` (nombre, tipo, fecha, `headline`) y `GET /reports/files/:name`. Ruta nueva `GET /tests/:testId/hygiene` que envuelve `getModelHygieneStats`, más un panel en la pestaña «Pruebas» | Solo lectura. Servir solo archivos bajo `.coordinator/reports/<projectId>/` con un nombre validado (sin `..`). Cierra #10 y #68, y deja ver al humano lo mismo que redacta el agente |
| **P2** | `propose_family_exception` | MCP, propuesta | `{testKey?, familyId, groupId, fields: {validity?, action?, responsibleDiscipline?, secondaryDiscipline?, solutionOption?, issueMode?}, reason (1..300), rationale≤1500}` → `ProposalCreatedOutput` con el nuevo `kind: "family_exception"` | El servidor valida que `groupId` pertenezca a la familia. Rechaza `close`/`mark_reviewed` si la validez del grupo es `real`/`needs_info` (regla 3). La aplica el humano con el `POST /families/:id/exceptions` existente más `proposalId`. Para CC, T y Chat |
| **P2** | Ampliar la lista de lectura del Chat | `harness-staging/.claude/agents/coordinador-chat.md` (la edita un humano en modo dev y la instala con `setup`) | Agregar `list_meeting_notes`, `diff_test_versions`, `list_disciplines`, `get_model_hygiene_stats`, `get_session_status` y las nuevas `list_batches`, `get_batch`, `list_decisions`, `get_agenda`, `list_reminders` | Todas de solo lectura. Este documento no toca `.claude/`. Revisar el límite de tokens por turno del chat |
| **P2** | UI de **notas de proyecto** y de **feedback del agente** | UI y rutas | Panel en `project.tsx` o `/ajustes` sobre `GET`/`POST /projects/:id/notes` existentes. Ruta nueva `GET /learning/feedback?projectId=&source=` que envuelve `listFeedback` con `aggregate: none` y agrega una columna `source` (`ui`, `agent`), más una pestaña en Reglas › Correcciones | `appendNote` ya valida el texto y audita. Sin datos personales. Cierra #62, #70 y #71 |
| **P3** | Acciones directas sobre familias y reapertura en la UI | UI | Botones «Separar» y «Fusionar con…» sobre `POST /families/:id/detach` y `POST /families/merge`, ya existentes. Acción «Reabrir» que crea la decisión con `setStatus: reopen` (la ruta de decisiones o una variante de `/triage/decisions`) | La reapertura borra grupos cerrados en MC y es irreversible: requiere confirmación explícita y siempre va por lote aprobado. Cierra #23, #31 y #32 |
| **P3** | Página **Auditoría** y **gate M5** | UI | `/auditoria` sobre `GET /audit`, ya existente; tarjeta del gate en la lente Incidencias sobre `GET /issue-checks/gate`. Opcional: agregar `gate` a `list_issue_checks` | Solo lectura. La auditoría muestra el actor como lo guarda el log (es para rendición de cuentas). Al agente no se le da `list_audit`: `list_decisions` cubre lo que necesita |
| **P4** | Lecturas menores del agente | MCP, lectura | `preview_family_decision {testKey?, familyId, …DecisionFields}` (envuelve `familyDecisionPreview`); `get_calibration {}` (envuelve `ui.calibration`); `get_family` con `savedView: boolean` | Solo lectura. Cierra #29, #40 y #63 |
| **P4** | `propose_discipline_rules` | MCP, propuesta | `{projectId?, rules: RuleIn[] ≤200 (ordenadas), rationale}` → `kind: "discipline_mapping"` con `mode: "replace_rules"` | El humano la aplica con `PUT /projects/:id/disciplines/rules`, viendo antes el resultado de `preview`. Cierra #50 |

**No se agregan, con razón:**
- Herramientas para aprobar, firmar, devolver, descartar o excluir ítems de lotes (regla 1).
- Una herramienta para responder preguntas (es lo humano en X3).
- Herramientas para escribir notas de reunión o decidir veredictos M3 (registro y evidencia humanos; core-features §6).
- Leer asignatarios o personas (regla 7). WS-B resuelve el mapeo disciplina → asignatario como propuesta.
- Editar `rules/` (regla 8).

## 5. Orden sugerido

P0 (bugs) → P1 (lotes, decisiones, agenda y recordatorios: el ciclo D-1 → reunión → D+1 queda completo para el agente) → P2 (lo que el agente produce también lo ve el humano) → P3/P4.

Antes de mergear cambios a contratos MCP o agentes, correr E2/E3 (`harness-design.md` §7).
