# Chat agent in the coordinación workspace (design)

Owner: AI specialist. Builders: coder C (server bridge), coder D (UI). Status: design, 2026-11-10.
Model: the local Node server spawns **headless Claude Code** (`claude -p`) once per chat message, using the
coordinator's own Claude Code login (no API key). The agent is `coordinador-chat`
(`agent-runtime/agents/coordinador-chat.md`, shipped with the app and materialised by `server/agent-runtime.ts`;
the run's cwd is the runtime folder — WS-S). Propose-only, autonomy L1.

## 1. Verified invocation (Claude Code 2.1.267, Windows; probed 2026-11-10)

```
claude -p                                     # prompt on STDIN (verified; avoids the ~32k Windows argv limit)
  --agent coordinador-chat                    # persona + tool lists; also makes hooks see agent_type → guard-apply denies apply
  --output-format stream-json --verbose       # --verbose is required with stream-json
  --include-partial-messages                  # token streaming (stream_event text_delta)
  --session-id <uuid>   (first message)  |  --resume <uuid>   (later messages)   # verified 2-turn resume
  --strict-mcp-config --mcp-config '<json>'   # only the coord server; inline JSON string accepted
  --tools ""                                  # no built-in tools at all (no Read/Bash/Edit/Web…)
  --allowedTools "<the agent's mcp__coord__ list, comma-separated>"
  --disallowedTools "mcp__coord__apply_approved_proposals,mcp__coord__ingest_clash_test,mcp__coord__run_classification,Bash,PowerShell,Edit,Write,Read,WebFetch,WebSearch,Agent,Task,Skill"
  --permission-mode dontAsk --permission-prompts none   # anything not pre-allowed is denied; no prompt can hang the run
  --max-budget-usd <chat.maxBudgetUsdPerMessage, default 0.50>
  [--model <chat.model>]                      # omit by default: the user's default model (observed: claude-opus-5)
```
- **Not available / not to use:** there is no `--max-turns` in 2.1.267. The server caps tool calls itself (§3).
  `--bare` would skip hooks and **refuses the subscription login** (API key only), so it is not usable.
  `--restricted` ignores project settings, which disables the hooks, so it is not used either.
  `--no-session-persistence` is not used, because the chat needs `--resume`.
- **cwd = repo root.** Per the docs ("Run Claude Code programmatically"), a `-p` run without `--bare` runs the project's
  `.claude/settings.json` hooks with no trust dialog. The guards (`guard-apply`, `guard-foreign-mcp`, `audit-log`)
  therefore apply, and so do the shell and file guards, as a second line behind `--tools ""`.
- **Environment.** Start from `process.env` and delete `CLAUDECODE`, every `CLAUDE_CODE_*` variable,
  `CLAUDE_PID`, `CLAUDE_PROJECT_DIR`, `BUN_INSPECT`, `NODE_OPTIONS`, and **`COORD_HARNESS_DEV`** (dev mode
  must never reach the chat agent). Keep `PATH`, `USERPROFILE`/`HOME` and `APPDATA` (the login lives there).
- **MCP config (inline JSON):** `{"mcpServers":{"coord":{"command":"<process.execPath>","args":["--import","tsx",
  "<root>/server/mcp/index.ts"],"env":{"COORDINATOR_HOME":"<server's home>","COORD_DATA_SOURCE":"<fixtures|unset>",
  "COORD_CHAT":"1"}}}}`. The server copies its own data source and home, so the chat sees the same store as the UI.
  With `COORD_CHAT=1` the MCP server should **not register** `apply_approved_proposals` and should tag proposals
  `createdBy: "agent-chat"`.
- **Binary:** `chat.claudeBin` from config, else `claude` on `PATH`, else `%USERPROFILE%\.local\bin\claude.exe` /
  `~/.local/bin/claude`. Spawn without a shell (argv array).
- **Pre-flight (cheap, no model call):** `claude auth status --json` → `{loggedIn, authMethod, subscriptionType, email…}`,
  exit 0 when logged in and 1 when not (verified). Cache the result for 5 minutes. **Never send `email`/`orgName` to the browser.**

## 2. stream-json events the server must parse (one JSON object per stdout line; verified)

| Event | Shape (relevant fields) | Server action |
|---|---|---|
| `{"type":"system","subtype":"init"}` | `session_id, model, permissionMode, tools[], mcp_servers[{name,status}], mcp_server_errors?` | Store `session_id`. If `coord` is not `connected`, fail the message: "No se pudo iniciar el servidor de coordinación". |
| `{"type":"system","subtype":"status"}`, `"api_retry"` | `status:"requesting"` · `attempt, max_retries, retry_delay_ms, error` | Show the "pensando…" / retry indicator. |
| `{"type":"rate_limit_event"}` | `rate_limit_info{status, resetsAt, rateLimitType}` | When `status ≠ allowed`, show "límite de uso, reintenta a las HH:MM". |
| `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":…}}}` | plus `parent_tool_use_id` (null = main) | Append the text to the chat bubble (main only). Ignore `message_start/stop`, `content_block_start/stop`, `message_delta`. |
| `{"type":"assistant","message":{"content":[…]}}` | blocks `text` or `tool_use{id,name,input}` | For `tool_use`, show "consultando grupo G-…" chips; count calls (§3). |
| `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id","content","is_error"}]}}` | tool results | **Extract created proposal/question IDs from `propose_*`/`draft_issue`/`ask_coordinator` results** (deterministic) and render the cards from those, not from the model's text. |
| `{"type":"system","subtype":"permission_denied"}` | denied tool | Log it; the message continues. |
| `{"type":"result"}` (last line) | `subtype, is_error, result, session_id, total_cost_usd, usage, num_turns, duration_ms, terminal_reason, permission_denials[]` | End the message. Record the cost (observed per run, not cumulative across resumes). If `is_error`, map it to a UI message. |
| Not logged in (verified) | `assistant.error = "authentication_failed"`, `is_api_error_message: true`; result `is_error: true, terminal_reason: "api_error", result: "Not logged in · Please run /login"`; exit code 1 | UI: "Claude Code no tiene sesión iniciada. Abre una terminal y ejecuta `claude`, luego `/login`." |

Other errors:
- **Binary not found** (spawn `ENOENT`): "Claude Code no está instalado (https://code.claude.com)".
- **Exit code ≠ 0 with no `result` event:** show the last 300 characters of stderr, with secrets redacted.
- **Exit code 143 (SIGTERM):** "cancelado".

## 3. Per-message limits and lifecycle
- **One run at a time per chat session.** Further messages queue. One session = (user, projectId, modelSetId, testKey); a new test starts a new session.
- **Caps:**
  - `--max-budget-usd` (default 0.50 per message);
  - a wall-clock timeout of 120 s;
  - at most 25 `tool_use` events per message;
  - at most 10 proposals per message.

  When a cap is hit, send **SIGINT** (the turn ends cleanly), then SIGTERM after 5 s. The UI says "detenido: límite de …".
- **Cancel button:** SIGINT. Sessions live in `~/.claude/projects/` (Claude Code's normal transcript store; the same exposure as using Claude Code in VS Code). "Nueva conversación" generates a new UUID.

## 4. Context block (server-built, per message)
The **server** builds the `<contexto_ui>` block from structured UI state. Free text from the browser is never pasted
into it. Element names are sanitised with `server/sanitize.ts` and wrapped as `{untrusted}`. The block is capped
at 4,000 characters: IDs plus a few properties. The agent fetches the rest with tools.

```
<contexto_ui>{"lente":"cambios","testKey":"…","seleccion":{"familyId":"F-…","groupIds":["G-…"],"clashIds":["…"]},
 "visor":[{"documentId":3,"dbId":4521,"modelo":"SAN","categoria":"Pipes","tipo":{"untrusted":"PVC 110"},"nivel":"Piso 3"}]}
</contexto_ui>
<mensaje_usuario>…</mensaje_usuario>
```

## 5. MCP tool changes (+1 tool)
**New: `get_selection_context`** (read; allowed by the `get_*` glob)
```ts
input:  { testKey?: TestKey, elements: Array<{ documentId: number|string, dbId: number }> /* 1..50 */ }
output: { elements: Array<{ ref: "E-doc:dbId", found: boolean, discipline?: string, category: string,
            family?: Untrusted, type?: Untrusted, level?: string, system?: Untrusted, externalId?: string,
            clashCount: number }>,
          clashes: Table /* clashId, groupId, familyId, otherRef, otherCategory, penetrationMm, validity, triageState; ≤ 100 rows */,
          groups: Table /* groupId, familyId, label, validity, band, humanReview, clashesFromSelection, clashCount */,
          families: Table /* familyId, title, validity, decisionState, instances */,
          notInTest: string[] /* refs with no clash in this test */ }
```

**Extended: `propose_group_action`** (no new tool for regrouping). New `action.type` variants:
- `move_groups {groupIds ≤ 20, toFamilyId | newFamilyLabel ≤ 80}`: move ubicaciones between families.
- `detach_clashes {clashIds ≤ 200, newGroupLabel?}`: split clashes into a new group.
- `merge_families {familyIds 2..10}` and `split_family {familyId, groupPartitions: GroupId[][]}`.

These join the existing `merge`, `split` and `move_clashes` variants. All are proposals. Validation: every ID exists in the test, and the server refuses to move or merge across validities when that would drop a `real` item into a closable family.

**Reused:** `get_group`, `get_family`, `list_clashes`, `get_element_properties`, `propose_family_decision`,
`propose_classification`, `propose_status_change`, `draft_issue`, `ask_coordinator`, `record_feedback`, `list_proposals`.

## 6. Safety
- **Prompt-injection surface:** element, type and family names, parameters, meeting notes, issue texts, and the user's
  own message, which may contain pasted content. Mitigations:
  - no built-in tools (`--tools ""`) and no apply tool;
  - only `propose_*` writes, to the local store;
  - the server extracts proposal IDs deterministically;
  - the untrusted wrapping;
  - the hooks still run (cwd = repo);
  - the human approves every proposal in the UI and every ACC write with a passkey.
- **No other MCP servers:** `--strict-mcp-config` loads none (the probe's init showed `mcp_servers: []`), so Revit
  and Power BI tools and claude.ai connectors are unreachable.
- **Dev mode:** `COORD_HARNESS_DEV` is stripped from the child environment, so the guards always apply.
- **Personal data:** the agent writes discipline codes, never names. The server never forwards the auth email. The chat transcript stays local.
- **Governance:** the UI shows the *Procedimiento Acceso Herramientas IA* notice once per session (O-7 still open).
- **Spanish-only safety net (G12, `server/chat/narration.ts`):** each text segment is held until it is clearly content.
  A segment followed by a tool call is dropped when it reads as English or as short narration ("Reviso el grupo…");
  a Spanish segment past 200 characters streams live; the final segment is always shown.
- **Cards (G12, `server/chat/cards.ts`):** `proposal` / `question` events and `GET /chat/history` carry a `card`
  built from the store (action, validity, grupo/ubicación name, clash count; questions in full so the card is
  answered in place with the Detalle callout's flow). Never from the model's text.
- **Header chip:** `GET /agent/status` ignores the chat agent's (`agent-chat`) audit events; the panel has its own
  status line, and it asks for a fresh status when a turn ends (done, error or cancel).

## 7. Open items for coder C / D
1. Implement `get_selection_context` and the `propose_group_action` variants. With `COORD_CHAT=1`: skip registering apply, and tag `createdBy`.
2. Bridge: `POST /api/coord/chat/messages` (H, CSRF) returns `{messageId}`, plus an SSE stream `GET /api/coord/chat/:messageId/events`
   that carries `delta`, `tool`, `proposal`, `question`, `done` and `error` events. Add `GET /api/coord/chat/status` (auth pre-flight, version).
3. Confirm `omitClaudeMd: true` applies to a main-thread `--agent` session. If it doesn't, CLAUDE.md is loaded too; it is
   consistent but uses about 2k more tokens.
4. Coder D: the cards come from the server's proposal extraction; show cost and duration per message in small text; show the "no sesión / no instalado" states from §2.
