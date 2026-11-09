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
