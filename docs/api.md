# Coordinator server: HTTP API, MCP server, CLI

Owner: server (coder C). Types: `server/api/contract.ts` (types only, importable from `src/`). MCP contracts: `server/mcp/contracts.ts`.

One service layer (`server/coordinator.ts` + `server/coordinator-ui.ts`) backs the MCP server, the HTTP API and the CLI. ACC writes go only through `server/approval/` (the only module allowed to call `issueApprovedWriteToken`; `tests/server/import-guard.test.ts` enforces it).

## Running

| What | Command |
|---|---|
| Web UI + API (dev) | `npm run dev` (Vite mounts `/api/coord/*`) |
| API only | `npm run api` (127.0.0.1:3001, `COORD_API_PORT` to change) |
| MCP server | `npx tsx server/mcp/index.ts` (stdio; registered as `coord` in `.mcp.json`) |
| MCP smoke test | `npx tsx scripts/mcp-smoke.ts` (fixtures, temp home) or `--live` |
| CLI | `npm run coordinator -- <login\|logout\|status\|ingest\|classify\|approvals list\|approve <id>\|apply <id> [--no-dry-run]\|verify-approval <id> --json>` |

Environment:

- `COORD_DATA_SOURCE=fixtures`: offline mode. Serves `tests/fixtures/` as ACC: project `b.demo-proyecto` ("Edificio Demo Las Condes"), model set `9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f`, clash tests for versions 41 and 42. Writes are fake. They still need a valid human approval and consume single-use write tokens, but they are recorded in `<home>/fixture-acc/writes.jsonl` and never sent. Unset means live ACC.
- `COORDINATOR_HOME`: the `.coordinator` directory (default `<repo>/.coordinator`). Tests and demos use a temp dir.
- `COORDINATOR_CONFIG`: path of the committed config (default `<repo>/coordinator.config.json`). When that file is absent, the server uses `server/templates/coordinator.config.json`. `coordinator.config.local.json` (git-ignored) is deep-merged on top. Autonomy is hard-capped at **L1** (`MAX_SUPPORTED_LEVEL` in `server/config.ts`).
- Example in fixtures mode: `COORD_DATA_SOURCE=fixtures COORDINATOR_HOME=/tmp/coord npm run dev`.
- Templates for the files a human installs: `server/templates/mcp.json` (copy it to `.mcp.json`) and `server/templates/coordinator.config.json`. The harness guards block the agent from writing either file.

## Storage (`.coordinator/`)

`auth/token.json` (APS token, `server/aps/auth.ts`) · `secret/approval.key` (HMAC key, created on first approval) · `cache/` (normalized tests) · `tests/<testKey>/{test,classification}.json` · `proposals/<P-YYYYMMDD-NNNN>.json` · `rule-proposals/<id>.patch` · `batches/<L-YYYY-MM-DD-NN>.json` · `approvals/<batchId>.json` (signed) · `decisions/decisions.jsonl` · `feedback/feedback.jsonl` (with feature snapshots) · `audit/audit.jsonl` (hash-chained; `Store.verifyAudit()`) · `applied/<idempotencyKey>.json` · `budget/jobs.json` (local jobs/hour counter) · `projects/<projectId>/notes.md` · `reports/<projectId>/…` · `state/{context.json,counters.json,store.lock,apply.lock}`.

Writes are atomic: a temp file plus a rename, retried on Windows sharing violations. Mutations hold a single-writer lock. The lock is an O_EXCL lock file with stale takeover, and it is re-entrant within one async call chain.

## Lifecycles

- **Proposal** (`kind`: classification, group_action, issue_draft, status_change, rule_change): `draft → pending_review → approved | rejected | withdrawn`, then `approved → applied | failed`. `failed → applied` is a retry, and `approved → pending_review` happens when a batch is returned.
- **Batch** (lote): `ready` is created by "Enviar a aprobación" from the human decisions on a test. From there: `ready → approved` (HMAC approval) `→ applied | partial`. `ready → draft` (returned) and `→ discarded` are also possible.
- **Approval record**: `{batchId, projectId, modelSetId, testId, testKey, testVersion, proposalIds, itemIds, payloadHash, approvedBy{id,name,channel}, approvedAt, expiresAt, nonce, note?, hmac}`. `payloadHash` covers each included item's MC operation, targets and the exact ACC body. Apply and `verify-approval` re-check the signature, payload, expiry and that `testVersion` is still the latest model set version.
- **Apply**: one `clashes:close` and one `clashes:assign` POST per test, each carrying many groups (chunked at `apply.maxGroupsPerRequest`). A local budget of `apply.jobsPerHourPerOperation` (default 200, ACC allows 250) applies per project and operation. Jobs are polled. Every request has an idempotency key (a hash of batch, operation and body), so a request is never sent twice. `dryRun` (the default) returns the exact bodies.
- MC v3 has no "reviewed" write. `mark_reviewed` therefore closes with a tolerance reason (`MINIMAL_OVERLAP`), following the contract. `reopen` (and setting a status to active) is not applied from batches in v1: the item is created excluded, with a conflict note.

## HTTP API (`/api/coord/*`)

All JSON. Errors have the shape `{error:{code,message,hint?}}` with status 400/401/403/404/409/429/500. **Human-only** endpoints (marked H) require a same-origin request (Origin, else Referer, must equal Host) and the header `X-Coord-CSRF: <token>`. The token comes from `GET /api/coord/csrf`, which also sets the matching `coord_csrf` cookie (HttpOnly, SameSite=Strict). Every non-GET request is also checked for same origin. The approver identity is the APS profile in live mode, else `approver.name` from the config. In fixtures mode it is "Coordinadora Demo".

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/csrf` | – | `{token}` + cookie |
| GET | `/auth/status` | – | `AuthStatus` |
| POST H | `/auth/login` | – | `LoginStartResponse` (server-side PKCE login on the loopback callback; reuses the cached token; the browser never sees the secret) |
| POST H | `/auth/logout` | – | `{ok}` |
| GET | `/me` | – | `UserInfo` |
| GET | `/session` | – | `SessionInfo` |
| GET | `/agent/status` | – | `AgentStatus` |
| GET | `/home` | – | `HomeSummary` |
| GET | `/hubs` | – | `Hub[]` |
| GET | `/projects?hubId&q` | – | `ProjectSummary[]` |
| GET | `/projects/:projectId` | – | `ProjectSummary` |
| GET | `/projects/:projectId/model-sets` | – | `ModelSetSummary[]` |
| GET | `/projects/:projectId/model-sets/:modelSetId/tests` | – | `TestRun[]` (cached tests by test key, plus uncached ACC tests with `cached:false`) |
| POST H | `/projects/:projectId/model-sets/:modelSetId/tests/:accTestId/ingest` | `{refresh?, classify?}` | `{testKey}` |
| GET | `/projects/:projectId/assignees` | – | `Assignee[]` |
| GET | `/projects/:projectId/notes` | – | `ProjectNotes` |
| POST H | `/projects/:projectId/notes` | `{text, kind?}` | `ProjectNotes` |
| GET | `/triage/:projectId/:modelSetId?test` | – | `TriagePayload` |
| GET | `/triage/:projectId/:modelSetId/changes?test&since` | – | `TriageChanges` |
| GET | `/tests/:testId/groups?pair&priority&validity&level&accStatus&delta&sort&limit&cursor` | – | `Page<ClashGroup>` |
| GET | `/tests/:testId/groups/:groupId` | – | `GroupDetail` |
| GET | `/tests/:testId/groups/:groupId/clashes?limit&cursor` | – | `Page<Clash>` |
| POST | `/tests/:testId/elements/properties` | `{refs}` (≤20) | `ElementProperties[]` |
| GET | `/tests/:testId/proposals?ids&limit&cursor` | – | `Page<Proposal>` (one view per group) |
| POST H | `/triage/decisions` | `Decision[]` (idempotent by id; server sets user) | `{saved}` |
| GET | `/decisions?testId&projectId&limit&cursor` | – | `Page<Decision>` |
| POST H | `/batches` | `{projectId, modelSetId, testId}` | `Batch` (state `ready`) |
| GET | `/batches?state&projectId` | – | `BatchSummary[]` |
| GET | `/batches/:batchId` | – | `Batch` (includes `approval{valid,reason}`) |
| POST H | `/batches/:batchId/preflight` | – | `PreflightResult` |
| PATCH H | `/batches/:batchId/items` | `{itemIds, excluded}` | `Batch` |
| PATCH H | `/batches/:batchId/items/:itemId/issue` | `Partial<IssueDraft>` | `Batch` |
| POST H | `/batches/:batchId/return` | – | `Batch` |
| POST H | `/batches/:batchId/discard` | – | `Batch` |
| POST H | `/batches/:batchId/approve` | `ApproveRequest` (`confirmWord` APLICAR/APPLY when issues > 0 or changes ≥ 50; `apply?`) | `ApplyStatus` |
| POST H | `/batches/:batchId/apply` | `{dryRun?=true}` | `ApplyResponse` |
| GET | `/batches/:batchId/apply-status` | – | `ApplyStatus` |
| POST H | `/feedback` | `FeedbackInput` | `{feedbackId}` |
| GET | `/rules` | – | `RuleSummary[]` |
| GET | `/rules/:ruleId` | – | `RuleDetail` |
| GET | `/rule-suggestions` | – | `RuleSuggestion[]` |
| POST H | `/rule-suggestions/:id/decision` | `{decision}` | `RuleSuggestion` (does not edit `rules/`; a human merges with git) |
| GET | `/learning/corrections?projectId&limit&cursor` | – | `Page<CorrectionRow>` |
| GET | `/learning/calibration` | – | `Calibration` |
| GET | `/reports?projectId&modelSetId&from&to` | – | `ReportData` |
| GET | `/audit?project&user&action&from&to&batch&limit&cursor` | – | `Page<AuditEvent>` |

## MCP server `coord`

There are 27 tools, with names and inputs as in `docs/ai/mcp-tool-contracts.ts`. Outputs are one compact JSON envelope `{ok,data?,error?,truncated?,hint?}` capped at `agent.maxResponseTokens` (6,000 tokens × 4 chars); when the cap is hit, the largest array is cut. Model-derived text is returned as `{untrusted, flagged?}`, sanitised and limited to 120 characters; this covers group labels, element family/type/system, rule rationales and document names. Agent-written text is rejected when it contains URLs outside `issues.urlAllowlist`, emails, @mentions, control characters, or G-/C-/E-/P- ids that do not exist. Every tool call is audited (`tool.call`). No tool can approve. `apply_approved_proposals` takes `{batchId, dryRun=true}` and refuses without a valid HMAC approval.

### MCP deviations from `docs/ai/mcp-tool-contracts.ts`

- Proposal kinds and states follow the store. The kind is `issue_draft`, and the states are `draft | pending_review | approved | rejected | withdrawn | applied | failed`. `list_proposals` still accepts `issue`, `pending`, `superseded` and `applying` as aliases.
- Proposals are not auto-added to a draft batch, so `ProposalCreated` has no `batchId`. Batches are built from the coordinator's decisions in the UI.
- `ClashId` also accepts a `C-` prefix. MCP outputs use bare MC ids, while the HTTP API uses `C-<id>` because the UI expects it.
- `evaluate_ruleset`: `rubricScore` is 100 × the share of asserted EV fields that match. The eval-scenarios "Agent rubric" is not implemented in code. `macroF1` is an extra metric. `fixtures` = diff accuracy of v41 → v42 against `fixture-truth.json`.
- `generate_report` with `format: "xlsx"` returns a `validation_error` in v1. Use md or html.
- `get_group.label`, `list_groups.label` and `topPersistingGroups.label` are `Untrusted`, not plain strings, because engine titles embed family, type and system names (orchestrator ruling).
- `ingest_clash_test.counts` also includes `byStatus`.
- Extra error codes: `not_classified`, `invalid_state`, `conflict`.
