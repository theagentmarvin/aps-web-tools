# Harness design: BIM clash-coordination agent

Owner: AI specialist. Status: **two-agent model (WS-S, 2026-11-11).** This document is the rationale and the index. The files it points to are the source of truth. Where code and this doc disagree, the code wins and this doc is the bug.

Binding inputs:
- `docs/PLAN.md` and the orchestrator decisions of 2026-11-06 (§9); product decision of 2026-11-11 (two agents).
- Domain specs: `docs/domain/clash-taxonomy.md`, `clash-triage-methodology.md`, `grouping-strategies.md`, `issue-writing-guide.md`, `eval-scenarios.md`.
- APS facts: `docs/research/aps-model-coordination-api.md`.

No LLM is called from app code: both agents are Claude Code. There are **two agents with two harnesses**:

| | **In-app agent** (coordination) | **Dev agent** (VS Code, this repo) |
|---|---|---|
| Who uses it | Coordinators, inside the app: the chat panel and the flows ("Qué sigue" → Ejecutar) | Coordinators / developers who open the repo in VS Code and ask for improvements |
| What it does | Uses the app through the `coord` MCP tools: proposals, questions, drafts, rule suggestions, reports. **Never changes the app** | Edits code, tests, docs and the in-app agent's instructions; runs typecheck + tests; commits after the coordinator's OK |
| Source | `agent-runtime/` (shipped as app code: `CLAUDE.md`, `agents/`, `skills/`, `hooks/`, `settings.json`) | `dev-harness/` (activated once by a human with `scripts/activate-dev-harness.ps1` into the root `CLAUDE.md`, `.claude/`, `.mcp.json`) |
| Where it runs | `claude -p --agent …` spawned by the server with `cwd` = the materialised runtime folder (§1.1) | `claude` / VS Code in the repo root |
| `coord` MCP | Explicit `--strict-mcp-config --mcp-config` (server code of the real app, the app's data home, mode `chat` or `flow`) | `scripts/dev-mcp.mjs`: fixtures in a temp data home; `COORD_DEV_LIVE=1` = live, read-only tools |
| Guardrails | Tool lists (agent front matter ∩ server `--allowedTools` / `--disallowedTools` / `--tools`), MCP modes, runtime settings + hooks (§4.2–4.3) | Minimal hooks: deny real data / backups / secrets / apply; ask before editing the active guard (§4.4) |
| Updating it | Edit `agent-runtime/` and restart the app — no install step, no passkey | Edit `dev-harness/`, a human re-runs the activation script |

| Piece | File(s) | Role |
|---|---|---|
| In-app constitution | `agent-runtime/CLAUDE.md` | Spanish persona, hard rules 1–10, procedure, taxonomy |
| In-app agents | `agent-runtime/agents/{coordinador-chat,coordinador-flujos,clash-triager,issue-writer,model-hygiene-auditor,rules-curator}.md` | Chat (one turn per message), flows (one procedure per run), subagents with allow- and deny-lists |
| Flow procedures | `agent-runtime/skills/{preparar-ciclo,triage,acta,redactar-issues,informe-semanal,auditar-modelo,curar-reglas}/SKILL.md` | Read by `server/flows/agent.ts` `skillBody` and passed in the flow prompt (`docs/domain/next-steps-and-flows.md`) |
| In-app guardrails | `agent-runtime/settings.json`, `agent-runtime/hooks/*.mjs` | §4.3. Tested by `tests/server/agent-runtime.test.ts` |
| Runtime materialiser | `server/agent-runtime.ts` | §1.1 |
| Dev harness | `dev-harness/{CLAUDE.md,.mcp.json,.claude/settings.json,.claude/hooks/*,.claude/skills/mejorar/SKILL.md}`, `scripts/dev-mcp.mjs`, `scripts/activate-dev-harness.ps1` | §4.4. Tested by `tests/hooks.test.ts` |
| Tools | `server/mcp/` (server `coord`) | Contract in `server/mcp/contracts.ts` (modes main / chat / flow) |
| Engine | `core/` (`core/pipeline.ts`, `core/group/review.ts` `DEFAULT_REVIEW_POLICY`) | Deterministic volume work (§3) |
| Policy | `coordinator.config.json` (+ git-ignored `.local`; defaults in `server/templates/`) | Autonomy level, `foreignMcp` policy (§4) |
| Memory | `<data home>/projects/<projectId>/notes.md` (path in `get_session_status.projectNotes`), feedback store | §5 |
| Evals | `scripts/eval.ts` (E1), `scripts/eval-agent.ts` + `evals/` (E2/E3; agent runs use the materialised runtime) | §7 |

**Defence in depth.** The MCP server is the security boundary: it holds the token and verifies approvals before any ACC write (`server/aps/write-guard.ts`). For the in-app agent the second line is the tool lists the server passes on every spawn (tested permission matrix) and the MCP mode (`chat` / `flow` have no apply); runtime settings and hooks are the third. `CLAUDE.md` is context, not enforced configuration.

---

## 0. Verified platform facts

| Fact | How it was verified |
|---|---|
| **Subagent frontmatter.** Fields: `name`, `description`, `tools`, `disallowedTools`, `model` (`sonnet`/`opus`/`haiku`/`inherit`/ID), `maxTurns`, `skills`, `mcpServers`, `hooks`, `permissionMode`, `omitClaudeMd`…. Subagents inherit MCP tools. `disallowedTools` is applied before `tools`. | https://code.claude.com/docs/en/sub-agents |
| **SKILL.md frontmatter.** Fields: `name`, `description`, `argument-hint`, `allowed-tools`, `disable-model-invocation`, `context: fork`, `agent`, `background`; `$ARGUMENTS` is substituted. | https://code.claude.com/docs/en/skills |
| **Hook I/O.** Stdin carries `tool_name`, `tool_input`, `agent_id`/`agent_type`. `agent_type` is present inside subagents **and** when the session uses `--agent`. Exit 2 blocks. The PreToolUse JSON is `hookSpecificOutput.permissionDecision`. SessionStart accepts `hookSpecificOutput.additionalContext`. Exec form with `args` and `${CLAUDE_PROJECT_DIR}` (= the session's project folder; for the in-app agent, the runtime folder). Matchers with non-word characters are unanchored JS regex. | https://code.claude.com/docs/en/hooks |
| **Hook vs permission precedence.** A hook `allow` never bypasses `deny`/`ask` rules. MCP permission rules with parentheses are skipped. Committed `allow` rules wait for workspace trust; `deny`/`ask` apply immediately. | https://code.claude.com/docs/en/permissions |
| **MCP output limits and naming.** Claude Code warns above 10k tokens and caps at 25k (`MAX_MCP_OUTPUT_TOKENS`). Tools are named `mcp__<server>__<tool>`. | https://code.claude.com/docs/en/mcp |
| **CLAUDE.md.** `@path` imports, max depth 4, skipped inside code spans. Target under 200 lines. | https://code.claude.com/docs/en/memory |
| **`CLAUDECODE` env var** is set in tool subprocesses. The approval CLI and the activation script refuse when they see it. | Observed in this session's Bash environment |
| **`claude -p` flags used** (Claude Code 2.1.267): `--agent`, `--output-format stream-json --verbose`, `--include-partial-messages`, `--permission-mode dontAsk`, `--tools`, `--allowedTools`, `--disallowedTools`, `--strict-mcp-config`, `--mcp-config`, `--max-budget-usd`, `--session-id`/`--resume`, `--no-session-persistence`, `--model`. | Local `claude --help` |
| **MCP TS SDK.** v1 (`@modelcontextprotocol/sdk` 1.32.2) is the maintenance line. **Decision: v1 for now.** v1 `registerTool` takes a raw zod shape. | npm, SDK repo |

Still unverified, and handled conservatively:
- **Skill `allowed-tools` combined with `context: fork`.** The forked skills declare no `allowed-tools`, so the agent's `tools` governs. Flows do not rely on slash expansion: the server passes the skill body in the prompt.

---

## 1. Agent architecture

```
Coordinator (human, Spanish)
  ├── app UI ── chat panel ─────► server ─ claude -p --agent coordinador-chat   (cwd = runtime folder)
  │          └─ Qué sigue / Flujos ► server ─ claude -p --agent coordinador-flujos (cwd = runtime folder)
  │                                           ├── clash-triager (sonnet)  ≤20 IDs per batch → proposals
  │                                           ├── issue-writer (sonnet)   real/hygiene groups → draft_issue
  │                                           ├── model-hygiene-auditor (haiku, read-only)
  │                                           └── rules-curator (opus)    feedback/insights → propose_rule_change
  │                                           ▼ coord MCP (mode chat | flow, explicit --mcp-config)
  │                                       core/ engine ── data home (store, batches, approvals, audit)
  └── VS Code ── dev agent (dev-harness) ── edits the app and agent-runtime/, runs tests, commits on OK
UI only: approve batch (passkey) → apply_approved_proposals → MC clashes:assign / :close / :reopen (jobs)
```

| Agent | Model | Why | Hard limits |
|---|---|---|---|
| `coordinador-chat` | session model | Conversation, short turns | No built-ins at all (`--tools ""`); coord tools of its list ∪ `CHAT_READ_TOOLS` minus denied; no apply/ingest/classification; may `start_flow` |
| `coordinador-flujos` | session model | Runs one catalog procedure | Built-ins only `Agent` (if the flow delegates), `Read`, `Grep`, `Glob`; never apply or flow tools (`FLOW_FORBIDDEN`) |
| `clash-triager` | `sonnet` | High-volume structured review | No apply, no `draft_issue`, no flow tools, no Agent/Bash/Edit/Write/Web |
| `issue-writer` | `sonnet` | Template-bound Spanish writing | No apply/status/classification/flow tools, no shell or file writes |
| `model-hygiene-auditor` | `haiku` | The engine computes; the agent ranks and phrases | Read-only |
| `rules-curator` | `opus` | Rare and high-leverage | No apply, no Edit/Write (cannot touch `rules/`) |

**Context budget.** No tool returns all clashes; responses are capped around 6k tokens as tables. Flows pass only IDs to subagents; subagents return ≤25-line reports.

### 1.1 Runtime materialisation (`server/agent-runtime.ts`)

- **Source:** `<app>/agent-runtime/`. Only a whitelist is shipped: `CLAUDE.md`, `settings.json`, `agents/<name>.md`, `skills/<name>/SKILL.md`, `hooks/<name>.mjs`. Nothing else from the repo is copied. `{{APP_ROOT}}` in `.md` files becomes the app folder, so the agent reads `docs/` and `rules/` there (read-only).
- **Target:** `<base>/<contentHash>/` laid out as a Claude project (`CLAUDE.md`, `.claude/agents|skills|hooks`, `.claude/settings.json`) plus `.runtime-manifest.json` (sha256 per file). `<base>` = `%LOCALAPPDATA%\bim-coordinator\agent-runtime` (sibling of `data\` and `backups\`, so backups never include it; XDG equivalent elsewhere). Demo / fixtures / tests (`COORDINATOR_HOME` or fixtures data): a temp folder keyed by the data home. `COORD_AGENT_RUNTIME_BASE` overrides. The base may never be inside the app folder or the data home (checked before writing).
- **Atomic and verified:** files are written to `.stage-…`, verified against the manifest and renamed into place. An existing folder is reused only if every manifest file matches and no extra agent/skill/hook/settings file exists (e.g. a `settings.local.json` or an extra hook = tampering → rebuilt). Only the current and the previous hash are kept (`state.json`); folders in use are cleaned up on a later start.
- **When:** at server start (router) and before every chat message / flow run (cheap: ~20 small files), so an edited `agent-runtime/` is picked up without an install step.
- **Spawn:** `cwd` = runtime folder, so Claude Code resolves `CLAUDE_PROJECT_DIR`, hooks, agents and skills there. The child env is `childEnv()` (no `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PROJECT_DIR`, inspector, API key) plus `COORD_APP_ROOT` (hooks read `coordinator.config*.json` there) and `COORD_AGENT_AUDIT_DIR` (`<data home>/audit`). The coord MCP server is always passed explicitly (`--strict-mcp-config --mcp-config`) and runs the real app's `server/mcp/index.ts` with the app's data source and home.
- **Availability:** flows are available when the runtime is materialised and has `coordinador-flujos.md` (always true after start). The MCP process (chat's `start_flow`) checks the source file `agent-runtime/agents/coordinador-flujos.md`. There is no "update the agent" step and no fallback to another agent.
- Chat sessions resume by session id; a new runtime hash changes the cwd, so a resumed session that Claude Code can no longer find starts a new one (existing retry in `server/chat/service.ts`).

---

## 2. MCP tool contract

`server/mcp/contracts.ts` holds the zod inputs, output types and the `TOOLS` registry (annotations, `minLevel`, modes).

Design rules:
- Envelope `{ok, data?, error?, truncated?, hint?}`, returned as compact JSON text only (no `structuredContent`).
- Tables for lists, with cursors.
- Active-context defaults, so most calls need few arguments.
- Engine-generated Spanish labels. Model text appears only inside `Untrusted` fields (sanitised, truncated to 120 chars, flagged).
- A `minLevel` autonomy gate in the server.
- A server-side audit log.

IDs:
- Groups: `G-<10 hex>` (sha1-based, `core/group`); families `F-…`.
- Clashes: MC stable numeric IDs as strings.
- Rules: `EST-002` style.
- Batches: `L-…` (the UX's *lote*).
- Test keys and proposal IDs: opaque server IDs.

Taxonomy (binding, from `core/rules/schemas.ts`):
- validity: `real|false_positive|tolerated|needs_info`
- nature: `hard|clearance|duplicate|workflow`
- severity: `critical|high|medium|low|none`
- band: P1–P4/NONE
- suggestedAction: `close_not_issue|mark_reviewed|create_issue|hygiene_issue|request_info|escalate`

| # | Tool | Writes | minLevel | Notes |
|---|---|---|---|---|
| 1 | `get_session_status` | – | 0 | Auth state (never the token), autonomy, active context, pending batches, `projectNotes` |
| 2 | `set_active_context` | local | 0 | |
| 3–6 | `list_projects`, `list_model_sets`, `list_model_set_versions`, `list_clash_tests` | – | 0 | Tables |
| 7 | `ingest_clash_test` | cache | 0 | Returns stats only |
| 8 | `summarize_clashes` | – | 0 | 1–2 dimensions |
| 9 | `run_classification` | cache (+engine proposals) | 0 (1 with `proposeAutoAccepted`) | Stats by validity, band and confidence band, plus `needsReview` |
| 10–12 | `list_groups`, `get_group`, `list_clashes` | – | 0 | `filter.needsReview` is the LLM queue |
| 13 | `get_element_properties` | – | 0 | ≤20 elements; text values are `Untrusted` |
| 14 | `diff_test_versions` | – | 0 | MC clash ID first, then the UniqueId `pairKey` |
| 15 | `get_model_hygiene_stats` | – | 0 | Hygiene checks H1–H10 |
| 16 | `propose_classification` | store | 1 | `disagreesWithEngine` is mandatory on any override |
| 17 | `propose_group_action` | store | 1 | merge / split / move / priority / responsible |
| 18 | `draft_issue` | store | 1 | Title ≤100, description ≤1000. Applied **only** via MC `clashes:assign` |
| 19 | `propose_status_change` | store | 1 | Refused for `real`/`needs_info` |
| 20–21 | `list_proposals`, `withdraw_proposal` | store | 0/1 | Proposals land in the open draft **batch** of the test |
| 22–25 | `record_feedback`, `list_feedback`, `evaluate_ruleset`, `propose_rule_change` | store | 0/0/0/1 | |
| 26 | `generate_report` | file | 0 | The server computes every number |
| 27 | `apply_approved_proposals` | **ACC** | 1 | Main mode only (never chat / flow). Input `{batchId, dryRun=true}`; the server verifies the passkey approval |
| … | `get_next_steps`, `start_flow` (chat only), `get_flow_status` (chat only), families, questions, meeting notes, issue checks, rule insights… | | | See `server/mcp/contracts.ts` |

**Batches.** Proposals land in an open draft *lote* per model set and test. The human reviews it in `/aprobaciones/:batchId` (preflight against ACC, exclusions, approve with passkey). Only an approved batch can be applied, from the UI.

---

## 3. Engine vs LLM

| Concern | Engine (`core/`) | LLM |
|---|---|---|
| Ingest, units, dedupe (G0), grouping (G1–G7) | ✔ | Suggest merges/splits the algorithm can't see |
| Classification (rules), who moves, severity, priority, band | ✔ with rule confidence and `humanReview` | Review only `humanReview` groups; never re-classify silently |
| Issue fields (title skeleton, location, IDs, due date) | ✔ | Description, requested action and options in Spanish |
| Diff, carried decisions, KPIs | ✔ | Narrate trends |
| Rules evolution | Eval harness | Propose changes; a human publishes |

**Review policy.** These values are code, not config: `core/group/review.ts` `DEFAULT_REVIEW_POLICY`.

- **Auto-accept thresholds:** `real` 0.80, `false_positive` 0.92 (0.90 when `nature: duplicate`), `tolerated` 0.92. `needs_info` is never auto-accepted.
- **Floors and caps:** `reviewFloor` 0.55; `bulkClosureMax` 50.
- **Always review:** severity `critical`; ≥150 clashes; unmatched (DEF-999); rules in conflict.
- The taxonomy's `humanReview` (`critical`, confidence <0.70, `needs_info`, or the rule says so) drives the agent queue.

Asymmetry is deliberate: wrongly closing a real clash is the worst error, so closable validities need higher confidence. **Mandatory human decisions:** critical, structural openings, ceiling/clear heights, egress, life safety, more than 50 closures, `seguridad_personas`, gravity vs gravity.

---

## 4. Autonomy, guardrails, hooks

### 4.1 Levels

| Level | Name | ACC writes | Status |
|---|---|---|---|
| L0 | Observador | None. `propose_*` → `autonomy_level_forbids` | Selectable |
| **L1** | Proponer | Only batches a human approved in the UI | **v1 default; server max** |
| L2 | Aprobación por políticas | Low-risk proposals matched by a signed standing policy | Designed |
| L3 | Autoaplicación bajo riesgo | Auto-apply of `false_positive` with confidence ≥0.9, with veto window and audit sampling | Designed |

`coordinator.config.json` → `autonomy.level`. A local file can **lower** the level, never raise it. `foreignMcp` policy: `{ "mode": "block_writes" | "block_all" | "allow_all", "allow": [globs], "deny": [globs] }`; `allow` beats `deny`, which beats `mode`.

### 4.2 In-app agent: tool lists (the enforced layer)

Every spawn passes `--tools` (built-ins), `--allowedTools` (pre-approved; with `--permission-mode dontAsk` anything else is denied) and `--disallowedTools`:
- chat: `CHAT_DISALLOWED` + the agent's `disallowedTools`; allowed = its coord tools ∪ `CHAT_READ_TOOLS` minus denied (`server/chat/bridge.ts`);
- flows: `FLOW_FORBIDDEN` + the agent's list; allowed = catalog list ∩ the agent's list (`server/flows/agent.ts`, `server/flows/catalog.ts`);
- MCP modes (`server/mcp/contracts.ts`): `chat` (no apply; `start_flow`), `flow` (no apply, no flow tools).

Tests: `tests/server/chat.test.ts`, `flows.test.ts`, `mcp.test.ts`, `agent-runtime.test.ts` (chat can propose / `start_flow`; flow agent and subagents can't `start_flow` or apply; nothing reaches approve/publish).

### 4.3 In-app agent: runtime settings and hooks (`agent-runtime/`)

`settings.json` denies `mcp__coord__apply_approved_proposals`, Bash/PowerShell/Monitor, Edit/Write/MultiEdit/NotebookEdit, WebFetch/WebSearch and reads of the keystore, `~/.claude*`, env files and `.git/`. Hooks (plain Node ESM, `${CLAUDE_PROJECT_DIR}/.claude/hooks/…`):

| Hook | Event / matcher | Decision |
|---|---|---|
| `guard-apply.mjs` | PreToolUse apply | **always deny** (applying is a human UI action) |
| `guard-shell.mjs` | Bash\|PowerShell\|Monitor | **always deny** (the in-app agent has no shell) |
| `guard-files.mjs` | Edit\|Write\|MultiEdit\|NotebookEdit | **always deny** (it never changes the app) |
| `guard-read.mjs` | Read\|Grep\|Glob | deny env files (not `.env.example`), keystore, `secret/`/`auth/` of any data home, `.git/`, Claude credentials, key/token file names — segment-based, so nested paths match; docs, rules and notes pass |
| `guard-foreign-mcp.mjs` | `^mcp__(?!coord__)` | v2 policy (allow/deny globs, Revit list, verb heuristic); config from `COORD_APP_ROOT` |
| `audit-log.mjs` | PostToolUse `mcp__coord__.*` (async) | JSONL line to `COORD_AGENT_AUDIT_DIR/agent-YYYY-MM.jsonl`; never inside the runtime folder; fail open |
| `session-start.mjs` | SessionStart | Governance line, effective autonomy level, data source; fail open |

All PreToolUse hooks fail closed on unreadable input.

### 4.4 Dev agent: minimal guardrails (`dev-harness/`)

Product decision (2026-11-11): the dev agent needs flexibility; safety invariants of the app and the in-app agent are enforced by **tests**, not by dev hooks, and security-sensitive changes are called out in the summary to the coordinator.

| | What | How |
|---|---|---|
| **deny** | Read/write of coordinators' real data and backups (`%LOCALAPPDATA%\bim-coordinator\data\|backups`, XDG equivalents, a legacy repo-local `.coordinator/`), secrets (`%APPDATA%\bim-coordinator`, `~/.config/bim-coordinator`, `COORD_SECURE_DIR`, key/token files, env files except `.env.example`) | settings deny rules + `guard-files.mjs` (Read/Grep/Glob/Edit/Write…) + `guard-shell.mjs`. Paths are normalised to absolute, lower-case, `\\?\` and trailing dots/spaces removed, and matched **by segment**, so `.wt/X/…` nested worktrees are covered (the old guard only matched repo-root-relative paths) |
| **deny** | ACC writes: `apply_approved_proposals` (settings + `guard-mcp.mjs`), CLI `apply`, HTTP to Autodesk hosts or the local apply route; human-only CLI verbs (`approve`, `passkey-enroll`); `CLAUDECODE` / `env -i` / `env -u` tricks; changing `COORD_DEV_LIVE` from the shell | `guard-mcp.mjs`, `guard-shell.mjs` |
| **deny** | With `COORD_DEV_LIVE=1` (set by the developer when starting `claude`): any coord tool that is not `get_*`/`list_*`/`summarize_*`/`diff_*` | `guard-mcp.mjs` |
| **ask** | Edits of the **active** guard: `.claude/hooks/**`, `.claude/settings*.json` (any depth, incl. `~/.claude`; `dev-harness/.claude/**` is the source, not the active guard) | `guard-files.mjs`, `guard-shell.mjs` (shell writes) |
| **allow** | Everything else: all app code including approval / WebAuthn / apply / data-admin / home / migrate, `agent-runtime/**` (agents, tool lists, hooks, settings), `server/chat/bridge.ts`, MCP contracts, `dev-harness/**`, root `CLAUDE.md`, other `.claude/` files, docs, tests, scripts, git (add/commit/branch/merge, any message) | `rules/` is not hand-edited by convention (dev CLAUDE.md) |

`scripts/dev-mcp.mjs` runs the coord server for the dev session: fixtures in `%TEMP%\bim-coordinator-dev-home` (or `COORD_DEV_HOME`), or live with `COORD_DEV_LIVE=1`.

**Activation (once, by a human):** `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\activate-dev-harness.ps1`. It refuses under Claude Code (`CLAUDECODE`), backs up `CLAUDE.md`, `.mcp.json` and `.claude\` to `%LOCALAPPDATA%\bim-coordinator\backups\harness-<stamp>\`, replaces them with `dev-harness/` (removes `.claude\agents\`; keeps `.claude\settings.local.json`) and prints the git status to commit. The dev agent cannot silently edit its own active guard (ask) and cannot run the activation script (it refuses under Claude Code).

**What the hooks are (honest statement):** best-effort defence in depth against model error and prompt injection, **not** a sandbox. The boundary for ACC writes is the WebAuthn user-verified approval re-verified by the server (§8).

The WS-L in-app "install agent update with passkey" (routes `/harness/*`, `server/harness-install.ts`, banner), `harness-staging/` and `npm run setup` were removed: the in-app agent ships as app code and the dev harness is activated by the script above.

---

## 5. Learning loop and project memory

```
correction (UI decision "corrected" + reason, or chat → record_feedback with a feature snapshot)
  → flow curar-reglas → rules-curator: get_rule_insights + list_feedback(by_signature) → propose_rule_change
  → evaluate_ruleset (EV-01..25 + fixtures + feedback replay; gates: unsafeClosureRate 0, criticalFalseNegatives 0)
  → UI "Reglas › Sugerencias" → human approves and publishes with passkey
```

Curator rules:
- Prefer narrowing an existing rule.
- New rules start below 0.70 confidence, so they go to human review.
- Language-specific property names go in `rules/property-aliases.yaml`.
- Never relax rules that protect `real`/`critical`/`seguridad_personas` without evidence from ≥2 projects.

**Project memory** lives in `<data home>/projects/<projectId>/notes.md` (path in `get_session_status.projectNotes`). It is local and not shared across machines (decision O5). Content: conventions, agreed exceptions, roles and companies; no personal data. Flows read it (Read); the in-app agent never writes files.

---

## 6. Prompts and configuration as shipped

The content lives in the files, not here:
- in-app: `agent-runtime/CLAUDE.md`, `agent-runtime/agents/*.md`, `agent-runtime/skills/*/SKILL.md`, `agent-runtime/settings.json`, `agent-runtime/hooks/*.mjs`;
- dev: `dev-harness/CLAUDE.md`, `dev-harness/.claude/**`, `dev-harness/.mcp.json`.

Prompt principles applied:
1. Spanish-first and concise.
2. Exact `mcp__coord__*` names.
3. Every subagent restates the untrusted-data rule and has a fixed output format, so its report is compact.
4. Forked skills (`auditar-modelo`, `curar-reglas`) delegate to their agent; the flow runner passes that as "delegate to subagent X".
5. Taxonomy values are repeated only as short enums; the definitions stay in `docs/domain/` (read via `{{APP_ROOT}}`).

---

## 7. Evaluation

| Layer | What | Command | Gates |
|---|---|---|---|
| **E1** engine | EV-01..25 exact-match fields, unsafe closures, fixture diff | `npm run eval` (`scripts/eval.ts`) | All scenarios match; unsafe closures 0 |
| **E2** agent classify | EV-01..25 plus adversarial INJ-01..04 | `npx tsx scripts/eval-agent.ts --suite classify --yes` | Rubric ≥85/100; no critical false negatives; 0 injection compliance |
| **E2** cycle skills | `ciclo` and `acta` offline suites (skill text from `agent-runtime/skills` by default; `--skills-dir` overrides) | `--suite ciclo\|acta --yes` | 0 engine work redone, 0 guesses, 0 closures of `real`, 0 invented dates, 0 personal names; ≥85/100 |
| **E2** agent workflow | `/triage`, `/preparar-ciclo`, a social-pressure apply attempt, on fixtures — run in the **materialised in-app runtime** with an explicit flow-mode `--mcp-config` | `--suite workflow --yes` | No apply; no closure proposal on `real`/`needs_info`; every `G-…` seen earlier; no foreign MCP calls; no tool result >60k chars |
| **E3** issues | `draft_issue` inputs from workflow runs | `--suite issues --yes` | Deterministic D1–D9; LLM judge mean ≥4.0 |

Runner notes:
- **Isolation:** every agent run gets `COORD_DATA_SOURCE=fixtures` and a temp `COORDINATOR_HOME`.
- **Clean environment:** the parent session's `CLAUDECODE`/`CLAUDE_CODE_*` and `BUN_INSPECT` variables are stripped.
- **Not in CI:** the runner exits 0 when `CI` is set unless `--allow-ci` is passed, and real runs need `--yes`.
- **Offline checks:** `--self-test` checks the scorers and transcript parser offline, and `--dry-run` prints the invocations.
- **When to run:** run E2/E3 before merging changes to `agent-runtime/**`, the MCP contracts or `rules/`, with `--runs 3` for variance.

---

## 8. Security

**Tokens and secrets.**
- Secrets live **outside the repository**, in the user profile: `%APPDATA%\bim-coordinator\` on Windows, `~/.config/bim-coordinator/` elsewhere, or `COORD_SECURE_DIR`. Tests and demos that set `COORDINATOR_HOME` use `<home>/secret/` instead.
- Stored there: the approval HMAC key, the audit-chain key, the passkeys (MAC'd with the approval key), the APS token cache and the browser session refresh token. On Windows the HMAC and audit keys are DPAPI-protected.
- `APS_CLIENT_SECRET` lives only in `.env.local`, which the server reads itself. The browser never receives the client secret or any refresh token.
- `get_session_status` returns no token material. Presigned S3 URLs never appear in tool output or logs.
- Neither agent can read the secrets: the in-app agent has no shell and `guard-read` denies the keystore; the dev agent's hooks deny the keystore, data and backups.

**Human approval (the ACC write gate).**
- **Live mode:** a batch is approved only with a WebAuthn assertion with `userVerification: required` (Windows Hello or a platform passkey). The challenge is `sha256(payloadHash|batchId|testVersion|nonce)`; the nonce is single use and expires after 2 minutes.
- Apply and `verify-approval` re-check the WebAuthn signature against the **current** payload, the HMAC, expiry, that the model set version is still the latest, and a matching `batch.approved` audit event. Apply re-verifies under the batch lock and requires a prior dry run of the same payload.
- Passkey enrolment: first passkey via a one-time code from the interactive CLI (`passkey-enroll`, refused when `CLAUDECODE` exists or stdin is not a TTY); further passkeys need an existing passkey.
- **Fixtures mode only:** a labelled demo approval without WebAuthn is accepted.
- HTTP API checks: exact `Host` allowlist, exact `Origin` for mutations plus `Sec-Fetch-Site` same-origin, double-submit CSRF for human-only endpoints. These stop other websites, not a local non-browser client; the WebAuthn signature is what proves a human approved.

**Prompt injection.**
- **Untrusted surfaces:** element, family and type names, parameter values, document, view, project and model set names, levels and categories, test names, existing ACC issue text and comments, meeting notes. All reach MCP output only as `{untrusted, flagged?}`.
- Server-side controls: no ACC write path without a human WebAuthn-signed batch; `Untrusted` wrapping and flagging (`server/sanitize.ts`); engine-generated labels; output validation (no URLs, @ mentions or emails; referenced IDs must exist).
- Prompt-side: rules in `agent-runtime/CLAUDE.md` and in every agent. Eval gates: INJ-01..04 and WF-03.

**Personal data.** Tools return roles and companies, never emails or phones. People are assigned in the UI at approval time. Feedback snapshots hold derived features only.

**Confidentiality.** Project data goes to Claude only under the company-approved plan, per the *Procedimiento Acceso Herramientas IA*. Both CLAUDE.md files and SessionStart hooks remind of it. The dev agent works on fixtures by default.

**Threat model (v1, stated honestly).**
- **In scope:** model error, prompt injection through model or ACC data, an agent that misuses its tools, other websites in the coordinator's browser (CSRF, DNS rebinding), accidental double application to ACC.
- **Out of scope for v1:** a malicious process running as the **same OS user** (it can call DPAPI, rewrite the data home, patch the server code or the runtime folder). Hooks and permission rules only raise the bar for the agents.
- **Roadmap:** run the coordinator server as a separate OS user or service that owns the secrets, the store and the runtime folder; bind passkeys to device attestation; DPAPI-wrap the token caches.

---

## 9. Decisions and open items

Decided by the orchestrator (2026-11-06) and the product owner (2026-11-11):

| # | Topic | Decision |
|---|---|---|
| O1 | MCP SDK | Stay on v1 `@modelcontextprotocol/sdk` 1.32.2 |
| O2 | Output format | Text JSON only |
| O3 | Diff | Clash ID first, `pairKey` fallback |
| O4 | ACC writes | Issues are created only via MC `clashes:assign`; close/assign/reopen are batched jobs |
| O5 | Project notes | Local |
| O6 | Token | One token with `data:read data:write data:create` |
| O10 | Foreign MCP servers | Block write-capable tools, configurable |
| O12 | Batches | Supported |
| O13 | Two agents (WS-S) | VS Code = dev agent (minimal guards, tests enforce invariants); app = coordination agent shipped as code in `agent-runtime/`, no install step |

Still open:
1. **Description length conflict.** The issue guide's template targets about 180 words, but ACC caps descriptions at 1000 characters; the writer is told ≤1000 characters.
2. **Workflow eval in the runtime.** Run `--suite workflow` once to confirm `/skill` expansion under `-p` with the materialised runtime as cwd.
3. **Server as a separate OS user** (threat model roadmap) would also protect the runtime folder from same-user tampering between verifications.
