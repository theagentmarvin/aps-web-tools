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
