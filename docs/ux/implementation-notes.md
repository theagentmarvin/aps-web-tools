# UI implementation notes (coder D, phase 1)

Companion to `coordinator-ux-spec.md`. Lists where the build differs from the spec and what the server must provide.

## Data access

- `src/lib/api/coordinator-api.ts` defines `CoordinatorApi`; types live in `src/lib/api/types.ts`.
- `VITE_COORD_API=mock|http` selects the implementation. With no value, dev uses `mock` and production builds use `http`. The mock is loaded through a dynamic import.
- `MockCoordinatorApi` (`src/lib/api/mock/`) is in memory and seeded, so the data is the same on every load. It holds 3 projects and 4 model sets. Torre B / Coordinación general v14 has 1,200 clashes in 150 groups across EST/ARQ/CLI/SAN/ELE/INC, with 26 groups already decided. There are 3 batches: one ready, one ready on a stale base, one applied. One model set has no analysis yet, and there is an audit trail, corrections and two rule suggestions. About 90 s after the workspace opens, the mock agent updates 3 proposals so the "Actualizar (Shift+R)" bar can be tried.
- `HttpCoordinatorApi` (`src/lib/api/http.ts`) calls `/api/coord/*`. The header comment of that file lists every endpoint.

## HTTP endpoints expected from server/api

All JSON. Errors are `{ error: { code, message } }` with a matching status code.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/coord/me` | `UserInfo` |
| GET | `/api/coord/agent/status` | `AgentStatus` (spec: `/api/agent/status`) |
| GET | `/api/coord/home` | `HomeSummary` |
| GET | `/api/coord/hubs` | `Hub[]` |
| GET | `/api/coord/projects?hubId=&q=` | `ProjectSummary[]` |
| GET | `/api/coord/projects/:projectId` | `ProjectSummary` |
| GET | `/api/coord/projects/:projectId/model-sets` | `ModelSetSummary[]` |
| GET | `/api/coord/projects/:projectId/model-sets/:modelSetId/tests` | `TestRun[]` |
| GET | `/api/coord/triage/:projectId/:modelSetId?test=` | `TriagePayload` (spec: `/api/triage/...`) |
| GET | `/api/coord/triage/:projectId/:modelSetId/changes?test=&since=` | `TriageChanges` |
| GET | `/api/coord/tests/:testId/groups?pair=&priority=&validity=&level=&accStatus=&delta=&sort=&limit=&cursor=` | `Page<ClashGroup>` |
| GET | `/api/coord/tests/:testId/groups/:groupId` | `GroupDetail` |
| GET | `/api/coord/tests/:testId/groups/:groupId/clashes?limit=&cursor=` | `Page<Clash>` |
| POST | `/api/coord/tests/:testId/elements/properties` body `{refs}` | `ElementProperties[]` |
| GET | `/api/coord/tests/:testId/proposals?ids=&limit=&cursor=` | `Page<Proposal>` |
| GET | `/api/coord/projects/:projectId/assignees` | `Assignee[]` |
| POST | `/api/coord/triage/decisions` body `Decision[]` | `{saved: string[]}`, idempotent by `Decision.id` |
| GET | `/api/coord/decisions?testId=&projectId=&limit=&cursor=` | `Page<Decision>` |
| POST | `/api/coord/batches` body `{projectId, modelSetId, testId}` | `Batch` (send to approval) |
| GET | `/api/coord/batches?state=&projectId=` | `BatchSummary[]` |
| GET | `/api/coord/batches/:batchId` | `Batch` |
| POST | `/api/coord/batches/:batchId/preflight` | `PreflightResult` |
| PATCH | `/api/coord/batches/:batchId/items` body `{itemIds, excluded}` | `Batch` |
| PATCH | `/api/coord/batches/:batchId/items/:itemId/issue` body `Partial<IssueDraft>` | `Batch` |
| POST | `/api/coord/batches/:batchId/return` | `Batch` |
| POST | `/api/coord/batches/:batchId/discard` | `Batch` |
| POST | `/api/coord/batches/:batchId/approve` body `ApproveRequest` | `ApplyStatus` |
| GET | `/api/coord/batches/:batchId/apply-status` | `ApplyStatus` |
| POST | `/api/coord/feedback` body `FeedbackInput` | `{feedbackId}` |
| GET | `/api/coord/rules` | `RuleSummary[]` |
| GET | `/api/coord/rules/:ruleId` | `RuleDetail` |
| GET | `/api/coord/rule-suggestions` | `RuleSuggestion[]` |
| POST | `/api/coord/rule-suggestions/:id/decision` body `{decision}` | `RuleSuggestion` |
| GET | `/api/coord/learning/corrections?projectId=&limit=&cursor=` | `Page<CorrectionRow>` |
| GET | `/api/coord/learning/calibration` | `Calibration` |
| GET | `/api/coord/reports?projectId=&modelSetId=&from=&to=` | `ReportData` |
| GET | `/api/coord/audit?project=&user=&action=&from=&to=&batch=&limit=&cursor=` | `Page<AuditEvent>` |

## Deviations from the UX spec

- **One prefix for all endpoints.** Every endpoint sits under `/api/coord/`. Field meanings are unchanged.
- **Validity enum.** It follows the server and `mcp-tool-contracts.ts`: `real | false_positive | duplicate | tolerance | by_design | model_error | unknown`. Two labels were added, `validity.byDesign` "Pasada prevista" and `validity.modelError` "Error de modelo". The `v` menu therefore has 7 entries, and the URL tokens add `prevista` and `error_modelo`.
- **Priority.** The UI uses `1..4` (P1–P4). The server maps it from `Severity` / score.
- **Undo.** A `Decision` can have `kind: "undo"` with `undoes: <decisionId>`. The log stays append-only, and the effective decision is the latest one that has not been undone.
- **Batch shapes.** `BatchItem` adds `fields[]` (field-level diff rows), plus `label`, `groupId`, `issue`, `aiConfidence`, `lowConfidence`, `viewedInViewer` and `excluded`. `Batch` adds `projectName`, `modelSetName`, `testDate`, `latestVersion`, `origin`, `review`, `statusTransitions`, `issuesByDiscipline` and `lastPreflightAt`. `ApproveRequest` carries `excludedItemIds`.
- **AuthGate in mock mode.** The gate is open, because demo data needs no APS session. A "Modo demostración" badge shows in the nav.
- **Flat-mode rows.** In `view=clashes`, clash rows are 56 px with two lines, so the chips fit in 380 px. Nested rows under an expanded group are 36 px, as specified.
- **Dates.** Dates are always `dd-mm-yyyy` and `dd-mm hh:mm`, in 24 h, for both languages.
- **Glow.** `clash-highlight.ts` is a new module and does not change `shader-effects.ts`. It draws overlay meshes from `viewer.impl.getRenderProxy(model, fragId)` with an additive, depth-test-off shader, so the glow shows through ghosted context, and it caches them per (model, dbId, side). The solid tint (`setThemingColor`) always applies. **This path has not been run against a real APS session** (no login available). Only the mock placeholder path was exercised.
- **Not done in this phase:**
  - The hover tooltip A/B prefix (`ElementTooltip` `sideOf`).
  - The second approver (config is off by default).
  - The "Desactivar" button on rules (the page is read-only).
  - The filter Web Worker (filter and sort of about 1.3k items runs well within budget on the main thread).
- **Saved views.** The view name is asked for with `window.prompt`.
- **Callback.** `routes/callback.tsx` got one change: it redirects to `sessionStorage["coord.returnTo"]` when set.

## Phase 2 (wired to server/api, http + fixtures)

- **Types.** `src/lib/api/types.ts` now re-exports the wire types from `server/api/contract.ts` (type-only import) and adds only UI-only items: `REASON_CODES`, `VALIDITIES`, `NATURES`, `SEVERITIES`, `DecisionState`, `plain()`.
- **Vocabulary.** The UI uses the engine vocabulary everywhere:
  - validity is `real | false_positive | tolerated | needs_info`;
  - nature (with `duplicate`) is a new filter (`?nature=fisica,holgura,duplicada,secuencia`) and a chip;
  - severity is shown in the detail header.
  - The `v` menu has 4 entries.
  - URL tokens are `valida, falso_positivo, tolerable, requiere_info`.
  - Default action per validity follows clash-taxonomy §2: real → issue; false positive → close; tolerated → mark reviewed; needs_info → stays active.
  - The mock maps its internal patterns as follows: duplicate → false_positive + nature duplicate; by_design → tolerated; model_error → real (root cause); unknown → needs_info.
- **CSRF.** `HttpCoordinatorApi` fetches `GET /csrf` once and sends `X-Coord-CSRF` on every non-GET call. On a 403 CSRF error it refreshes the token and retries once, because the token changes when the dev server restarts.
- **Auth.** `CoordAuthProvider` (`src/lib/coord-auth.tsx`) uses `GET /auth/status` and `POST /auth/login`. A login opens the authorize URL in a new tab and the provider polls while `loginInProgress`. `AuthGate`, Home and the user menu use it. In fixtures mode the nav shows "Sesión de demostración".
- **Tests.** Uncached tests (`cached:false`) show "Analizar". On the project page this button is in the test list; in the workspace it is in the header next to the test select. It calls `POST …/tests/:accTestId/ingest`. When triage returns `not_ingested`, the workspace shows the test list instead of an error.
- **Approve and apply.** Approval is a separate step: a dialog with a checkbox and APLICAR when the server requires the word. After approval, the dry run (`POST /apply {dryRun:true}`) shows the exact ACC request bodies. The real apply sits behind a second typed APLICAR, and its status is polled. The page also shows `Batch.approval`, `BatchItem.result`, and `mcOperation:"none"` items.
- **Smaller additions.**
  - `Proposal.flagged` shows a "Texto marcado" chip in the row and the detail, plus a notice in the rationale.
  - `GroupDetail.reviewReasons` is fetched for needs-review groups.
  - The audit page handles the `engine` actor.
  - `{untrusted}` wrappers are unwrapped to plain text in the HTTP client, and React only renders text.
- **Placeholders hidden:**
  - `kpis.issuesClosed` when it is 0;
  - `counts.assignments` when it is 0;
  - the clash count of uncached tests (always 0);
  - `ProjectSummary.modelSetCount` when it is 0.

## Model set page: clash grid and disciplines (phase 4)

- **Route.** `/proyectos/:projectId` has a model set selector (`?modelSet=`), a version selector (`?test=` takes a test key or an ACC test id) and four tabs (`?tab=`):
  - Matriz de interferencias (default);
  - Pruebas (clash checks);
  - Disciplinas;
  - Cerradas (a placeholder until the server reports closed clashes).
- **Wire types.** They come from `server/api/contract.ts`: `ClashGrid`, `ClashGridDocument`, `ClashGridCell`, `IngestJob`, `ModelSetView`, `DisciplineRule`, `DisciplineConfig`, `DisciplinePreview`. The UI adds an optional `GridDocument.folderPath`; it is **not in the contract yet** and is needed to tell apart two files with the same name.
- **Grid behaviour.**
  - A cell shows groups when the test is classified and clashes otherwise; the legend says which.
  - Heat scale: linear orange in 7 steps. Columns are the same models as the rows (full symmetric matrix); the diagonal is a model against itself.
  - Keyboard: roving focus, arrows and Home/End move, Enter or Space opens.
  - Opening a cell goes to `/coordinacion/:p/:m?test=<testKey>&docs=a,b&decision=`. Empty cells don't navigate. Counts-only tests offer Analizar instead.
- **Triage `docs` filter.** The triage workspace filters `docs=a,b` client-side, using each group's member document pairs. `GET /tests/:id/groups` has no `docs` parameter yet.
- **Ingest.** `POST …/ingest` returns `{jobId}`; `GET /ingest-jobs/:jobId` is polled every 800 ms. The grid reloads at `clash_grid_ready`. A plain `{testKey}` reply (older server) counts as done.
- **Disciplines.**
  - Assigning a discipline sends `PUT …/documents/:lineageUrnB64/discipline {discipline, createRule?}`. A reply of `{jobId}` is polled, then the grid is refetched.
  - The preview is `POST …/disciplines/preview {modelSetId?, rules}`.
  - Rules are saved with `PUT …/disciplines/rules {rules, version?}`.
  - **Assumed endpoint, not in the contract:** `POST …/disciplines/proposals/:id/decision {decision}`. Accepting first sends the same PUT.
- **Fallbacks while the server lands.**
  - A 404 on `…/clash-grid` builds the grid from the triage payload of a cached test (distinct groups per document and per pair).
  - A 404 on `/disciplines` falls back to the code list from `rules/discipline-matrix.yaml`, and the Disciplinas tab becomes read-only with a notice.
  - A 404 on `…/views` falls back to an empty list.

## Solution families in the triage workspace (2026-11-09)

Built against `server/api/contract.ts` (families types by Coder C) and `docs/domain/solution-families-proposal.md` §4–§5.

- **List:** a "Familias | Grupos | Interferencias" toggle, defaulting to Familias (`?view=` is absent for families; old `?view=groups` links still work). When the payload has no `families` (old classification), Familias is disabled with a tooltip and the list falls back to groups.
- **Tree:** discipline pair (or "Conjunto de modelos" / "No es problema") → problem type → family → instances (today's groups) → clashes. Each level shows its counts. It is virtualised in the same list as before, with `role="tree"`.
  - j/k move; l / → / Enter expand (or step into the first child); h / ← collapse (or jump to the parent).
  - The cursor lands on the first family, not on a header row.
  - `?family=F-…` deep-links; `?group=`/`?clash=` reveal the row inside its family.
- **Family pane** (`FamilyPanel.tsx`):
  - Headline "PAR · tipo de problema · host · N instancias en M niveles".
  - The proposed decision: validity, action, who moves plus consulted, solution options from the problem-type catalogue.
  - Aprobar familia (A) / Cambiar (E, inline editor) / Rechazar (X).
  - Blast-radius and spot-check status lines.
  - Validity-mix line, evidence line (penetration range, size histogram).
  - Instances list with an "Excepción" toggle per instance (reason required).
  - Issue preview: one per family with locations by level and a 1000-char counter, or "Dividir en una incidencia por instancia".
- **Approve dialog** (`FamilyDialogs.tsx`) is mandatory:
  - It states "Afecta N interferencias en M instancias".
  - It lists every instance whose validity would change (local check ∪ `decision-preview`); each needs a tick.
  - It lists real instances that a close/mark-reviewed decision will not touch (real clashes are never closed through a family).
  - It blocks until the spot-check is met (1 opened instance, 3 when > 50 unique clashes; opening an instance row records it) and every exception has a reason.
  - On confirm it syncs exceptions (POST / DELETE `/families/:id/exceptions`), posts the decision, then reloads `GET /tests/:testId/families`.
- **Instance pane:** a "Familia: … (N instancias)" chip in the header jumps to the family row (switching to Familias if needed).
- **Mock:** `src/lib/api/mock/families.ts` derives families from the generated groups.
  - The signature leaves validity out, so mixed families appear.
  - Typical-detail and orientation tags are present; there are model-set and non-issue buckets.
  - Approve, reject, preview and exceptions are implemented with the same guards as the server.

### Rename and counting (2026-11-09, user feedback)

- **Two views only: "Grupos | Interferencias".** The family tree is the "Grupos" view and the old flat groups view is gone.
  - It stays as the automatic fallback when a payload has no families.
  - UI language: a family is a **Grupo**; a former group (an instance, where the work is executed) is a **Ubicación**. "Aprobar grupo"; the chip reads "Grupo: … (N ubicaciones)"; "Excepción" stays per ubicación.
  - The server API and the code identifiers keep `families` / `groups`.
- **URLs.** `?view=groups`, `?view=families` and no `view` all open the tree; `?view=clashes` opens Interferencias. `?grupo=F-…` selects a grupo (`?family=` is still read); `?group=` / `?clash=` select a ubicación or a clash.
- **One unit: ACC clashes (raw), as in ACC.** Unique element pairs appear only in tooltips ("N interferencias en ACC · U únicas").
  - Both views filter at clash level, so a query yields the same clashes in both.
  - The tree groups the passing clashes into ubicación → grupo → tipo de problema → par. Every node is the sum of its children under the active filters.
  - The line above the list, "N grupos · M ubicaciones · K interferencias", is identical in both views.
  - `tests/ui/triage-tree-counts.test.ts` checks this on the mock (Torre B, Sandbox v11) and on a v11-shaped variant with raw duplicates.
- **Order.** Every level is sorted by worst priority, then the number needing review, then clash count. This applies across buckets too ("Conjunto de modelos" / "No es problema" are not pushed to the end).
- **Selection follows the tree.**
  - Selecting any node (par, tipo, grupo, ubicación) shows in the viewer the union of its subtree's clashes under the filters. The models loaded are every document involved, or only the `docs=` pair when that filter is set.
  - Markers cap at 60, with "+N más" in the legend. The view fits to the union.
  - Node checkboxes are tri-state and check every ubicación below; Space does the same on the cursor row. Bulk actions apply to the checked ubicaciones.

## M1: lenses, "Qué cambió", ACC state, scope banner (2026-11-09)

Plan: `docs/PLAN-core-features-simplified.md` (approved). Contract: `ClashGroup.change` / `.acc`, `TriageFamily.changeCounts` / `.acc`, `TriagePayload.changeSummary` / `.scopeChanges` / `.accSync` in `server/api/contract.ts`.

- **Lens row** (`LensBar.tsx`) above the tree: `[Qué cambió N] [Incidencias] [Reunión] [Todo N]`, a `role=tablist` navigated with ←/→, and encoded in the URL as `?lente=cambios|todo`.
  - Default: "Qué cambió" when the test has a previous version (`changeSummary.previousVersion` or `test.delta`), else "Todo".
  - "Incidencias" (M3) and "Reunión" (M4) are visible but disabled ("Próximamente").
  - Tab counts are ACC clashes under the other filters: "Qué cambió" counts the clashes that actually changed (new + changed + reappeared, 334 on v11); "Todo" counts all of them.
  - In "Qué cambió" the summary line adds that number in brackets, identical in both views: "10 grupos · 51 ubicaciones · 432 interferencias (334 nuevas)". The 432 is every clash of the 51 changed ubicaciones; the bracket is what actually changed.
- **Qué cambió.**
  - Keeps the ubicaciones whose `change` is new, changed or reappeared, with the same predicate in both views, so the summary line stays equal between Grupos and Interferencias.
  - Unchanged ubicaciones sit in one collapsed row at the end, "↺ N ubicaciones sin cambios", outside the lens totals (lens + sin cambios = Todo).
  - Anything that reappeared sorts first at every tree level, replacing the regression banner.
  - The panel opens on "Cambios desde la prueba anterior" and shows one line: "Antes (v10): … → ahora: …" (penetration, clash counts when the change is added clashes, and the previous decision), or "Nueva en esta versión" / "Reapareció".
  - The grupo panel shows "Respecto de v10: N nuevas · M cambiaron · K reaparecieron · J sin cambios".
- **Scope banner (X6).** One banner, with one line per `scopeChanges` entry and the out-of-scope count. Out-of-scope clashes are never shown as resolved. Today the server sends only a count (`changeSummary.outOfScope`); `isOutOfScope()` is ready if clashes start carrying it.
- **At most 2 banners**, by priority: scope change > stale version > new agent proposals ("Actualizar") > pace nudge.
- **Header:** "Preparado por el agente · hh:mm", taking the newest of the agent's last activity and the newest proposal. Its tooltip carries the ACC sync line ("ACC sincronizado hh:mm · N asignados · M cerrados").
- **Violet bar:** a thin violet left bar on the proposal block when any field came from the agent (llm / rule+llm). It disappears once the coordinator edits or corrects it.

### Row cap: max 3 chips + counts + 1 state icon (`RowMarks.tsx`)

| Row | Chip 1 | Chip 2 | Chip 3 (one status chip, by precedence) | State icon (one, by precedence) |
|---|---|---|---|---|
| Ubicación | Priority | Discipline pair | Reapareció > Cambió > Nuevo | Your decision in this version (✓ ✎ ✕ ⏸) > open agent question **?** (M2) > ACC: closed ⊘ / assigned or mixed (issue icon; tooltip with issue ids, "siguen" / "resueltas") > exception ⚑ > inherited ↺ (tooltip "Heredada de v10 · decidida por ti / por el grupo / en ACC") / ◌ > meeting note (M4, only when nothing above applies) > pending ○ |
| Grupo | Worst priority | Validity, **only when it is not "Conflicto"** (No es problema / Dentro de tolerancia / Falta información); the panel always shows it | Reapareció > Cambió > Nuevo > validez mixta > orientación por confirmar > Típico | Decided ✓ > ACC (aggregated) |
| Interferencia (flat) | Priority | — | Reapareció > Cambió > Nuevo | Same as ubicación (ACC from its group) |
| Nodes (par / tipo) | Worst priority | — | — | — (counts and "N por revisar" as text) |

**Removed from rows, still in the tooltip or panel:** confidence dots, the "Revisión aleatoria" chip (the spot-check guard still applies), the flagged-text chip, the agent-updated flag icon, the "no 3D" icon, and DeltaBadge (replaced by the change word). The other grupo tags (Típico, validez mixta, orientación) stay in the grupo panel header.

## M2: decision memory (F1) and agent questions (X3) (2026-11-09)

Contract: `ClashGroup.inherited` (InheritedDecision), `ClashGroup.questionIds`, `TriagePayload.questions` (CoordinatorQuestion), `changeSummary.baseVersion` / `baseReason`, `Proposal.origin`, V01–V05 in `REASON_CODES`, and `POST /questions/:id/answer` (QuestionAnswerRequest).

- **Baseline.** "Qué cambió" compares with `changeSummary.baseVersion`. The lens tooltip and the panel lines say "respecto de v10 (última revisada)", or "(anterior)" when `baseReason` is `previous`.
- **Inherited decisions.**
  - Rows show ↺ with the tooltip "Heredada de v10 · decidida por ti / por el grupo / en ACC".
  - Inherited groups count as decided (server `reviewState: decided`), so the default filter (Pendiente) hides them in both views.
  - In "Qué cambió", inherited and unchanged items stay under "↺ N sin cambios".
  - In the panel, an unchanged inherited ubicación shows "Decisión heredada de v10: Válida · Crear incidencia · decidida por ti" with **[Mantener ⏎] [Revisar E]**. Mantener records an `accept` with the note "Mantiene la decisión heredada de v10". Enter keeps it on such a row; on any other row Enter expands.
  - A changed item that had a decision shows "Antes decidiste (v10): … · cambió: …".
- **Agent questions.**
  - The row state icon is **?**, which comes before ACC, ↺ and ○.
  - The panel opens with a violet callout holding the question, the option buttons and a free-text answer, and shows the answered or stale state afterwards.
  - The UI derives `validity` / `action` from the chosen option's wording (`src/features/triage/questions.ts`). When the server reports `decisionIds`, the UI merges the server's decisions, so the answer shows as the decision.
  - "Qué cambió" includes any ubicación with an open question, even if it is unchanged, with the same predicate in both views.
- **Violet bar** on the proposal block only when `Proposal.origin === "agent"`.
- **Reason codes:** V01–V05 labels are in i18n under `reasons.V0x`, ready for M3 verification rejects.

## M3: lens "Incidencias" (F2 verification + F5 follow-up, READ-ONLY) (2026-11-09)

Contract: `GET /tests/:t/issue-checks` (IssueChecksPayload / IssueCheck), `GET /tests/:t/reminders` (IssueReminder), and `POST /tests/:t/issue-checks/:issueId/decision` (IssueVerdictDecisionRequest, V01–V05 on reject). Nothing is written to ACC until M5.

- **Lens.**
  - The tab is enabled when the test has issue checks; its count is the number of issues.
  - Tree: **responsible discipline** (with a **Copiar recordatorio** button that puts the server text on the clipboard and shows a toast) → **issue row** → ubicaciones → clashes.
  - Order (disciplines by their most urgent issue): dice_resuelta → sigue_abierta with stuckCycles ≥ 2 → overdue → avance → sigue_abierta → resuelta → no_verificable.
  - Issues show even with 0 remaining clashes (resolved-only).
- **Issue row:** priority · ACC display id · **one verdict chip** (*Resuelta n/n · Avance n/m · Sigue abierta · Dice resuelta ✕ · No verificable*, tooltip = `reason`) · "vencida" / "sin avance N ciclos" as text · counts · one state icon (issue icon, or ✓ / ✕ once decided).
- **Summary line:** "N incidencias · M resueltas · K dicen resuelta", computed from the checks and identical in both views. In Interferencias the rows are the clashes of the issue ubicaciones under the filters.
- **Panel: "Verificación en vNN"**, opened first both for an issue row and for a ubicación selected in this lens.
  - Shows the verdict, existing and resolved counts, the 3 checks (✓ / ✕ / – for desplazamiento, versión del modelo and alcance), the template evidence (Copiar), and "Abrir en ACC" with the ACC id. The contract has no issue URL yet.
  - **Aceptar (A):** for resuelta, "lista para mover", then the reminder "Muévela a «En revisión» en ACC"; for the other verdicts, "a la reunión".
  - **Rechazar (X):** opens a V01–V05 picker with the suggested code preselected (dice_resuelta → V01, sigue_abierta / no_verificable → V02, resuelta → V03, avance → V05). Keys 1–5 pick a code and Enter confirms, so it takes at most 2 keystrokes.
- **Viewer:** selecting an issue, discipline or ubicación shows the remaining clashes of its ubicaciones. Resolved elements are not greyed: the payload does not include resolved clashes (deferred).
- **Not used yet:** `GET /issue-checks/gate` (the M5 evidence gate).

## M4: lens "Reunión" (F4 meeting) (2026-11-10)

Contract: `GET /tests/:t/agenda` (AgendaPayload: `cap`; per discipline `items` + `more` + `summary`; kinds regresion → p1_pendiente → incidencia → nuevo → confirmar_resuelta), `GET /tests/:t/notes` and `PUT /tests/:t/notes/:family|group/:id` (MeetingNote, revisions), `GET/PUT /tests/:t/families/:f/view` (SavedViewerView `camera`, ≤ 20 KB, local only).

- **Lens.**
  - The tab is enabled when there is an agenda; its count is the number of topics.
  - Tree: discipline (server order, "N puntos · +N más") → agenda items in server order. Each item reuses the existing rows: an issue row when the item has an issue check, otherwise a grupo row, otherwise ubicación rows. Rows expand to ubicaciones and clashes as before.
  - A row that appears twice is shown once.
  - The summary line reads "N puntos · M disciplinas" (agenda points) in both views. In Interferencias the rows are the clashes of the agenda ubicaciones.
- **Nota de reunión.**
  - Opened first in the panel for grupo, ubicación and issue rows, showing "En agenda: {reason}" and a textarea.
  - **N** focuses it from anywhere in the lens (outside the lens, N still opens the decision note).
  - Debounced autosave (800 ms): "Guardando…" then "Guardado hh:mm".
  - Targets: grupo row → family; ubicación → group; issue → its first ubicación (so it does not mix with the agenda item of its grupo).
  - Rows with a note get the note icon, at the lowest precedence before ○.
  - Decisions are still taken in "Aprobar grupo"; `/acta` later turns the notes into normal proposals.
- **Guardar vista** (viewer toolbar, this lens only): `viewer.getState({ viewport: true })` → PUT. Selecting a row whose grupo has a saved view restores the camera (`restoreState` with only the viewport filter). The panel shows "Vista guardada hh:mm" or "Sin vista guardada".
- **Imprimir agenda** (summary line, this lens): `window.print()` with `body[data-print=agenda]` and `@media print` rules in `src/app.css`. Only the print-only agenda prints: by discipline, with item titles, kinds, reasons and notes; no viewer. There is no HTML exporter.
- **URLs:** an issue row writes `?incidencia=`, which is restored once the issue checks load.

## Pilot-readiness fixes, UI side (2026-11-10)

Source: `docs/domain/pilot-readiness-review.md`.

- **Questions (security).**
  - All text-to-decision parsing is removed: the old regex read "No, no es falso positivo: es real" as false_positive.
  - Options are structured `{label, validity?, action?}` from the server. The UI sends only `optionIndex` (plus `confirmCount`); free text is sent as `answer` and decides nothing. Plain-string options from older servers decide nothing.
  - The callout says "Esta respuesta decidirá N ubicaciones" (N = `affectedGroups`). Above 3, choosing an option opens an explicit "¿Confirmas?" step that sends `confirmCount = N`.
  - Tests in `tests/ui/pilot-safety.test.ts`.
- **Agenda.** Issue follow-ups come first in each discipline and are never under "+N más" (server order and cap). The ACC number leads the item ("#106 · …"), and issue rows show `#nnn`.
- **Notes.**
  - The placeholder no longer asks "quién": "qué disciplina o empresa". A fixed hint reads "Sin nombres ni correos: usa disciplinas o empresas."
  - A non-blocking inline warning appears for emails, phone numbers and "Nombre Apellido" patterns (`src/features/triage/privacy.ts`, with an allow-list of disciplines and model words).
- **Inheritance.**
  - An inherited decision with `needsConfirmation` (or an instance `inherited_pending`) is PENDING: an amber ○ "Confirmar decisión heredada", never ↺ or decided.
  - The panel shows "Confirmar decisión heredada de vNN" with **Confirmar (A)**, a normal accept with the dwell guard. Enter / Mantener only keeps decisions that need no confirmation.
  - The "Aprobar grupo" dialog lists these ubicaciones and leaves them out of the blast radius.
- **ACC closed while real:** `closedInAccWhileReal` shows "⚠ Cerrada en ACC ({motivo}) pero el motor la ve real: confirmar." in the panel.
- **Wording (BIM review).**
  - **Naming stays "grupo / grupos"** (product owner decision: two options only, individual clashes and grupos). The BIM reviewer suggested "tema"; it was applied and then reverted. The toggle reads "Grupos | Interferencias", and the panel, dialogs ("Aprobar grupo"), toasts, shortcut help and summary lines ("10 grupos · 51 ubicaciones · 432 interferencias (334 nuevas)") use "grupo". The Reunión agenda counts **puntos** ("N puntos · M disciplinas").
  - Válida / Tolerable → **Real / Tolerada**.
  - "Distancia −56 mm" → **"Penetración 56 mm"**; clearance clashes show "Separación".
  - "Bajar penetración + 25 mm …" → **"Bajar el ducto ~N mm (verificar altura de cielo)"**, with N from the family's max penetration.
  - "Dice resuelta ✕" → **"Cerrada en ACC, sigue en modelo"**.
  - "No verificable" → **"Se desplazó" / "Modelo sin actualizar" / "Fuera de alcance"**, from the checks.
  - Raw ACC statuses are translated (Abierta, En revisión, Cerrada…).
  - "vencida" is never shown on a resuelta.
  - "Verificación del {fecha}" and the printed "Coordinación del {fecha}" replace version numbers.
  - Plural fixes: "Abre al menos N ubicaciones", "siguen N · resueltas M", "(+N)".
- **Not changed here (server text):** the agenda reasons ("ubicación(es)") and the evidence template ("Estado ACC: open").

## Simplification (2026-11-10, product owner)

- **Navigation:** Proyectos · Aprobaciones · Reglas. Ajustes stays in the user menu; the agent status and ES/EN switch are unchanged.
  - Inicio, Reportes and Auditoría were removed from the UI: route files, nav entries, `features/reports/ReportKpis.tsx`, the API client methods (`getHomeSummary`, `getReport`, `listAudit`), their mock data (`buildReport`, `seedAudit`) and 64 i18n keys only they used.
  - `/`, `/inicio`, `/reportes/*` and `/auditoria/*` redirect to `/proyectos`. The sign-in card still shows there when logged out (AuthGate).
  - The **server audit log is untouched** (it protects approvals); only its UI page went away.
  - `chart.js` stays: the Reglas page and the data-management dashboard still use it.
  - From Inicio, only "Continuar donde quedaste: {proyecto / conjunto}" survives, as one line on `/proyectos` (the last coordinación opened, kept in localStorage).
  - Workspace shortcuts: `g p` / `g a` / `g r`.
- **Banners → one status line** (`StatusLine.tsx`) in the workspace header row: ≤ 28 px, no layout shift.
  - Only the highest-priority notice shows: scope change > stale version > new agent proposals > pace nudge. The others sit behind "+N".
  - Scope example: "⚠ Alcance: 2 modelos agregados (MODELING TEST S4.rvt, S3.rvt) · Ver detalle". "Ver detalle" opens a popover with the per-document lines and the out-of-scope count.
  - On v11 the tree starts 69 px higher (y 273 → 204 at 1600×1000).

## Agent chat: "Agente" tab in the right panel (2026-11-10)

Propose-only domain agent (docs/ai/chat-agent-design.md). The UI never applies anything on its own.

- **Placement.** The right column has a 32 px tab bar, "Detalle" | "Agente" (`RightTabs` in `src/routes/triage.tsx`). The viewer width never changes.
  - **Shift+C** or the header button "Agente" toggles the tab. Lowercase `c` stays the viewer mode.
  - The active tab is remembered in `coord.layout.rightTab`.
  - Both tabs stay mounted, so the scroll and the draft survive a switch.
  - When a proposal arrives while "Detalle" is showing, a violet badge appears on "Agente" (`store.noteChatProposal`).
  - "Preguntar al agente sobre esto" (`AskAgentLink`, at the end of the decision block in the ubicación and grupo panels) opens the tab, restores the focus chip and focuses the input.
- **Panel (`src/features/triage/ChatPanel.tsx`).**
  - **Notice.** It is shown once per browser session (`sessionStorage coord.chat.notice`): "Este chat envía datos del modelo a Claude; uso sujeto al Procedimiento Acceso Herramientas IA de SalfaCorp."
  - **Preflight.** `GET /chat/status` runs before the first message. If Claude Code is not installed or not signed in, the input and prompts are disabled and the fix text is shown.
  - **Text.** Markdown-lite rendering, built from React elements only (no raw HTML).
  - **Status line.** Shows `phase` / `tool` (+ target) in Spanish, with a Cancel button.
  - **Per-message footer.** Cost and duration are shown small and muted ("US$ 0.03 · 2,7 s").
  - **"Nueva conversación"** sends `newSession: true` on the next message.
  - **Context chips (each one has an ×).**
    - lens;
    - focus (family / grupo / ubicación);
    - viewer selection. It comes from `viewer.getAggregateSelection()`, mapped model → URN → `documentId` in `viewer-selection.ts`, capped at **50**, and shown as "50 de N" when more are selected.
  - **Prompts.** Three suggested prompts, which depend on the context.
- **Cards come only from the server's `proposal` / `question` SSE events** (never from the model's text).
  - When the event has only `{id, kind, summary}`, the card resolves the target once with `listProposals({ids:[id]})` and queues it into the triage.
  - "Aplicar" stays disabled until a target exists.
  - Aplicar = the existing human paths:
    - decision → the guarded accept;
    - family_decision → the "Aprobar grupo" dialog;
    - regroup → a confirm step, then the human-only regroup apply;
    - question → reveals the ubicación's callout.
  - "Ver" switches to "Detalle", focused on the item.
- **HTTP (`src/lib/api/http.ts`, `sse.ts`).**
  - `POST /chat/messages` {testKey, message, context: {lens, focus: {familyId | groupIds | clashIds}, selection ≤ 50}, newSession?} returns `{messageId, sessionId}`.
  - `GET /chat/:messageId/events` is SSE over fetch (`SseParser`), mapped to UI events by `toChatEvent`. `done.costUsd` maps to cost; unknown error codes map to `failed`.
  - History: `GET /chat/history?testKey`.
  - Cancel: `DELETE /chat/:messageId`.
  - A 404 on `/chat/messages` falls back to the earlier draft (`POST /chat` streaming, `DELETE /chat/:chatId/run`).
- **Errors in Spanish, with the fix:** claude_not_found, not_logged_in, busy, timeout, cancelled, mcp_unavailable, rate_limited, failed.
- **Mock (`src/lib/api/mock/chat.ts`).**
  - It streams word by word with tool status lines.
  - It emits one proposal: regroup when there is a selection, family_decision for a family focus, otherwise decision.
  - It reports cost and duration.
  - `/error <code>` forces an error; `?chat=no_login` / `?chat=no_claude` simulate the preflight states.
- **Tests:** `tests/ui/chat-client.test.ts` covers SSE chunking at every boundary, CRLF / comments / multi-line data, event mapping (question → card, costUsd, error codes), and selection mapping (dedupe, unknown models, the cap of 50 with its total).

## Two rows above the workspace: app header + one toolbar (2026-11-10, product owner)

- **The app header (`nav.tsx`) is 44 px on the coordinación route.** It holds a slot (`#nav-workspace-slot`).
  - `WorkspaceNavContext` portals into that slot a compact breadcrumb "Proyecto › Conjunto de modelos". It is truncated, with the full text in the tooltip.
  - Next to it is the test selector, drawn as a short "v11 · 14-09" label over the native select (keyboard and screen readers unchanged).
  - The demo pill reads "Demo" there.
  - Other pages keep today's header: 51 px, no slot.
- **One toolbar (`role=toolbar`, 40 px, never wraps)**, left → right:
  - `FilterBar`: search, filter chips + "+ Filtro", Orden (icon + select), Grupos | Interferencias, Vistas (star icon);
  - `WorkspaceActions`: the StatusLine chip (max 24 rem), a "Preparado por el agente" sparkle icon (tooltip), review progress ("26/150" + a thin bar), Analizar (an icon button "↻ v9" when a version is not analyzed, a spinner + % while it runs), "⋯", and Enviar a aprobación (primary, right-most).
- **"⋯" menu:**
  - always: Agente/Detalle toggle (Shift+C), "Aceptar heredadas" (a dot on "⋯" when available).
  - At ≤ 1366 px (`TOOLBAR_COMPACT_QUERY`) it also gets Orden, Vistas and Analizar.
  - At that width the search collapses to an icon that expands on focus; "/" still focuses it.
- **Content top (list | viewer | tabs):** 147 px → 84 px at 1600×1000 (+63 px); 191 px → 84 px at 1366×768 (+107 px; the old workspace row wrapped to 2 lines there).

## Chat input compaction + validity wording (2026-11-10, product owner)

- **Chat input area (Agente tab).**
  - The suggested prompts moved into a ✨ "Sugerencias" button next to Enviar. It opens a menu above the input with ↑/↓ and Esc; picking a prompt fills the input and never sends it.
  - In an empty conversation, the same prompts are also listed in the message area.
  - The prompts use plain coordinator language and appear only when they apply:
    - with a row focused: "Explícame este grupo", "¿Qué solución recomiendas?";
    - when the row is a Conflicto: "Redacta la incidencia";
    - for an issue: "Explícame esta incidencia";
    - with a viewer selection: "Agrupa los elementos seleccionados";
    - when there is a previous version: "¿Qué cambió desde la versión anterior?";
    - with no row focused: "¿Qué debería revisar primero?".
  - The context chips became ONE 24 px line, "Contexto: <grupo> · <lente> · N elem.", truncated with the full list in its tooltip. Clicking it opens a popover where each item has an ×. "Nueva conversación" sits at the right of that line.
  - The input auto-grows from 1 to 6 lines. Its placeholder is "Escribe tu pregunta…", and the Enter / Shift+Enter hint is in the tooltip.
  - The message area at 1366×768 grew 451 → 545 px (mock) and 409 → 545 px (live v11). The input block shrank from 174 / 215 px to 79 px.
- **Validity wording.** Only the UI labels change; the API values stay the same.
  - real → "Conflicto" (en "Clash");
  - false_positive → "No es problema" ("Not an issue");
  - tolerated → "Dentro de tolerancia" ("Within tolerance");
  - needs_info → "Falta información" ("Needs info").
  - Every label has a one-line definition as its tooltip (`VALIDITY_TIP` in `src/lib/labels.ts`), shown on the ValidityBadge, the selects, the validity dialog and the filter values.
  - `tests/ui/validity-wording.test.ts` pins this wording.
