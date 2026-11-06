# BIM Coordinator Agent — Master Plan

Owner: orchestrator. All specialist agents read this first. Decisions here are binding unless the orchestrator changes them.

## Mission

Turn `aps-web-tools` into a **BIM coordination agent harness** that SalfaCorp BIM coordinators clone and run. The agent ingests Autodesk Construction Cloud (ACC) **Model Coordination** clash results, then **sorts, de-duplicates, groups, classifies and prioritizes clashes**, and drafts actions (issues, status changes, assignments) so coordinators get through clash review much faster. The long-term goal is autonomy; v1 is **propose → human approves → apply**.

## Decisions (fixed)

| Topic | Decision |
|---|---|
| Agent runtime | **The repo is the harness.** Coordinators run Claude Code inside the repo. The agent = `CLAUDE.md` + `.claude/skills` + `.claude/agents` + `.claude/settings.json` hooks + a project MCP server (`.mcp.json`) exposing APS coordination tools. No LLM provider is hardcoded in app code. |
| Write policy | Agent never writes to ACC directly. MCP "write" tools only create **proposals** in a local store (`.coordinator/`). A coordinator approves them in the web UI (or via an explicit CLI command), and only then does the server apply them to ACC. Autonomy levels (L0 read-only → L3 auto-apply low-risk) are designed as config, with v1 shipping L1 (propose-only). |
| UI language | Spanish by default, i18n-ready (ES/EN dictionaries). Code, identifiers and dev docs stay in English. Agent replies to coordinators in Spanish unless the user writes in another language. |
| Brand | SalfaCorp palette per `BRAND.md` (light theme, `#A32428`). |
| Stack | Existing Vite + React 19 + TS + Tailwind 4 + react-router. Node side via `tsx`. Tests via `vitest`. MCP via `@modelcontextprotocol/sdk` (stdio). |
| Governance | Usage must follow SalfaCorp's *Procedimiento Acceso Herramientas IA*. Secrets live only in `.env.local`/token cache, never committed, never sent to the browser. |

## Repository layout (target)

```
core/                 Isomorphic, pure TS — NO fetch, NO node APIs. Unit tested.
  types.ts            Canonical domain model (Clash, ClashGroup, Element, Classification, Proposal…)
  ingest/             Raw MC clash resources → normalized clashes (+ legacy processClashes logic)
  classify/           Rule engine: discipline pair, element categories, severity, false-positive detection
  group/              Grouping strategies (by element, by system/run, by level/zone, by root cause)
  score/              Priority scoring
  rules/              Rule loader + schema validation
server/               Node only.
  aps/                Auth (3-legged OAuth, token cache in .coordinator/), MC modelset/clash, Model Properties (Index) API, ACC Issues clients
  store/              Proposal + triage-decision store (JSON files under .coordinator/), audit log
  mcp/                MCP server (stdio) — the agent's tools
  api/                HTTP API used by the web UI (mounted as Vite middleware in dev; standalone runnable)
src/                  Web UI (Spanish): project/modelset picker, clash triage board, group review with viewer, approval queue, rules view
rules/                Coordinator-editable classification rules (YAML/JSON) + discipline matrix
.claude/              skills/, agents/, settings.json (hooks gating writes)
CLAUDE.md             Agent constitution
.mcp.json             Registers server/mcp
docs/                 research/, domain/, ux/, ai/ specs; legacy/ = recovered old MC client (reference only)
tests/fixtures/       Synthetic MC clash resource payloads for offline tests
```

## Known base assets

- `docs/legacy/model-coordination.ts`: recovered MC v3 client (modelsets, views, clash tests, S3 resources, `processClashes`, status codes 1–4, distance in metres where negative means penetration).
- `docs/legacy/aps-auth-plugin.ts`: recovered S3 presigned-URL proxy.
- `src/lib/components/ForgeViewer.tsx` and `src/lib/viewer-tools/*`: viewer, shader isolate/glow, markers, color-by-property, dashboard. Reuse these for clash visualization.
- `src/lib/server/aps-auth-plugin.ts`, `src/lib/auth-context.tsx`: browser 3LO flow (code exchange on the server).

## Phases

1. **Specs (parallel):** researcher → `docs/research/aps-model-coordination-api.md`; BIM specialist → `docs/domain/*` + `rules/` seed; UX → `docs/ux/coordinator-ux-spec.md`; AI specialist → `docs/ai/harness-design.md` + tool contracts.
2. **Build:** coder(s) implement `core/` → `server/` → MCP → UI, using the specs.
3. **Harness:** AI specialist writes `CLAUDE.md`, skills, subagents, hooks and an eval set against fixtures.
4. **Validate:** typecheck, build, unit tests, MCP smoke test, code review, BIM specialist review of classification output on fixtures.
