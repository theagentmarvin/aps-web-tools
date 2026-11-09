# Coordinator server: HTTP API, MCP server, CLI

Owner: server (coder C). Types: `server/api/contract.ts` (types only, importable from `src/`). MCP contracts: `server/mcp/contracts.ts`.

One service layer (`server/coordinator.ts` + `server/coordinator-ui.ts`) backs the MCP server, the HTTP API and the CLI. ACC writes go only through `server/approval/` (the only module allowed to call `issueApprovedWriteToken`; `tests/server/import-guard.test.ts` enforces it).

## Running

| What | Command |
|---|---|
| Install (human, once) | `npm run setup`. Interactive TTY only, refused under Claude Code. Installs `.mcp.json` and `coordinator.config.json` from `server/templates/`, installs `harness-staging/` into `.claude/` after you type INSTALAR (writes an audit event), runs the hook tests, checks the APS variables and prints the manual steps. `npm run setup -- --check` is read-only and fails while the harness dev marker exists. |
| Offline demo | `npm run demo`. Runs Vite and the API with `COORD_DATA_SOURCE=fixtures`, `COORDINATOR_HOME=.coordinator-demo` and `VITE_COORD_API=http`, and writes `.mcp.demo.json`. Start the agent with `claude --mcp-config .mcp.demo.json`. No setup needed. |
| Web UI + API (dev) | `npm run dev` (Vite on port 3000 with `strictPort`, mounts `/api/coord/*`) |
| API only | `npm run api` (127.0.0.1:3001, `COORD_API_PORT` to change) |
| MCP server | `npx tsx server/mcp/index.ts` (stdio; registered as `coord` in `.mcp.json`) |
| MCP smoke test | `npx tsx scripts/mcp-smoke.ts` (fixtures, temp home) or `--live` |
| CLI | `npm run coordinator -- <login\|logout\|status [--json]\|ingest\|classify\|approvals list\|approve <id> (fixtures)\|passkey-enroll\|apply <id> [--no-dry-run]\|verify-approval <id> --json\|setup [--check]>`. `status --json` is offline and prints `{loggedIn, dataSource, expiresAt?, autonomyLevel}`, never tokens or paths. |

Environment:

- `COORD_DATA_SOURCE=fixtures`: offline mode. Serves `tests/fixtures/` as ACC: project `b.demo-proyecto` ("Edificio Demo Las Condes"), model set `9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f`, clash tests for versions 41 and 42. Writes are fake. They still need a valid human approval and consume single-use write tokens, but they are recorded in `<home>/fixture-acc/writes.jsonl` and never sent. Unset means live ACC.
- `COORDINATOR_HOME`: the `.coordinator` directory (default `<repo>/.coordinator`). Tests and demos use a temp dir.
- `COORDINATOR_CONFIG`: path of the committed config (default `<repo>/coordinator.config.json`). When that file is absent, the server uses `server/templates/coordinator.config.json`. `coordinator.config.local.json` (git-ignored) is deep-merged on top. Autonomy is hard-capped at **L1** (`MAX_SUPPORTED_LEVEL` in `server/config.ts`).
- Example in fixtures mode: `COORD_DATA_SOURCE=fixtures COORDINATOR_HOME=/tmp/coord npm run dev`.
- Templates for the files a human installs: `server/templates/mcp.json` (copy it to `.mcp.json`) and `server/templates/coordinator.config.json`. The harness guards block the agent from writing either file.

## Storage (`.coordinator/`)

Secrets are **not** stored here; see "Secure directory" below. `cache/` (normalized tests) · `tests/<testKey>/{test,classification}.json` · `proposals/<P-YYYYMMDD-NNNN>.json` · `rule-proposals/<id>.patch` · `batches/<L-YYYY-MM-DD-NN>.json` · `approvals/<batchId>.json` (signed) · `decisions/decisions.jsonl` · `feedback/feedback.jsonl` (with feature snapshots) · `audit/audit.jsonl` (HMAC-SHA256 chain keyed with the out-of-repo audit key; `Store.verifyAudit()`) · `applied/<idempotencyKey>.json` · `budget/jobs.json` (local jobs/hour counter) · `projects/<projectId>/notes.md` · `reports/<projectId>/…` · `state/{context.json,counters.json,store.lock,apply.lock}`.

Writes are atomic: a temp file plus a rename, retried on Windows sharing violations. Mutations hold a single-writer lock. The lock is an O_EXCL lock file with stale takeover, and it is re-entrant within one async call chain.

### Secure directory (outside the repo)

`COORD_SECURE_DIR`, else `<COORDINATOR_HOME>/secret` when `COORDINATOR_HOME` (or a test home) is set, else `%APPDATA%\bim-coordinator` on Windows or `~/.config/bim-coordinator` elsewhere.

| File | Contents |
|---|---|
| `approval-key.json` | Approval HMAC key. DPAPI-protected (CurrentUser) on Windows; plain 0600 elsewhere or with `COORD_KEY_PROTECTION=none`, which the tests use. |
| `audit-key.json` | Audit-chain key. Same protection as the approval key. |
| `webauthn-credentials.json` | Passkeys (MAC'd). |
| `webauthn-enroll.json` | One-time enrolment code (hashed). |
| `aps-token.json` | Coordinator APS token cache. The single source for this path is `server/secure/aps-paths.ts`, shared by CLI login, MCP and API. |
| `browser-session.json` | Server-held refresh token for the browser session. |

**Limits:** DPAPI protects against other OS users and offline copies, not against processes of the same user (see Threat model).

### Clash ledger

`.coordinator/ledgers/<project>/<modelSet>.json` holds the per-model-set ledger (`core/ingest/ledger.ts`). Every ingest diffs against the previous cached version through `diffWithLedger`, which uses every older recorded version as history. The diff is stored in `tests/<testKey>/diff.json` and drives the UI delta chips and `diff_test_versions`. Clashes that reappeared are tagged `regresion` in the engine (`extraTags`). In fixtures mode the ledger is seeded once with version 40 from `tests/fixtures/mc/history-v40-clash-ids.json`.

## Lifecycles

- **Proposal** (`kind`: classification, group_action, issue_draft, status_change, rule_change): `draft → pending_review → approved | rejected | withdrawn`, then `approved → applied | failed`. `failed → applied` is a retry, and `approved → pending_review` happens when a batch is returned.
- **Batch** (lote): `ready` is created by "Enviar a aprobación" from the human decisions on a test. From there: `ready → approved` (HMAC approval) `→ applied | partial`. `ready → draft` (returned) and `→ discarded` are also possible.
- **Approval record**: `{batchId, projectId, modelSetId, testId, testKey, testVersion, proposalIds, itemIds, payloadHash, approvedBy{id,name,channel}, approvedAt, expiresAt, nonce, note?, dataSource, demo?, webauthn?{credentialId, nonce, origin, rpID, response}, hmac}`.
  - `payloadHash` covers each included item's MC operation, targets and the exact ACC body.
  - Apply and `verify-approval` re-check all of the following:
    - the HMAC;
    - the payload;
    - expiry;
    - that `testVersion` is still the latest;
    - the WebAuthn signature, re-verified against the challenge derived from the current payload. A demo approval is accepted only with the fixtures source.
    - a matching `batch.approved` audit event in an intact chain.
  - A real apply also needs a prior dry run of the same payload (`autonomy.requireDryRunBeforeApply`).
  - Every batch mutation and apply runs under one heartbeated batch lock (`state/apply.lock`), and verification happens inside the lock. An approved batch can't be edited; returning it to review deletes the approval.
- **Apply**: one `clashes:close` and one `clashes:assign` POST per test, each carrying many groups (chunked at `apply.maxGroupsPerRequest`). A local budget of `apply.jobsPerHourPerOperation` (default 200, ACC allows 250) applies per project and operation. Jobs are polled. Every request has an idempotency key. A timeout or network error during or after the POST marks it `unknown`. Before anything is resent, the request is **reconciled** with ACC: first the job status, then the assigned/closed clash groups of the test. If everything is present, it is marked applied; if nothing is, it is safe to send; if only part is, a human must check. `dryRun` (the default) returns the exact bodies.
- MC v3 has no "reviewed" write. `mark_reviewed` therefore closes with a tolerance reason (`MINIMAL_OVERLAP`), following the contract. `reopen` (and setting a status to active) is not applied from batches in v1: the item is created excluded, with a conflict note.

## HTTP API (`/api/coord/*`)

All JSON. Errors have the shape `{error:{code,message,hint?}}` with status 400/401/403/404/409/429/500.

Checks, in order, on every `/api/coord`, `/api/auth` and `/api/aps` request (Vite and standalone):

1. **Host** must be exactly `localhost:<port>`, `127.0.0.1:<port>` or `[::1]:<port>`. `X-Forwarded-*` is ignored. This is the anti DNS-rebinding check.
2. Every **non-GET** needs `Origin` exactly equal to `http://<Host>`; Referer is not accepted.
3. When the browser sends `Sec-Fetch-Site`, it must be `same-origin`.
4. **Human-only** endpoints (marked H) also need `X-Coord-CSRF: <token>`. The token comes from `GET /csrf`, which also sets the matching `coord_csrf` cookie (HttpOnly, SameSite=Strict).

**Honest limit:** these checks stop other websites. They do **not** stop a local non-browser client, which can forge headers. What proves a human approved is the WebAuthn user-verified signature.

The approver identity is the APS profile in live mode, else `approver.name` from the config. In fixtures mode it is "Coordinadora Demo".

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
| GET | `/projects/:projectId/model-sets/:modelSetId/tests` | – | `TestRun[]` (cached tests by test key with `state`, `documentCount` and ledger `delta{new,resolved,persisting}`, plus uncached ACC tests with `cached:false`, `state:"none"`; no ACC call per test) |
| POST H | `/projects/:projectId/model-sets/:modelSetId/tests/:accTestId/ingest` | `{refresh?, classify?, wait?}` | `IngestJob` (returned at once; `wait:true` = old synchronous `{testKey}`) |
| GET | `/ingest-jobs/:jobId` | – | `IngestJob` `{jobId, phase: downloading|clash_grid_ready|properties|classifying|done|failed, progress 0..1, message (es), testKey?, error?, timings}`. In memory: lost on restart (404). |
| GET | `/projects/:projectId/model-sets/:modelSetId/clash-grid?test=<testKey|accTestId>` | – | `ClashGrid` (`state: none|counts|classified`; cells are unordered pairs `a<=b`; groups/real/p1/needsReview are 0 until classified; `newSinceLast` from the ledger). A physical interference published twice (linked model inside another model) appears in more than one cell. |
| GET | `/projects/:projectId/model-sets/:modelSetId/views` | – | `ModelSetView[]` `{name, documents: fileName[]}` |
| GET | `/projects/:projectId/disciplines` | – | `DisciplineConfig` `{version, assignments, rules, codes (incl. SIN "Sin asignar"), fileNameDetection, pendingProposals}` |
| PUT H | `/projects/:projectId/model-sets/:modelSetId/documents/:lineageUrnB64/discipline?test=` | `{discipline, createRule?: {match, value, field}}` (path segment = base64url of the lineage URN; `UNK` accepted as `SIN`) | `ClashGrid` after re-classifying every cached test of the model set (no re-download) |
| PUT H | `/projects/:projectId/disciplines/rules` | `{rules: [{id?, match: contains|startsWith|regex, value, field: fileName|folder|viewName, discipline}]}` (ordered; replaces the list) | `DisciplineConfig & {reclassified}` |
| POST H | `/projects/:projectId/disciplines/preview` | `{rules}` | `DisciplinePreview` (matches per rule and how many it would actually decide; changes nothing) |
| POST H | `/projects/:projectId/disciplines/proposals/:proposalId/decision` | `{decision: accept|reject}` | `DisciplineConfig` (agent `discipline_mapping` proposals) |
| GET | `/projects/:projectId/assignees` | – | `Assignee[]` |
| GET | `/projects/:projectId/notes` | – | `ProjectNotes` |
| POST H | `/projects/:projectId/notes` | `{text, kind?}` | `ProjectNotes` |
| GET | `/triage/:projectId/:modelSetId?test` | – | `TriagePayload` |
| GET | `/triage/:projectId/:modelSetId/changes?test&since` | – | `TriageChanges` |
| GET | `/tests/:testId/families` | – | `FamiliesPayload` `{testId, families: TriageFamily[], problemTypes}` (also in `TriagePayload.families`) |
| GET | `/tests/:testId/families/:familyId` | – | `TriageFamily` (instances with inheritance state) |
| POST H | `/families/:familyId/decision-preview` | `{testId, validity?, action?, issueMode?}` | `FamilyDecisionPreview` (no change) |
| POST H | `/families/:familyId/decision` | `FamilyDecisionRequest` (`approve` needs `spotChecked` ≥1, ≥3 when > 50 unique; `acknowledgeValidityChanges` when instances change validity; real is never closed) | `TriageFamily` (new decision version) |
| POST H | `/families/:familyId/exceptions` | `{testId, groupId, fields, reason}` | `TriageFamily` |
| DELETE H | `/families/:familyId/exceptions/:groupId?testId` | – | `TriageFamily` |
| POST H | `/families/:familyId/confirm-inherited` | `{testId, groupIds?}` | `TriageFamily` |
| POST H | `/families/:familyId/detach` | `{testId, groupId}` | `FamiliesPayload` |
| POST H | `/families/merge` | `{testId, from, into}` | `FamiliesPayload` |
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
| GET H | `/webauthn/approve-options?batch&exclude` | – | `ApproveOptionsResponse` |
| POST H | `/batches/:batchId/approve` | `ApproveRequest` (`confirmWord` APLICAR/APPLY when issues > 0 or changes ≥ 50; live: `webauthn{nonce,origin,response}`; fixtures: `demo:true`; unknown keys such as `apply` → 400) | `ApplyStatus` (never applies) |
| GET H | `/webauthn/register-options` | – | `RegisterOptionsResponse` |
| POST H | `/webauthn/register` | `RegisterRequest` | `{credentialId,label,enrolledVia}` |
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

## Browser approval flow (for the UI, coder D)

Use `@simplewebauthn/browser`, pinned to the same major version as the server (14.0.x). The RP ID is `localhost`, so open the UI as `http://localhost:3000`, not `127.0.0.1`. Browsers reject IP addresses as an RP ID.

**Enrol once (first passkey):**
1. The coordinator runs `npm run coordinator -- passkey-enroll` in their own terminal. The command refuses to run under Claude Code or without a TTY, and prints a 10-character code that is valid for 10 minutes and works once.
2. The UI (Ajustes → Passkey) calls `GET /api/coord/webauthn/register-options`. When `requires` is `"enroll_code"`, it asks the user for the code.
3. `const resp = await startRegistration({ optionsJSON: r.registration })`. This prompts Windows Hello.
4. `POST /api/coord/webauthn/register` with `{ response: resp, enrollCode, label }`.

**More passkeys:** `requires` is `"step_up"`. First call `startAuthentication({ optionsJSON: r.stepUp })`, then `startRegistration({ optionsJSON: r.registration })`, then POST `{ response, stepUp, label }`.

**Approve a batch (live):**
1. Make sure a preflight newer than 10 minutes exists: `POST /batches/:id/preflight`. Apply exclusions first with `PATCH /batches/:id/items`.
2. `const o = await GET /api/coord/webauthn/approve-options?batch=<id>&exclude=<csv>`. The challenge is derived from the exact payload, and the nonce lasts 2 minutes and works once.
3. `const assertion = await startAuthentication({ optionsJSON: o.options })`. User verification is required, which means a PIN or biometrics.
4. `POST /batches/:id/approve` with `{ confirmWord, excludedItemIds: <same as step 2>, webauthn: { nonce: o.nonce, origin: location.origin, response: assertion } }`. The server replaces `origin` with the request Origin.
5. Applying is a separate call: `POST /batches/:id/apply { dryRun: true }`, show the bodies, then `{ dryRun: false }`. A real apply without a prior dry run of the same payload is refused.

**Fixtures mode:** skip WebAuthn and send `demo: true`. Show a visible "Aprobación de demostración" label. The live data source refuses demo approvals.

If any edit happens after step 2 (exclusions, issue text), the approve call is refused. Ask for new options.

**Browser APS session:** `POST /api/auth/callback {code}` and `POST /api/auth/refresh` return only `{access_token, token_type, expires_in, scope}`, with no `refresh_token`. The server keeps the refresh token and downscopes to `data:read viewables:read` (`APS_BROWSER_SCOPE` overrides this). Any `refresh_token` the client sends is ignored. The `/api/aps` proxy is GET-only and allowlisted to `/project/v1`, `/data/v1`, `/modelderivative/v2/(regions/eu/)designdata`, `/derivativeservice/v2`, `/bim360/modelset/v3` and `/construction/index/v2`.

## CLI and approvals

- `approve <batchId>` works only in fixtures mode, as a demo approval. It needs a TTY and is refused when `CLAUDECODE` exists, even if empty. **In live mode the CLI cannot approve.** Use the web UI with a passkey.
- `verify-approval <batchId> --json` is read-only. It exits 0 with `{"valid":true,batchId,approvedBy,expiresAt,testVersion,itemCount,proposalCount}`, else exits 1 with `{"valid":false,"reason"}`.
- `passkey-enroll` is described in the enrolment steps above.

## Threat model (v1)

- **In scope:** model error; prompt injection through model or ACC text; an agent misusing its tools; other websites in the coordinator's browser (CSRF, DNS rebinding); accidental double application.
- **Out of scope for v1:** a malicious process running as the same OS user. It can call DPAPI, read the keys, rewrite the store and the credential list (including registering its own software authenticator), or patch the code.
- **Roadmap:** run the server as a separate OS user or service that owns the secrets and the store.

## MCP server `coord`

There are 34 tools, with names and inputs as in `docs/ai/mcp-tool-contracts.ts`. Outputs are one compact JSON envelope `{ok,data?,error?,truncated?,hint?}` capped at `agent.maxResponseTokens` (6,000 tokens × 4 chars); when the cap is hit, the largest array is cut. Model-derived text is returned as `{untrusted, flagged?}`, sanitised and limited to 120 characters; this covers group labels, element family/type/system, rule rationales and document names. Agent-written text is rejected when it contains URLs outside `issues.urlAllowlist`, emails, @mentions, control characters, or G-/C-/E-/P- ids that do not exist. Every tool call is audited (`tool.call`). No tool can approve. `apply_approved_proposals` takes `{batchId, dryRun=true}` and refuses without a valid HMAC approval.

### MCP deviations from `docs/ai/mcp-tool-contracts.ts`

- Proposal kinds and states follow the store. The kind is `issue_draft`, and the states are `draft | pending_review | approved | rejected | withdrawn | applied | failed`. `list_proposals` still accepts `issue`, `pending`, `superseded` and `applying` as aliases.
- Proposals are not auto-added to a draft batch, so `ProposalCreated` has no `batchId`. Batches are built from the coordinator's decisions in the UI.
- `ClashId` also accepts a `C-` prefix. MCP outputs use bare MC ids, while the HTTP API uses `C-<id>` because the UI expects it.
- `evaluate_ruleset`: `rubricScore` is 100 × the share of asserted EV fields that match. The eval-scenarios "Agent rubric" is not implemented in code. `macroF1` is an extra metric. `fixtures` = diff accuracy of v41 → v42 against `fixture-truth.json`.
- `generate_report` with `format: "xlsx"` returns a `validation_error` in v1. Use md or html.
- `get_group.label`, `list_groups.label` and `topPersistingGroups.label` are `Untrusted`, not plain strings, because engine titles embed family, type and system names (orchestrator ruling).
- `ingest_clash_test.counts` also includes `byStatus`.
- Extra error codes: `not_classified`, `invalid_state`, `conflict`.
- Extra tools: `list_disciplines` (read; project mappings + per-document resolution with `source`, `share`, `ruleId`, `suggestedToken`) and `propose_discipline_mapping` (level ≥ 1; creates a `discipline_mapping` proposal; a human accepts it in the UI, the agent never changes mappings).

- `propose_rule_change` takes `feedbackIds` OR `evidence` (at least one): `evidence = {kind: "real_data_evaluation", testKey, summary ≤ 1500, metrics: {changedUnique, changedMc, validityBefore, validityAfter, groupsBefore, groupsAfter, needsReviewBefore, needsReviewAfter, unsafeClosures, scenariosPassed, scenariosTotal}}`; `evaluation` also accepts those numeric metrics. `unsafeClosures > 0` (real conflicts closed without human review) is refused at registration. `GET /rule-suggestions` returns `evidence` and `feedbackCount`.
- New clash fact for rules: `sameOriginFile` (both elements originate in the same file lineage, resolving linked copies; `core/pipeline.ts`).

### M1: ACC sync, scope guard, "Qué cambió"

- **X1 (ACC wins, D8):** every ingest, cached ones included, reads ACC (read-only):
  - `GET tests/{t}/clashes/assigned|closed` gives the existing and resolved clashes per group.
  - It is joined with `modelsets/{m}/clashes/assigned|closed` for the issueId and the close reason.

  The result is stored in the ledger (`entries[id].acc`, `accSync[version]`). It is projected as `acc` on groups, family instances and families, and as `TriagePayload.accSync`. A clash ACC already assigned or closed is never proposed again (no action, no draft) and never goes into a batch item. Fixtures: `tests/fixtures/mc/v{N}/acc-groups.json`.
- **X6:** documents are matched by lineage, because MC renumbers `documentId` between versions. Each version detects:
  - `document_added` and `document_removed`;
  - `model_replaced`: the same file name with a new lineage;
  - `test_config_changed`: another model set view, or another viewable of the same lineage;
  - `mass_resolution`: more than 30 % of one document's clashes gone at once, checked only for documents with at least 50 clashes.

  Previous clashes of an affected document that would count as resolved become `out_of_scope` in the diff and the ledger, and are never counted as resolved. They are exposed in `TriagePayload.scopeChanges` and `changeSummary.outOfScope`.
- **Qué cambió:** `ClashGroup.change`, `FamilyInstance.change`, `TriageFamily.changeCounts` and `TriagePayload.changeSummary`, all against the previous cached version.
  - Per raw clash: `new`, `reappeared` (from the ledger), `changed` (|Δpenetration| > 10 mm or different element types), otherwise `unchanged`.
  - Per item: reappeared if any clash reappeared; new if every clash is new; changed if any clash is new or changed; otherwise unchanged.

### Performance

- **Compression:** JSON responses of 8 KB or more are compressed when the client accepts it (`br` quality 4, else `gzip` 6), with `Vary: Accept-Encoding`.
- **Triage memo:** `GET /triage` is memoized per test. The key is the mtime and size of every file it reads (classification, the test records of the model set, diff, decisions, proposals, batches, questions, family decisions, ledger, disciplines) plus a 1-minute bucket. The serialized and compressed bytes of a memoized payload are reused.
- **Short caches:** ACC reads (project, model sets, remote tests) are cached for 30–60 s; the APS user for 60 s, and logout clears it.
- **Classification reads** are cached in-process, validated by mtime and size.

### M2: decision memory, questions, capture

- **F1 inheritance:** the ledger stores a decision reference per clash for HUMAN and FAMILY decisions (`entries[id].decision`: source, ref, decision, validity, effect, decidedAtVersion, decidedBy, penetrationMm, elementTypes); ACC state stays in `entries[id].acc`. Rule verdicts are recomputed and never stored.
  - A group with no decision of its own inherits `ClashGroup.inherited`: ACC state first (D8), then its family`s approved decision from an earlier version (pending instances get `needsConfirmation`), then the earlier human decision. A human decision is inherited only when every clash carries it and is unchanged (|Δpenetration| ≤ 10 mm, same element types).
  - A closure is never inherited by a `real` group, and a postponement is never inherited.
  - Inherited groups count as decided (`reviewState: "decided"`), unless they need a confirmation.
- **Baseline:** "Qué cambió" compares against the newest older version with at least one human decision (accept/correct/reject) or an approved batch; otherwise against the previous cached version (`changeSummary.baseVersion`, `baseReason`).
- **X3 questions** (`.coordinator/questions.json`):
  - MCP `ask_coordinator` and `list_questions`; HTTP `GET /tests/:testId/questions` and `POST H /questions/:questionId/answer` (`QuestionAnswerRequest`).
  - A validity or action answer becomes human decisions on the question`s groups; an `other` answer is stored for the next agent run.
  - When a newer version is ingested, an open question whose clashes changed (gone, or |Δpenetration| > 10 mm) becomes `stale`.
- **Agent shapes** (used by `/preparar-ciclo` and `/acta`):
  - `ingest_clash_test` and `run_classification` return `cycle: {baseVersion, baseReason ("last_reviewed" | "previous" | "first_cycle"), counts: {new, changed, reappeared, unchanged, inherited} (groups), clashCounts, needsReview, scopeChanges, accSync}`.
  - `list_families` takes `delta[]` (new | changed | reappeared | unchanged | inherited) and `needsReview`, and returns `delta` and `needsReview` columns.
  - `get_family` and `get_group` return `humanReview` (still needs a human), `delta {state, deltaPenetrationMm, typeChanged}` and `previousDecision {source, version, validity, action}`.
- **Capture:** reason codes V01–V05 are accepted on decisions. Every proposal view carries `origin: "engine" | "agent"`.

### Solution families

`docs/domain/solution-families-proposal.md` (signature v6) is implemented in `core/families` (pure, per unique clash) and `server/families.ts`. Every group and clash carries `familyId`, `problemType` and `signature`; a group whose members have more than one signature is split (invariant 8; the dominant part keeps the id). Families are stored with the classification; human decisions live in `.coordinator/projects/<p>/model-sets/<m>/families.json` (versioned, audited) and carry over to later tests. Instances present when a decision was taken are `inherited`; new ones are `inherited_pending` until a human confirms them and are never put in a batch automatically. `POST /batches` turns an approved family into ONE assign (issue `[F-xxxx] …`, description ≤ 1,000 chars with locations by level, chunks of 1,000 clashes) or ONE close; `issueMode: per_instance` gives one assign per instance; a later cycle produces a follow-up `[F-xxxx · ciclo vN]`. Batch items list `validityChanges`. MCP: `list_families`, `get_family`, `propose_family_decision` (proposal only).

### Document discipline

Precedence: user assignment (by lineage URN) > first matching user rule (case- and accent-insensitive) > discipline matrix file-name tokens (only when `disciplines.fileNameDetection` is `"matrix"`; default `"off"`) > dominant element discipline with share ≥ 80 % > `SIN`. Element disciplines come from the Revit category (`rules/discipline-matrix.yaml` category defaults); pipes and plumbing need a system classification, otherwise they stay `SIN`. Mappings are stored in `.coordinator/projects/<projectId>/disciplines.json` (versioned; every change audited with before/after hashes). Outputs never show `UNK`.
