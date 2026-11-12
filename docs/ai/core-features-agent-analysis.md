# Core features: agent / engine / human split

Owner: AI specialist (agent design, harness, MCP). Input: [`docs/PLAN-core-features.md`](../PLAN-core-features.md) (the brief).
Status: analysis, 2026-11-09. No code changed. Scope: how to build F1–F5 with the least agent surface.

**Rule of thumb used throughout:** if a step can be written as an `if`, it goes to the engine/server.
The LLM is used only for (a) judgment on `humanReview` items, (b) reading free text written by people
(ACC comments, meeting notes), (c) Spanish wording that a template can't do well. The human decides
everything that reaches ACC, in the web UI.

Facts checked in code that shape this analysis:
- Reason codes are **already mandatory** on `correct`/`reject` decisions and already feed `record_feedback`
  (`server/coordinator-ui.ts` `saveDecisions`). Decisions only target `group | clash` today.
- `BatchOperation` already lists `issue.update | issue.comment` (`server/store/types.ts`), but `WriteOperation` in
  `server/aps/write-guard.ts` is still `clash.assign | close | reopen`. `server/aps/issues.ts` is read only.
- ACC assigned/closed group reads exist (`server/aps/clash.ts`), so X1 is wiring, not new API work.
- The ledger (`core/ingest/ledger.ts`) stores states per version but no decision reference yet (F1 needs it).
- 32 MCP tools. `list_*`, `get_*`, `propose_*` are allowed by glob in `.claude/settings.json`; any other new
  tool name needs a settings edit (dev mode).
- v2 hooks are staged, not installed. Installed v1 `guard-apply` fails the `dryRun:"false"` string case.

---

## 1. Per feature: deterministic / agent / human

### F1 Decision memory
| Deterministic (engine) | Agent (LLM) | Human (UI) |
|---|---|---|
| All 7 states, Δpenetration, type/system change, the 5 inheritance rules, ruleset-change re-classification, `regresion` tag and band +1, "heredado de vNN" badge data, `element_deleted` questions | Only `persisting_changed` / `reappeared` items that **still** come out `humanReview` after the engine re-runs (existing `clash-triager`, with previous decision + delta in `get_group`/`get_family`) | "Qué cambió" filter; confirm `pendiente de confirmación` inheritances (Enter, or reason code) |

Flag: the brief sends all `persisting_changed` and `reappeared` to the agent. Re-run the rules first; most
"deeper by 30 mm" cases re-classify deterministically. Send to the agent only what the review policy still flags.

### F2 Issue verification
| Deterministic (engine/server) | Agent (LLM) | Human (UI) |
|---|---|---|
| The 4-way verdict (proponer / avance / reabrir / no verificable), displacement check, model-age check, scope-change block (X6), **creating the `issue_update` proposals** (like `proposeAutoAccepted`), the **evidence comment from a template** ("Verificación v43: 0 de 120 interferencias persisten; sin desplazamiento a elementos vecinos; modelo SAN actualizado en v43."), the "closed in ACC but `existing` ≠ ∅" contradiction | One-line explanation **only** for regressions on agenda families (P1/P2), appended in the delivery report or as an X3 question | Approve/reject each transition in "Verificación" with V01–V05; pick `in_review` vs `closed` where allowed |

Flags: (1) "Agent writes the evidence comment in Spanish" → a template is exact, cheaper and auditable;
numbers in a comment that goes to ACC should never come from an LLM. (2) "Flags contradictions with ACC
status" → that is `status ∈ {closed, in_review} ∧ existing ≠ ∅`, a rule.

### F3 Solution families (built)
| Deterministic | Agent | Human |
|---|---|---|
| Clash point/orientation/ruleId in payload, level normalization (project level map), title stop-list, solution catalogue in `rules/` | Review `humanReview` families, propose merge/split/detach (existing tools); `issue-writer` fills from family decision + catalogue | Approve family (spot-check modal), R07 with axis, R13 title edits |

No agent change. Titles must be fixed in the engine (stop-list + level map), not by the LLM rewriting titles.

### F4 Meeting pack + `/acta`
| Deterministic | Agent | Human |
|---|---|---|
| Agenda order and content per discipline (regressions → P1 → overdue → new → F2 transitions), counts per discipline, viewpoint selection (worst instance), dueDate validation | `/acta`: read notes (untrusted human free text) → `propose_family_decision` drafts, due dates **only with a verbatim quote**, ambiguous → X3 question | Capture viewpoints in the browser, type notes in the meeting, approve drafts and pick the ACC assignee |

Flags: (1) "`/preparar-ciclo` writes a short summary per discipline" → counts are a table; the server renders
it. Keep LLM narrative only in `/informe-semanal`. (2) Due dates: the server rejects a `dueDate` unless the
proposal carries `dueDateQuote` and that quote is a substring of the stored note. This makes "0 invented
dates" a rule instead of a prompt hope. (3) "Never close a `real` from minutes" is already enforced server
side for family decisions; keep it there, not in the skill.

### F5 Follow-up
| Deterministic | Agent | Human |
|---|---|---|
| Which issues have a **new** comment since the last run, PII/URL stripping, instruction-like prefilter (regex), contradiction = `replyClass=fixed ∧ existing ≠ ∅`, "P1 stuck 2 cycles", reminder draft per discipline from a template (list of issues + counts) | Classify the last new comment: fixed · question · dispute · no reply (no-reply is deterministic: no comment), and flag instruction-like text | Correct the class (1 keystroke), copy/send reminders, decide escalations |

Flags: (1) The `escalate` proposal is a rule ("P1, open, `existing` ≠ ∅ for ≥ 2 cycles") → a flag on the
Seguimiento page and on the agenda, not a proposal kind. (2) Reminder drafts are lists; a template is enough.
(3) "No reply" needs no LLM.

**Net LLM work per cycle:** `humanReview` triage (exists), issue descriptions (exists), comment classification
(new, small), `/acta` notes → proposals (new), occasional regression explanation and questions.

---

## 2. Minimal new surface

### MCP tools: +3 (32 → 35)
| Tool | Type | Why it can't be an extension |
|---|---|---|
| `list_issue_checks` | read (auto-allowed by `list_*`) | One paged table per family issue: ACC status, `existing`/`resolved`, engine verdict + blocked reason, flags, and the last **new** comment (`untrusted`, redacted, ≤ 500 chars). Serves F2 and F5. |
| `ask_coordinator` | local write | X3 for questions only the agent has (engine-made questions need no tool). Input `{ familyId?/groupId?, clashIds?, question ≤ 300, options? }`. |
| `classify_issue_replies` | local write | Batch `{ issueId, replyClass, suspicious: bool, paraphrase ≤ 120, no names }[]`. Enum validated by the server. |

Extensions instead of new tools:
- `run_classification` / `ingest_clash_test`: also run X1 sync, X6, F1 states, F2 verdicts; return counts
  (`inherited`, `changed`, `reappeared`, `transitionsProposed`, `questions`). Engine creates `issue_update` proposals.
- `list_groups` / `list_families`: `filter.delta` (`new|changed|reappeared|pending_confirmation`), `filter.hasNotes`.
- `get_group` / `get_family`: `previousDecision` (source, version, ruleId) + delta; `meetingNotes` (untrusted).
- `propose_family_decision`: optional `dueDate` + `dueDateQuote`, `fromNotes: true`.
- `generate_report`: `kind: "agenda" | "reminders"` (server numbers, optional narrative) instead of new tools.
- **No `propose_issue_update` tool.** Only the engine creates `issue_update` proposals. This keeps the context that
  reads ACC comments unable to propose any ACC write (see §4). Add the tool later only if a real need appears.

Context budget: +3 tool specs ≈ 1–1.5 k tokens per session. Keep descriptions ≤ 2 lines; table outputs;
`maxResponseTokens` cap applies. Skills list `allowed-tools` so each flow sees only its tools.

### Proposal kinds: +1
- `issue_update` `{ issueId, fromStatus, toStatus?, comment?, evidence: { version, existing, resolved }, issueUpdatedAt }`.
  Progress-only comments are the same kind with no `toStatus`. Nothing else: `escalate` is a flag, questions
  are their own store (X3), reply classes are annotations, `/acta` output is `family_decision`.
- `DecisionRecord.targetType`: add `family | issue` so F2/F5 rejections record reason codes like today.

### Skills and agents
- **`/preparar-ciclo` replaces `/coordinar-test`** (one skill, auto mode). If the ledger has no previous version
  it runs today's first-test flow; otherwise it adds F1/F2/F5 steps. Keep `coordinar-test/SKILL.md` as a 3-line
  pointer for one release, then delete. Two skills doing 80 % the same steps drift apart.
- **`/acta` stays its own small skill** (≈ 15 lines), not a mode: it runs on a different day, reads a different
  untrusted source, and "`/acta`" is the name coordinators will remember. It reuses `propose_family_decision`,
  `ask_coordinator` and `issue-writer`; no new agent. (A mode `/redactar-issues acta` would also work; no strong cost either way.)
- **One new subagent `issue-reader`** (haiku or sonnet), tools: `list_issue_checks`, `classify_issue_replies` only;
  no proposal, Read, shell or web tools. It is the only context that ever sees comment text; the main agent
  receives classes and counts. This is the cheapest real guard for F5 (§4).
- Unchanged: `/triage`, `/redactar-issues`, `/informe-semanal`, `/auditar-modelo`, `/curar-reglas`, `clash-triager`, `issue-writer`.
- Eval scenarios: `/acta` notes set (0 closures of `real`, 0 dates without quote, 0 names), injected comment set,
  displaced-clash and removed-document fixtures.

---

## 3. The coordinator's loop (2 commands per cycle)

**D-1, after the new version is published in ACC**
1. Claude Code: `/preparar-ciclo` (or `/preparar-ciclo <proyecto> <conjunto>` the first time).
   Engine: ingest + X1 sync + X6 + classify + families + F1 states + F2 proposals + engine questions.
   Agent: `clash-triager` on what is still `humanReview`; `issue-writer` for new real families; `issue-reader` on
   new comments. Ends with the ≤ 25-line report and the UI link.
2. UI: Triage "Qué cambió" → answer "Preguntas del agente" → approve families → "Verificación" (transitions)
   → "Seguimiento" (contradictions, copy reminders) → "Preparar reunión" (viewpoints, print/export pack).
3. `/aprobaciones`: approve the batch. In Claude Code: "aplica el lote L-…" (dry run, then confirm). This is a
   confirmation, not a new command.

**Meeting:** notes per family/instance in the UI.

**D+1**
4. Claude Code: `/acta`. UI: approve family decision drafts, pick assignees, approve batch, apply as in step 3.

Optional: `/informe-semanal` for management. Everything else is on demand.

---

## 4. Safety: minimal guardrails, reusing what exists

**ACC write `issue.update` (D3)**
- Same single door: `apply_approved_proposals` on a human-approved batch. **No new write tool, so no new hook
  matcher**; `guard-apply` already covers it. Add `issue.update` (and `issue.comment` if O-3 allows) to
  `WriteOperation`; tokens stay bound to the body hash, single use.
- Server preflight at apply (not in hooks): GET issue → refuse if `updatedAt` ≠ proposal's `issueUpdatedAt`,
  if `toStatus` ∉ `permittedStatuses`, or if `toStatus = closed` and the project config does not enable it.
  Dry run lists each `from → to`; audit logs before/after (existing).
- Per-item confirmation: reuse the batch rule (> 50 items, `critical`, `seguridad_personas`).
- D4: make `propose_status_change` description say "reopen = closed clash group, **never** an issue" and have the
  server refuse a `status_change` that targets an issue-linked group for issue purposes. UI labels must not use
  "reabrir" for both.
- Only the engine creates `issue_update`; the agent cannot. Prompt injection in a comment therefore has no path to an ACC write.

**Comment reading (F5)**
- Server: fetch only new comments, strip emails/@mentions/URLs/phones, truncate, mark `untrusted`, regex prefilter
  for instruction-like text (sets `suspicious` even if the LLM misses it).
- Only `issue-reader` sees the text; its output is an enum + bool + short paraphrase; server rejects anything else.
- Reminders are generated by the server from enums and counts, so no comment text flows outbound.
- Comment text never goes to `notes.md`, feedback or eval cases (rule 7); eval fixtures use synthetic comments.

**Harness prerequisites**
- **Install v2 hooks before M3** (`npm run coordinator -- setup`, human, shows the diff). v1 has the
  `dryRun:"false"` gap; a new write type should not ship on v1.
- In `harness-staging/` (dev mode `COORD_HARNESS_DEV=1` set when Claude Code starts): add
  `server/aps/write-guard.ts` and `server/aps/issues.ts` to `guard-apply`'s git-integrity path list; add allow
  entries for `ask_coordinator` and `classify_issue_replies`; add the two skills and `issue-reader`.
  Run `HOOKS_DIR=harness-staging/.claude/hooks npx vitest run tests/hooks.test.ts`, then setup.
- O-7 (Procedimiento Acceso Herramientas IA covers sending model data and comments to Claude) must be closed
  before F5 runs on real projects.

---

## 5. Learning capture: now vs later

**Now (near zero cost, mostly enum and field additions):**
- Add V01–V05 to `REASON_CODES` (types, router zod enum, i18n `reasons.*`). The "reason required on
  reject/correct" rule already exists; extending `targetType` to `family | issue` makes it cover F2/F5.
- R07 `axis` (`level | system | owner | severity`): one optional field on the decision, one keystroke.
- Reply-class corrections: a normal `correct` decision with `changes[{ field: "replyClass" }]`; no new record.
- Ledger decision ref (`source, ruleId, rulesetVersion, decidedAtVersion`): needed by F1 anyway; it is also the F1 learning signal.
- `/acta` edits: R13 diffs are already automatic for drafts; same path for family drafts from notes.
- Keep proposals tagged `createdBy: engine | agent` so acceptance can be split later.

**Defer (computable later from the append-only decision log, no data lost):**
- The per-feature metrics module and its display on `/reglas` and `/informe-semanal` → after ≥ 3 real cycles.
  The existing reason-code counts are enough until then.
- Promotion gates, L2 policies, auto-downgrade → out of scope by D2.
- `notes.md` glossary automation for F4/F5 → the existing "propose a line, write after confirmation" flow is enough.

---

## 6. Cut or defer

| Item | Decision | Reason |
|---|---|---|
| Two skills `/coordinar-test` + `/preparar-ciclo` | Merge into one | Same steps; two prompts drift and double eval cost. |
| LLM evidence comments (F2) | Template | Numbers going to ACC must be exact and auditable. |
| `escalate` proposal (F5) | Rule flag | "P1 stuck 2 cycles" is a condition, not a judgment. |
| LLM reminder drafts (F5) | Template | A list per discipline needs no prose. |
| LLM per-discipline agenda summary (F4) | Server table | Counts; narrative already lives in `/informe-semanal`. |
| `propose_issue_update` agent tool | Defer | Engine creates them; keeps comment readers away from writes. |
| Screenshots to ACC (`POST screenshots` at creation) | Defer | Another write path; the assign pushpin viewpoint is enough for the pilot. |
| Custom HTML pack exporter | Browser print of "Preparar reunión" | Same result, no exporter to maintain. |
| Reply classification of every open issue each run | Only new comments | Old comments were already classified; cost and exposure scale with comment volume. |
| Grid location spike (F3.5) | Defer | Depends on clash points and O-5; level grouping works. |
| Merge/detach drag interactions | Defer | Agent proposals + approve already cover it. |
| X3 "answer becomes proposal immediately" for every answer type | Only validity/action answers | Other answers just wait for the next run, as the brief says; no extra machinery. |
| §9 metrics module, gates, promotion | Defer | Raw decisions suffice; compute once there is data. |
| Per-discipline scorecard | Already out | Needs BIM-manager sign-off (O-6). |
