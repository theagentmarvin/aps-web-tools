# Coordinator journey — one weekly cycle, end to end (2026-11)

Reviewer: senior BIM coordinator (SalfaCorp role-play). Date: 2026-11-10.
Method: a separate fixtures instance on :3019 with a temporary `COORDINATOR_HOME` (CLI `ingest --version 41` → `classify --propose` → UI work → `ingest --version 42` → `classify --propose` → UI work), driven in headless Chrome. I made 3 real chat messages (Agente tab and the same HTTP API, US$ 0.62 in total) and one demo approval, then looked at the dry run only. Nothing was applied. On the real project (T-3bde5861, v11) I only opened pages and made GET calls.
Screenshots are in the session scratchpad, `journey/shots/` (the file names are cited below; the full paths are listed at the end).

## (a) The flow today

Status: **ok** · **fricción** (works, but costs time or trust) · **bloqueo** (cannot be done as designed) · **falta** (does not exist).
Actors: COORD = coordinador · AG-CC = agent in Claude Code · AG-CHAT = agent in the Agente tab · MOTOR = engine/server · ACC · DISC = external discipline.

### Preparar (D-1)

| id | Step | Actor | Place | Input → output | Time | Status |
|---|---|---|---|---|---|---|
| S1 | A discipline publishes a model; ACC runs the clash test | DISC / ACC | ACC web | Revit models → new model set version (v42) | — | ok |
| S2 | Find out that a new version exists | COORD | ACC email, or opening the app | ? → "v42 · Sin descargar" in the version selector; the banner "Hay una versión más reciente (v42)" appears only inside coordinación | 5–15 min | **falta** |
| S3 | Prepare the cycle with `/preparar-ciclo` | AG-CC | Claude Code | v42 → ingest, classify, AI review of changes, questions, issue checks, 25-line summary | 10–20 min | **bloqueo**: the skill exists only in `harness-staging/`; `.claude/skills` still holds the old set and the README says `/coordinar-test` |
| S3b | Workaround: "Analizar" / `npm run coordinator -- ingest` + `classify --propose` | MOTOR | Proyecto page or CLI | v42 → classified test (5 s), with no AI review and no questions | 1 min | fricción (the button reads "Analizar v0", see `02-proyecto-grid-empty.png`) |
| S4 | **¿Primer ciclo / modelo nuevo?** Yes: assign disciplines | COORD | Proyecto › Matriz › "Asignar ahora" | 8 × "Sin asignar" → ARQ/EST/CLI… | 3–5 min (first time) | fricción |
| S5 | Open coordinación from the matrix | COORD | Matriz → "Abrir coordinación" | cell / pair → workspace | 1 min | ok |

### Revisar (D-1)

| id | Step | Actor | Place | Input → output | Time | Status |
|---|---|---|---|---|---|---|
| S6 | Read the toolbar status line: **¿cambio de alcance? ¿versión vieja?** | COORD | Workspace toolbar | scope / stale / agent chips → decision to continue or re-analyse | 2 min | fricción (two chips at once; "El agente está analizando…" stays after the agent has finished) |
| S7 | Qué cambió: inherited decisions — **¿heredada sin cambio?** | COORD | Lens Qué cambió, panel "Confirmar decisión heredada de v41" | 28 inherited, of which 17 need a one-by-one "Confirmar (A)" | 15–25 min | fricción |
| S8 | Review nuevo / cambió / reapareció by grupo | COORD | Grupos tree + Detalle panel | 40 grupos · 49 ubicaciones · 70 new clashes → decisions | 2–3 h | fricción (fine families) |
| S9 | **¿El agente pregunta?** Answer the "?" callout | COORD | Panel callout (structured options) | question → decision | 1 min each | ok (only when the agent ran) |
| S10 | **¿La agrupación es correcta?** No: mark an Excepción, or ask the chat to regroup | COORD + AG-CHAT | Panel "Excepción"; Agente tab with a viewer selection | selection → regroup proposal (P-…0006) | 5 min | fricción |
| S11 | Aprobar grupo (spot-check, then dialog) or decide per ubicación (A/E/X/S) | COORD | Panel + "Aprobar grupo" dialog | proposal → human decision (audited) | 1–3 min/grupo | ok |
| S12 | Ask the agent (explain, choose a solution, prepare for the meeting) | AG-CHAT | Agente tab | question + context → answer + proposal/question cards | 30–65 s, US$ 0.13–0.26 | fricción |

### Verificar (D-1)

| id | Step | Actor | Place | Input → output | Time | Status |
|---|---|---|---|---|---|---|
| S13 | Issue verdicts | MOTOR | Lens Incidencias | ACC issues × v42 → Resuelta / Avance / Sigue abierta / Cerrada en ACC, sigue en modelo / Se desplazó / Modelo sin actualizar | auto | ok |
| S14 | Accept or reject the verdict (V01–V05) | COORD | Panel "Verificación del 04-11-2026" | verdict → accepted / rejected with a code | 1 min/issue | ok |
| S15 | **¿Resuelta en ACC?** If resuelta: move the issue to "En revisión" by hand | COORD | ACC web | accepted verdict → ACC status | 15–20 min/cycle | **falta** (M5 deferred; "Abrir en ACC #103" is not a link) |
| S16 | Copy the reminder per discipline and send it | COORD | "Copiar recordatorio" → email / WhatsApp | template → message to the subcontractor | 10–15 min (editing) | fricción |

### Reunión (D, D+1)

| id | Step | Actor | Place | Input → output | Time | Status |
|---|---|---|---|---|---|---|
| S17 | Prepare and print the agenda | MOTOR + COORD | Lens Reunión → "Imprimir agenda" | engine table → printed agenda by discipline | 20–30 min (trimming by hand) | fricción |
| S18 | Run the meeting: notes per point, decide live in "Aprobar grupo" | COORD | Lens Reunión, panel "Nota de reunión" (N) | discussion → notes + decisions | 60–90 min | fricción |
| S19 | `/acta` the day after | AG-CC | Claude Code | notes → family-decision drafts with a quoted dueDate, or questions | 5 min | **bloqueo** (not installed, same as S3) |
| S20 | **¿Nota clara?** Approve the drafts / answer the questions | COORD | Workspace (Reunión lens) | drafts → decisions | 15 min | ok (by design; not run) |

### Aprobar / aplicar

| id | Step | Actor | Place | Input → output | Time | Status |
|---|---|---|---|---|---|---|
| S21 | Enviar a aprobación (Ctrl+Enter) | COORD | Workspace toolbar | decisions → batch L-… | 1 min | **bloqueo** if only "Aprobar grupo" decisions exist ("Enviar 0", disabled) |
| S22 | Review the batch: Comprobar con ACC, then the Cambios / Incidencias tabs | COORD | /aprobaciones/L-… | batch → checked batch | 15–30 min | fricción (issue texts) |
| S23 | **¿Base desactualizada?** Yes: the batch cannot be approved | COORD | Batch page | v41 batch while v42 exists → dead batch, re-analyse | — | **bloqueo** |
| S24 | Approve with a passkey (demo approval in fixtures) | COORD | Approval dialog + Windows Hello, typing APLICAR | batch → signed approval | 2 min | ok |
| S25 | Simulación (dry run): exact ACC request bodies | MOTOR | Batch page | approval → request bodies | 5 min reading | ok |
| S26 | Apply to ACC (UI "Aplicar en ACC…" or "aplica el lote" in Claude Code) | COORD / AG-CC | Batch page / Claude Code | dry run → ACC issues + status changes | 2 min | ok (not executed) |

### Seguimiento (D+1 → next drop)

| id | Step | Actor | Place | Input → output | Time | Status |
|---|---|---|---|---|---|---|
| S27 | Chase disciplines until they publish again | COORD + DISC | Email / WhatsApp / ACC | reminders → commitments, new models | 45–60 min/week | **falta** (no record of reminders sent, no per-company view) |
| S28 | Report to the BIM manager | AG-CC / COORD | `/informe-semanal` (html/md), by hand | cycle data → report | 30–45 min | fricción (Reportes page removed; no xlsx) |

### Aprender

| id | Step | Actor | Place | Input → output | Time | Status |
|---|---|---|---|---|---|---|
| S29 | Corrections with reason codes are recorded (`record_feedback` also from the chat) | MOTOR / AG-CHAT | Decisions, chat | correction → feedback | auto | ok |
| S30 | `/curar-reglas` → Reglas › Sugerencias → "Aprobar regla" | AG-CC + COORD | Claude Code, /reglas | feedback → rule proposal → approved flag | 15 min | fricción: approving only flags the proposal; a developer still merges the YAML in git |
| S31 | Project conventions in `notes.md` (after the coordinator confirms) | AG-CC | Claude Code | convention → notes line | 2 min | ok |

**Decision branches:** S2 «¿hay versión nueva?» (no → S27) · S4 «¿primer ciclo o modelo nuevo?» (no → S5) · S6 «¿cambio de alcance / versión vieja?» (stale → S3b) · S7 «¿heredada sin cambio?» (no → S8) · S9 «¿el agente pregunta?» · S10 «¿la agrupación es correcta?» (no → excepción or chat regroup) · S15 «¿resuelta en ACC?» (no → S16 reminder; yes → move in ACC) · S20 «¿nota clara?» (no → question) · S23 «¿base desactualizada?» (yes → S3b).

## (b) Gaps, ranked

| id | Sev. | Step | What goes wrong | Evidence | Fix | Target |
|---|---|---|---|---|---|---|
| G1 | alta | S3, S19 | The two-command loop of the plan (`/preparar-ciclo`, `/acta`) is not runnable: both skills are only in `harness-staging/.claude/skills`. `.claude/skills` has coordinar-test, triage, … The README and "Copiar comando" ("Analiza el conjunto … del proyecto demo-proyecto") point elsewhere. Only the chat runs the staged harness (`agentSource: staged`). | `ls .claude/skills`; `/chat/status` | Promote the staged harness; make "Copiar comando" give `/preparar-ciclo <proyecto> <conjunto>`; update the README | agent |
| G2 | alta | S21 | "Aprobar grupo" decisions do not count: after 6 grupo approvals the toolbar shows "0/156", "Enviar 0 a aprobación" (disabled) and the footer shows "0 decisiones". Only after 1 ubicación accept did the batch pick up all 6 grupo issues. | `11-grupo-aprobado.png`, `12c-ubicacion-aceptada.png` | Count family decisions in `useProgress` (ready, done) | app |
| G3 | alta | S23 | A batch prepared on v41 cannot be approved once v42 exists. The page offers "Aplicar igualmente sobre la versión v41" with a mandatory note, but the dialog then refuses ("Re-analiza la versión nueva"). A drop on meeting day kills the week's batch. | `15-lote-v41-precheck.png`, `18-aprobado-dryrun.png` | Either allow the stale apply with the note (as the UI promises), or offer "Llevar decisiones a v42" (re-base the batch through inheritance) | app + engine |
| G4 | alta | S22, S25 | Issues created from a grupo decision are poor ACC content: the title starts with the internal id "[F-ada6a7374a] …"; the description is one line with the old wording "Bajar penetración + 25 mm verificando altura de cielo"; "Tipo de incidencia —" and "Ubicación —" are empty; each card says "0 interferencias vinculadas" while the summary says 28. Ubicación-level issues are good (PROBLEMA / UBICACIÓN / ACCIÓN / CONSULTAR / PLAZO). | `16-lote-incidencias.png`, `43-lote-v42-aprobado.png` | Use the ubicación issue template for family issues (locations by level), no internal ids in titles, set the issue type, fix the linked count | engine |
| G5 | alta | S22, S27 | Issues are "Asignado a CLI" (a discipline code); the dry-run body has no assignee. Nobody specific gets the ACC notification, and there is no company per discipline. | `16-lote-incidencias.png`, `43-lote-v42-aprobado.png` | Per-project table discipline → company / ACC role or user, chosen at approval (invariant 7 is kept: no names in the text) | app + engine |
| G6 | alta | S2 | Nothing tells me a new version or clash test exists. No email, badge or project-list marker; "308 pendientes" on /proyectos does not say a newer version is waiting. | `19-proyectos-v42.png`, `20-grid-v42.png` | "Nueva versión v42 disponible · Analizar" on /proyectos and the project page (poll ACC); optionally a scheduled `/loop` that runs `/preparar-ciclo` | app + agent |
| G7 | media | S7 | 17 of 28 inherited ubicaciones need one-by-one "Confirmar decisión heredada" every cycle, even when unchanged (reasons such as "severidad crítica" or "pasada en estructura"). There is no bulk action ("Aceptar heredadas" is not in "⋯"), so decision memory saves little time. | `38-menu-aceptar-heredadas.png`, `40-confirmar-heredada.png`; API: 17 needsConfirmation | Ask again only when the clash changed, or offer a bulk confirm with a list and a typed count | engine + app |
| G8 | media | S17 | The agenda is not meeting-sized: 47 puntos in 8 disciplines (CLI 16 + "+9 más"). Grupos decided in v41 appear as "P1 · 0 ubic. · 0 interf." (↺). "Modelos superpuestos" is shown as a Regresión. EST owns the ALC/AP slab penetrations. | `32-reunion.png`; API agenda | Leave decided grupos out; add a roll-up per tema (pilot review #7); add a `higiene` kind; make the pipe discipline own pasadas (#8, #15) | engine |
| G9 | media | S18 | Personal data in notes: the email is flagged but "Juan Pérez" is not, the warning does not block, and "Imprimir agenda" prints both. | `33-nota-reunion.png` | Detect "Nombre Apellido"; mask or ask before printing; `/acta` drops the names | app |
| G10 | media | S16 | Reminders are not ready to send: no project name, "coordinación v42", "antes de la próxima corrida", no recipients, and no record that one was sent. | API `/reminders` | Project + date + meeting date; mark "enviado hh:mm"; one mailto per company | engine + app |
| G11 | media | S15 | ACC status changes are manual (M5), and "Abrir en ACC: #103" is plain text, so I search for the issue in ACC. | `30-incidencia-103-aceptada.png` | Deep link to the issue now; X2 write after the gate | app |
| G12 | media | S10, S12 | Chat cards show only "P-20261110-0005" or "Q-59ce9a6e65" (the question's "Aplicar" is disabled). The agent says "se aprueban en /aprobaciones" (wrong: Aplicar in the workspace), starts with "I'll check the family's details first.", and a stale "El agente está analizando…" chip remains. | `35-agente-respuesta-1.png` | Card = one-line summary + target; fix the system prompt (where to apply, Spanish only); clear the chip on `done` | agent + app |
| G13 | media | S10 | The viewer selection → chat path cannot be practised in fixtures or demos ("Vista 3D no disponible"), so onboarding cannot teach it. | `21-v42-que-cambio.png` | A sample SVF in fixtures, or a "simular selección" from the panel's element list | app |
| G14 | media | S4 | The discipline wizard knows the token (ARQ, EST…) but does not preselect it (8 dialogs × 2 clicks). Two "PRJ-EST-MOD-001.rvt - {3D}" rows cannot be told apart. The live project still has 4 "Sin asignar". | `05-asignar-ahora.png`, `L1-live-proyecto.png` | Preselect `suggestedToken`; "Asignar todas las sugeridas"; show the folder | app |
| G15 | media | S30 | Rules: "Aprobar regla" only sets a flag, and the change takes effect only after a developer merges it in git. The Reglas page shows English rule names and raw JSON; the suggestion is a dense YAML diff. | `L5-live-reglas-sugerencias.png`, `L3-live-reglas.png` | Say clearly "aprobada → pendiente de publicar"; add a one-click "publicar" by the harness owner; Spanish `nameEs`; plain-language effect first | agent + app |
| G16 | media | S8 | Grupos are too fine and the review load stays high: needsReview is 130/156 grupos in v41 and 123/153 in v42. CLI×EST is split by beam section and penetration band, mostly 1-ubicación grupos (the chat agreed: same problem, 5 systems). | `21-v42-que-cambio.png`; CLI classify output | Coarser family signature for the meeting; inherit "accept" for unchanged rule-only items | engine |
| G17 | media | S11, S25 | Confirming an inherited ubicación whose grupo had a family issue creates a separate ubicación issue in the next batch (G-daf2796edb). After a real apply this may duplicate the v41 family issue. | `43-lote-v42-aprobado.png` | Link to the existing issue (`existing[]`) instead of creating a new one; check this before the first real apply | engine |
| G18 | media | S28 | No export for the BIM manager in the app (Reportes removed, no xlsx); no view across projects or model sets beyond "N pendientes". | `19-proyectos-v42.png` | One-page cycle summary (print/PDF) per model set; portfolio row per project | app + agent |
| G19 | media | — | One user does everything: no roles (reviewer / approver / BIM manager), no first-run guide in the app, no meeting date (deadlines default to +7 days). | whole run | Roles on the batch; first-run checklist (login → disciplinas → analizar → first lens); a project meeting day | app |
| G20 | baja | S11 | The approve dialog still lists the excepted ubicación under "Cambian de validez"; after approving, the main button reads "Nueva versión (A)"; "1 decisiones". | `26-aprobar-con-excepcion.png`, `11-grupo-aprobado.png` | Filter exceptions; clearer label; plurals | app |
| G21 | baja | S3b | "Analizar v0" for an undownloaded v42; v41 shows "Solo conteos" after a full CLI ingest. | `02-…`, `03-grid-v41-preclassify.png` | Fix the label and state | app |
| G22 | baja | S8 | "PROPUESTA DEL AGENTE" appears on engine-only proposals (no agent ran), so who did what is unclear. | `22-ubicacion-reaparecio.png` | "Propuesta del motor" unless `origin=agent` | app |
| G23 | baja | S8 | Pair labels: AP pipes listed under ARQ×ALL or EST×ALC grupos. Intermittent blank page and "El servidor local no responde" on reload (dev). | API families; `12-enviar-aprobacion.png` | Use the system discipline for the pair; retry on load | engine + app |

## (c) Time per weekly cycle (typical SalfaCorp building, ~300 clashes per run)

| Phase | Today | After G1–G12 |
|---|---|---|
| Preparar (S2–S5) | 30–45 min (notice by hand, CLI/Analizar, no AI review) | 10 min (notification + `/preparar-ciclo` running unattended) |
| Revisar (S6–S12) | 3–4 h (17 confirmations, ~40 fine grupos, family decisions not counted) | 1.5–2 h (coarser grupos, bulk confirm) |
| Verificar (S13–S16) | 45–60 min (ACC by hand, editing reminders) | 20 min (deep links, ready reminders; X2 later) |
| Reunión (S17–S20) | 2.5–3 h (agenda trimming, 47 points, acta by hand) | 1.5 h (roll-up agenda, `/acta`) |
| Aprobar / aplicar (S21–S26) | 45 min, plus a rework cycle when the base goes stale | 20 min |
| Seguimiento + informe (S27–S28) | 1.5–2 h (email/WhatsApp, report by hand) | 45 min |
| Aprender (S29–S31) | 15 min + a developer merge | 10 min |
| **Total** | **≈ 9.5–12 h** | **≈ 5–6 h** |

These are role-play estimates (fixtures: 303 clashes, 153 grupos), not measurements. Re-time them in the first two real cycles (pilot review, "Watch" list).

Screenshots (directory `C:\Users\rzepedal\AppData\Local\Temp\claude\b04b852c784a9319\3432c899-f6e6-4729-9e7b-bcf81e632ffc\scratchpad\journey\shots\`): 01–07 project, matrix, disciplinas · 08–12c v41 workspace and grupo approval · 13–18 v41 batch (stale) · 19–27 v42 Qué cambió, spot-check, exception · 28–31 Incidencias · 32–33 Reunión and note · 34–35 Agente · 36–43 reglas, inherited, v42 batch and dry run · L1–L5 live project (read only).
