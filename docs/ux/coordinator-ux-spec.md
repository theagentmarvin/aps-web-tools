# Coordinator UX Spec — BIM Clash Coordination Agent

Owner: UX. Status: v1 spec for build phase. Binding inputs: `docs/PLAN.md` (Spanish UI with i18n, SalfaCorp brand, **propose → human approves → apply**), `BRAND.md`.
Audience: the coder(s) implementing `src/`. Anything marked **[contract]** is a data/API shape the UI depends on; align it with `docs/ai/harness-design.md` and the server spec. If they conflict, the field *meaning* here holds and the naming follows the server.

> Governance reminder: use of this tool follows SalfaCorp's *Procedimiento Acceso Herramientas IA*. The footer of every page shows a link/label for it (key `app.governance`).

---

## 0. Mental model (read first)

```
Claude Code (terminal/IDE)                     Web app (this spec)                         ACC
───────────────────────────                    ─────────────────────────────               ─────
Agent analyzes clashes  ──writes──▶ .coordinator/ store ──read──▶  TRIAGE (staging)
  proposals: validity, group,                                      coordinator: accept / edit / reject
  priority, issue drafts,                                          ── corrections ──▶ learning log + rule suggestions
  status changes                                                   │
                                                                   ▼
                                                                 APPROVALS (commit)
                                                                   diff vs ACC, pre-flight, confirm
                                                                   │
                                                                   ▼ server applies ───────────────▶ status changes, issues
                                                                 AUDIT trail
```

Three verbs, three places. **Triage** = human decides on each proposal (fast, reversible, local). **Approve** = human commits a batch of decided changes (deliberate, shows exactly what ACC will receive). **Apply** = server writes to ACC (irreversible for issues). Nothing reaches ACC from the triage screen. This separation is the core trust mechanism: coordinators can move fast in triage because triage cannot break anything.

Vocabulary (UI, Spanish): clash = **interferencia**; group = **grupo**; model set = **conjunto de modelos**; clash test = **prueba de interferencias**; issue = **incidencia** (ACC's own Spanish term); proposal = **propuesta**; batch = **lote**; rule = **regla**. Disciplines come from the BIM specialist's discipline matrix in `rules/` (labels and short codes, e.g. `EST`, `ARQ`, `CLIMA`, `SAN`, `ELE`, `PCI`); the UI never hardcodes discipline names.

---

## 1. Personas and top jobs

### P1 — Coordinadora BIM (primary user) — "Camila"
- Runs weekly coordination for 1–3 projects; each test run yields 500–10 000 raw clashes; she owns the weekly coordination meeting.
- Works with two monitors: Claude Code on one, this web app on the other. Keyboard-heavy, impatient with modals.
- **Top jobs**
  1. Get from "new test run" to "meeting-ready list of real problems" in hours, not days.
  2. Confirm or correct the agent's grouping/validity/priority quickly, seeing each problem in 3D.
  3. Turn real problems into well-written ACC issues assigned to the right discipline.
  4. Mark false positives / tolerable clashes so they don't come back next week.
  5. Know what changed since last week (new, persisting, resolved, reappeared).
- **Fears**: the AI silently hides a real clash; a bulk action spams ACC with 300 issues; losing work.

### P2 — Modelador de disciplina (receiver of issues) — "Diego, modelador CLIMA (subcontratista)"
- Does **not** necessarily use this app; consumes ACC issues. May get a read-only link to a group.
- **Top jobs**
  1. Receive issues that are self-explanatory: what collides, where (level/grid), how much, which element IDs, a snapshot, what is expected of him.
  2. Not receive duplicates or 40 issues for one duct run (wants one issue per root cause).
  3. Push back ("esto es una pasada prevista") — his reply in ACC returns as context for next run.
- **Design implication**: issue drafts are grouped by root cause, templated, include element IDs/level/grid/distance, and the issue preview in the approval queue shows exactly what Diego will see.

### P3 — Gerente BIM — "Rodrigo"
- Oversees several projects and coordinators; reports to project management.
- **Top jobs**
  1. See burn-down of clashes per test version and per discipline pair across projects.
  2. Check that AI use is controlled: who approved what, acceptance/correction rates, audit trail.
  3. Curate rules: approve rule suggestions coming from corrections; disable rules that misfire.
  4. Quantify time saved for management.
- Occasionally the second approver for high-risk batches (configurable, see §5.6).

---

## 2. Information architecture and routes

### 2.1 Site map

```
Inicio (/)                            Mi trabajo: cola pendiente, lotes por aprobar, actividad del agente, KPIs
├── Proyectos (/proyectos)            Hubs → proyectos (picker)
│   └── /proyectos/:projectId         Conjuntos de modelos + pruebas + estado del análisis del agente
│       └── Coordinación (/coordinacion/:projectId/:modelSetId)   TRIAGE WORKSPACE
├── Aprobaciones (/aprobaciones)      Cola de lotes
│   └── /aprobaciones/:batchId        Revisión del lote (diff), pre-chequeo, aplicar
├── Reglas (/reglas)                  Reglas · Sugerencias · Correcciones · Calibración
│   └── /reglas/:ruleId               Detalle de regla + rendimiento
├── Reportes (/reportes)              Portafolio (todos los proyectos)
│   └── /reportes/:projectId          Proyecto (filtro opcional ?modelSet=)
├── Auditoría (/auditoria)            Registro de auditoría (filtrable, exportable)
└── Ajustes (/ajustes)                Idioma, nivel de autonomía (solo lectura v1), umbrales, atajos
(dev) /data-management                Herramienta existente; fuera de la navegación principal
/auth/callback                        Existente
*                                     404
```

### 2.2 Router (replace `src/router.tsx`)

Route path segments are Spanish (user-facing). Query parameters are English (code-facing, stable). Components and files are English.

| Path | Component (file) | Notes |
|---|---|---|
| `/` (index) | `HomePage` (`src/routes/home.tsx`, rewrite) | Dashboard. Replaces current marketing-style Home. |
| `/auth/callback` | `Callback` (existing) | Unchanged. After login, redirect to `sessionStorage["coord.returnTo"]` if set. |
| `/proyectos` | `ProjectsPage` (`src/routes/projects.tsx`) | Hub → project picker. |
| `/proyectos/:projectId` | `ProjectPage` (`src/routes/project.tsx`) | Model sets. `projectId` = ACC project GUID **without** `b.` prefix (= MC container id). |
| `/coordinacion/:projectId/:modelSetId` | `TriageWorkspace` (`src/routes/triage.tsx`) | Full-height workspace. Query: `test`, `group`, `clash`, `view` (`groups`\|`clashes`), `sort`, `q`, and filter keys (§3.6). |
| `/aprobaciones` | `ApprovalsPage` (`src/routes/approvals.tsx`) | Query: `status`, `project`. |
| `/aprobaciones/:batchId` | `BatchPage` (`src/routes/batch.tsx`) | Query: `tab` (`resumen`\|`cambios`\|`incidencias`\|`conflictos`). |
| `/reglas` | `RulesPage` (`src/routes/rules.tsx`) | Query: `tab` (`reglas`\|`sugerencias`\|`correcciones`\|`calibracion`). |
| `/reglas/:ruleId` | `RulePage` (`src/routes/rule.tsx`) | |
| `/reportes` | `ReportsPage` (`src/routes/reports.tsx`) | Portfolio. |
| `/reportes/:projectId` | `ReportsPage` (same component, scoped) | Query: `modelSet`, `from`, `to`. |
| `/auditoria` | `AuditPage` (`src/routes/audit.tsx`) | Query: `project`, `user`, `action`, `from`, `to`, `batch`. |
| `/ajustes` | `SettingsPage` (`src/routes/settings.tsx`) | |
| `/data-management` | `DataManagement` (existing) | Keep for dev; link only from Ajustes → "Herramientas de desarrollo". |
| `*` | `NotFoundPage` (`src/routes/not-found.tsx`) | |

```tsx
// src/router.tsx (target)
export const router = createBrowserRouter([
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: HomePage },
      { path: "auth/callback", Component: Callback },
      { path: "proyectos", Component: ProjectsPage },
      { path: "proyectos/:projectId", Component: ProjectPage },
      { path: "coordinacion/:projectId/:modelSetId", Component: TriageWorkspace },
      { path: "aprobaciones", Component: ApprovalsPage },
      { path: "aprobaciones/:batchId", Component: BatchPage },
      { path: "reglas", Component: RulesPage },
      { path: "reglas/:ruleId", Component: RulePage },
      { path: "reportes", Component: ReportsPage },
      { path: "reportes/:projectId", Component: ReportsPage },
      { path: "auditoria", Component: AuditPage },
      { path: "ajustes", Component: SettingsPage },
      { path: "data-management", Component: DataManagement },
      { path: "*", Component: NotFoundPage },
    ],
  },
]);
```

Every route except `auth/callback` and `*` is wrapped by `AuthGate` (extract the duplicated "🔒 Authentication required" block from `data-management.tsx` / legacy clash viewer into `src/lib/components/AuthGate.tsx`, without emoji, using i18n keys `auth.*`). `AuthGate` stores the current URL in `sessionStorage["coord.returnTo"]` before calling `login()`.

### 2.3 Layout and navigation (`src/routes/layout.tsx`, `src/lib/components/nav.tsx`)

`Layout` keeps `h-screen flex flex-col overflow-hidden`. Non-workspace pages render inside `<div className="h-full overflow-y-auto">` with an inner `max-w-7xl mx-auto px-6 py-6`. The workspace takes `h-full` with no padding.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ■ SalfaCorp | Coordinación BIM   Inicio  Proyectos  Aprobaciones (3)  Reglas  Reportes      │
│                                                    ● Agente activo · hace 2 min   ES|EN  RZ ▾ │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Brand: `text-brand font-bold tracking-tight`. Active link: `text-brand border-b-2 border-brand` (use `NavLink`), inactive `text-gray-600 hover:text-brand`.
- Aprobaciones badge = number of batches in state `ready` (pill `bg-brand text-white text-[10px] rounded-full px-1.5`).
- `AgentStatusIndicator`: derived from the store's last agent write timestamp **[contract: `GET /api/agent/status` → `{ lastActivityAt, lastRunId, running: boolean, currentTask?: string }`]**. Green dot `bg-green-600` if activity < 5 min, gray `bg-gray-400` otherwise; tooltip shows current task text (Spanish, from agent).
- `LanguageSwitch`: segmented `ES | EN`, persists to `localStorage["coord.lang"]`, default `es`.
- User menu: name/initials, "Cerrar sesión".
- Footer (non-workspace pages only): `app.governance` text, `text-xs text-gray-400`.

### 2.4 Pages other than the workspace (concise)

**`/proyectos`** — Two-column picker. Left: hubs (list). Right: project cards (Card pattern from BRAND.md) with name, number of model sets, pending decisions badge. Search box filters by name. Remembers last hub in `localStorage["coord.lastHub"]`. Recently opened projects (max 5) shown on top.

**`/proyectos/:projectId`** — Header with project name + breadcrumb. Grid of `ModelSetCard`:
```
┌──────────────────────────────────────────────┐
│ Torre B — Coordinación general        v14    │
│ Última prueba: 04-11-2026 · 3 412 interf.    │
│ Análisis del agente: ● Actualizado (v14)     │   or ◐ Desactualizado (v13) / ○ Sin analizar
│ ▓▓▓▓▓▓▓▓░░░░ 1 120 / 1 812 grupos revisados  │
│ 412 decisiones listas para aprobar           │
│ [Abrir coordinación]   [Copiar comando ⧉]    │
└──────────────────────────────────────────────┘
```
"Copiar comando" copies the Claude Code prompt to (re)analyze this model set; text comes from the server **[contract: `ModelSetSummary.agentCommand: string`]**, e.g. `Analiza el conjunto "Torre B — Coordinación general" (v14)`. The UI never invokes the agent itself.

---

## 3. Triage workspace (`/coordinacion/:projectId/:modelSetId`)

### 3.1 Layout

Three resizable panes + header + status bar. Minimum supported viewport 1366×768; optimized for 1920×1080.

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Proyectos / Torre B / Coordinación general   Prueba: [04-11-2026 · v14 ▾]  ▓▓▓▓▓▓░░░ 1 120/1 812  [Enviar 412 a aprobación] │
├───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⚠ Hay una versión más reciente del conjunto (v15). Las propuestas se generaron sobre v14.  [Copiar comando] [Detalles] │  ← only when stale
├───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 🔍 Buscar…  [Decisión: Pendiente ×] [Par: EST×CLIMA ×] [+ Filtro]  Orden: Prioridad ▾  Vista: (Grupos|Interferencias) ★Vistas ▾ │
├──────────────────────────────┬─────────────────────────────────────────────────┬──────────────────────────┤
│ GROUP LIST (380px)           │ VIEWER (flex-1)                                 │ DETAIL (400px)           │
│ ☐ P1 ●●○ EST×CLIMA ×14  NUEVA│  ┌─Modo: (Aislar|Rayos X|Contexto) ⤢ ▣ ◎ A B──┐ │ Grupo 23 de 418     ◀ ▶  │
│   Ducto DR-12 vs vigas N3  ○ │  │                                             │ │ Ducto DR-12 vs vigas     │
│▶☐ P2 ●●● EST×SAN  ×3       ✓ │  │          (A) azul     (B) naranja            │ │ ── Evidencia ──          │
│   Tubería PVC vs losa N2     │  │              ◎ marcador 1..n                 │ │ ── Propuesta del agente ─│
│ ☐ P3 ●○○ ARQ×ELE  ×1       ○ │  │                                             │ │ ── Razonamiento ──       │
│ …virtualized…                │  └─────────────────────────────────────────────┘ │ ── Cambios desde prueba ─│
│                              │  ┌ Leyenda ─────────────────┐                   │ ── Borrador incidencia ──│
│                              │  │ A ■ EST · Viga V-201      │                   │ ── Historial ──          │
│                              │  │ B ▲ CLIMA · Ducto DR-12   │                   │                          │
│ [selection bar when ≥1 ☑]    │  └───────────────────────────┘                   │ [Aceptar A][Editar E]    │
│                              │                                                 │ [Rechazar X][Posponer S] │
├──────────────────────────────┴─────────────────────────────────────────────────┴──────────────────────────┤
│ Sesión: 86 decisiones · 4,1/min · mediana 6 s · 78 % aceptadas   ● Guardado   Visor listo (5/5 modelos)   ? Atajos │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Root: `h-full flex flex-col`. Header `flex-shrink-0 border-b border-brand-muted/20 bg-white px-4 py-2`. Panes `flex-1 flex min-h-0`.
- Group list pane: default `w-[380px]`, resizable 300–600 px, `border-r border-brand-muted/20 bg-white flex flex-col`. (Do **not** use `bg-brand-surface` for the whole list as the legacy viewer did — selected rows need the surface tint to stand out.)
- Viewer pane: `flex-1 min-w-0 relative`.
- Detail pane: default `w-[400px]`, resizable 340–560 px, collapsible (`\` key) to a 40 px rail. `border-l border-brand-muted/20 bg-white flex flex-col`; content `flex-1 overflow-y-auto`; action bar sticky at bottom.
- Pane widths persist in `localStorage["coord.layout"]`.
- Below 1280 px width the detail pane becomes an overlay drawer on the right (`absolute inset-y-0 right-0 shadow-xl`), toggled by `\`.

### 3.2 Header elements
- Breadcrumb: `Proyectos / {project} / {modelSet}` (links).
- **Test selector** (`TestVersionSelect`): lists test runs newest first: `{fecha} · v{modelSetVersion} · {n} interferencias`, current marked "(analizada)" if the agent has proposals for it. Switching test changes `?test=`.
- **Progress meter**: `revisados / total` groups (in the current test, ignoring filters), bar `h-1.5 rounded bg-brand-surface` with fill `bg-brand`; tooltip breaks down by decision state.
- **Primary CTA** `Enviar {n} a aprobación` (`bg-brand hover:bg-brand-light text-white`), disabled when `n = 0`. Creates/updates the open batch for this model set + test (§5.1) and shows a toast with link "Ver lote".

### 3.3 Group list

Two view modes (`view=groups` default, `view=clashes` flat). In groups mode a group row can expand to show its clashes inline.

**Group row** (fixed height 56 px):
```
☐  [P1]  ●●○  [A EST × B CLIMA]  ×14   NUEVA            ○
    Ducto DR-12 cruza vigas V-201..V-214 · Nivel 3
```
- Line 1: checkbox (visible on hover, always when any row is checked), `PriorityChip`, `ConfidenceDots`, `DisciplinePairChip` (A/B swatches), clash count `×14` (`font-mono text-xs text-gray-500`), `DeltaBadge` (only if not "persistente"), `DecisionStateIcon` right-aligned.
- Line 2: AI group title (Spanish, from agent; truncate) + `· {nivel}`. `text-sm text-gray-800`, title `title=` attribute holds full text.
- If the coordinator's decision differs from the proposal, show the **effective** value (e.g. edited priority) with a small ✎ marker next to it.
- States: hover `bg-gray-50`; active (keyboard cursor) `bg-brand-surface border-l-2 border-brand`; checked `bg-brand/5`; decided rows `text-gray-500` (de-emphasized but not hidden unless filtered).

**Clash row** (in expanded group or flat mode, fixed height 36 px):
```
   • 41299469560661  Viga V-203 ↔ Ducto DR-12   −120 mm   N3   ACTIVA
```
- Short id (last 6 digits, full id in tooltip), A element name ↔ B element name (A text `text-clash-a-ink`, B text `text-clash-b-ink`), distance (`−` = penetration, mm, `font-mono`), level, ACC status badge (BRAND.md status badges, Spanish label).
- In flat mode clash rows also show `PriorityChip`, `ConfidenceDots`, group title (truncated) and `DecisionStateIcon`.

**Decision state icons** (always icon + `aria-label`): Pendiente `○` gray-400; Aceptada `✓` green-700; Corregida `✎` amber-700; Rechazada `✕` red-700; Pospuesta `⏸` gray-500; Heredada (decision carried from previous test) `↺` gray-500 with tooltip of original decision. Use inline SVG icons (no emoji) — see §7.

**Selection bar** (appears at the bottom of the list pane when ≥ 1 row checked):
```
┌ 12 seleccionados ─ [Aceptar propuestas] [Prioridad ▾] [Validez ▾] [Rechazar…] [Posponer] [Agrupar] [×] ┐
```
`sticky bottom-0 bg-white border-t border-brand-muted/20 shadow-[0_-2px_6px_rgba(0,0,0,0.05)] px-3 py-2`.

### 3.4 Keyboard shortcuts

Global rule: shortcuts are active when focus is not in a text input/textarea/select/contenteditable. `Esc` always leaves the input and returns focus to the list. Single-key, no modifiers for the hot path. Every button tooltip shows its key (e.g. "Aceptar (A)"). Implement in a single `useHotkeys` registry (`src/lib/hotkeys.ts`) keyed by scope (`list`, `modal`, `global`), so `?` overlay is generated from the registry.

| Key | Action | Notes |
|---|---|---|
| `j` / `↓` | Next row | Moves cursor; viewer follows after 120 ms debounce. Holding repeats. |
| `k` / `↑` | Previous row | |
| `J` / `K` (Shift) | Next / previous clash **within** current group | Expands the group if collapsed; viewer focuses that single clash. |
| `Enter` / `l` / `→` | Expand group | In flat mode: no-op. |
| `h` / `←` | Collapse group / go to parent group row | |
| `g g` / `G` | First / last row | |
| `a` | **Accept** AI proposal for current row, advance to next pending | Guarded (§4.5). |
| `e` | **Edit** proposal (inline editor in detail pane, focus first field) | Save with `Enter`/`Ctrl+Enter`; reason required (§4.4). |
| `x` | **Reject** proposal → opens `ReasonCodePicker` | Digits pick reason, `Enter` confirm. |
| `1` `2` `3` `4` | Set priority P1–P4 (= correction if different from proposal) | Opens compact reason picker preselected with R08/R09 if different; `Enter` confirms. |
| `v` | Validity menu: `1` Válida, `2` Falso positivo, `3` Tolerable, `4` Duplicada, `5` Por confirmar | If different from proposal, reason picker follows with suggested code. |
| `i` | Open / create **issue draft** for current group | Focuses issue title. |
| `s` | **Posponer** (skip, stays pending-with-flag, excluded from batch) | Advances. |
| `n` | Add note (comment) to current row | |
| `u` / `Ctrl+Z` | Undo last decision (stack of 50, session-scoped) | Toast "Deshecho: …". |
| `Ctrl+Shift+Z` | Redo | |
| `Space` | Toggle check on current row | |
| `Shift+Space` | Range-check from last checked to current | |
| `Ctrl+A` | Check all rows matching filters (shows count) | Second press clears. |
| `A` (Shift+a) | Accept proposals for checked rows | Bulk guard (§3.5). |
| `X` (Shift+x) | Reject checked rows → one reason for all | |
| `/` | Focus search | |
| `F` (Shift+f) | Open filter menu | |
| `c` | Cycle viewer mode Aislar → Rayos X → Contexto | |
| `z` | Fit current clash/group to view | |
| `b` | Toggle section box around current clash | |
| `m` | Toggle clash markers | |
| `[` / `]` / `=` | Show only A / only B / both | |
| `r` | Expand/collapse rationale | |
| `\` | Collapse/expand detail pane | |
| `Shift+R` | Load newer agent proposals (when toast shown) | |
| `Ctrl+Enter` (list scope) | `Enviar a aprobación` | Confirms with count. |
| `g a` / `g i` / `g r` / `g p` | Go to Aprobaciones / Inicio / Reglas / Reportes | Two-key chord, 800 ms window. |
| `?` | Shortcut overlay | |
| `Esc` | Close modal/menu → clear search focus → clear checks (in that order) | |

After `a`, `x`, `s`, priority/validity changes, the cursor **auto-advances to the next pending row** (setting in Ajustes: "Avanzar automáticamente", default on). The decided row stays in place (no list jump) until the user changes filters or presses `Shift+R`; filtered-out rows disappear only on the next filter evaluation, which happens when the cursor leaves the row — never under the cursor.

### 3.5 Bulk actions
- Available from the selection bar and `A`/`X`.
- **Bulk accept guard**: the confirmation dialog (`BulkConfirmDialog`) lists counts by confidence band and priority. Rows with **Baja** confidence or **P1** priority that were never focused in the viewer are **excluded by default** with a checkbox "Incluir {n} de baja confianza / P1 no revisadas" (off). Hard cap: 500 rows per bulk action.
- Bulk priority/validity: one reason code applies to all; per-row overrides not supported in bulk.
- **Agrupar** (merge selected groups/clashes into one group) and **Separar** (detail pane, split selected clashes out of a group) are corrections with reason R07; they create a "group edit" decision, not an ACC change.
- All bulk actions are one undo step.

### 3.6 Filters, sort, search, saved views

Filter bar = chips; each chip opens a `MultiSelectPopover` with counts per value (computed on the currently loaded data, faceted on all *other* active filters).

| Filter (query key) | Values | Default |
|---|---|---|
| Decisión (`decision`) | pendiente, aceptada, corregida, rechazada, pospuesta, heredada | `pendiente` |
| Par de disciplinas (`pair`) | from discipline matrix, e.g. `EST:CLIMA` (unordered pair) | all |
| Validez propuesta (`validity`) | valida, falso_positivo, tolerable, duplicada, por_confirmar | all |
| Prioridad (`priority`) | 1,2,3,4 | all |
| Confianza (`confidence`) | alta, media, baja | all |
| Nivel (`level`) | levels from element properties | all |
| Estado ACC (`accStatus`) | activa, revisada, resuelta, cerrada | all |
| Cambio (`delta`) | nueva, persistente, reaparecida, modificada | all |
| Origen (`source`) | regla, ia, regla_ia, manual | all |
| Responsable (`owner`) | discipline codes | all |
| Con incidencia (`issue`) | borrador, existente, ninguna | all |

Filter values serialize to the URL as comma lists (`?decision=pendiente&pair=EST:CLIMA,EST:SAN`); `replaceState`, not push, for filter edits.

**Sort** (`sort`): `priority` (P1 first, then clash count desc — default), `confidence_asc` ("Baja confianza primero"), `count_desc`, `distance` (deepest penetration first), `level`, `pair`, `delta` (nuevas primero), `updated` (most recent agent update).

**Search** (`q`): matches group title, element name, element id, clash id, rule id, issue title. Debounce 150 ms. Highlights matches in rows.

**Saved views** (★ Vistas): built-in presets — "Pendientes P1–P2", "Baja confianza", "Nuevas en esta prueba", "Falsos positivos propuestos", "Con borrador de incidencia" — plus user-saved (stored in `localStorage["coord.views"]`). A view = filters + sort + view mode.

Clear-all link appears when any non-default filter is active ("Limpiar filtros").

### 3.7 Detail pane (AI reasoning panel)

Order is deliberate: **evidence before verdict** (anti-anchoring, §4.5).

```
┌──────────────────────────────────────────┐
│ Grupo 23 de 418                   ◀  ▶   │
│ Ducto DR-12 cruza vigas V-201..V-214     │
│ G-0f3a · 14 interferencias · Nivel 3     │
├─ Evidencia ──────────────────────────────┤
│ Penetración máx. 120 mm · mín. 35 mm     │
│ Ejes C–D / 4–6 · Nivel 3 (+9,60)         │
│ ┌ A ■ ESTRUCTURA ───────┐┌ B ▲ CLIMA ───┐│
│ │ Viga V-203            ││ Ducto DR-12   ││
│ │ Viga H.A. 30x70       ││ Rect. 600x400 ││
│ │ EST_TorreB.rvt        ││ CLIMA_TB.rvt  ││
│ │ id 1203345            ││ id 884512     ││
│ └───────────────────────┘└───────────────┘│
│ Interferencias (14) ▾  [mini table]      │
├─ Propuesta del agente ───────────────────┤
│ Validez     Válida            ●●● Alta  [Regla R-EST-CLIMA-004] │
│ Prioridad   P1 Crítica        ●●○ Media [IA]                    │
│ Responsable CLIMA             ●●● Alta  [Regla R-OWN-002]       │
│ Acción      Crear incidencia + estado → Revisada               │
├─ Razonamiento ───────────────────── (r) ─┤
│ "El ducto principal de retorno atraviesa │
│  14 vigas del nivel 3 con penetraciones  │
│  de hasta 120 mm, muy por sobre la       │
│  tolerancia de 25 mm. No hay pasadas     │
│  modeladas…"                             │
│ Señales: penetración 120 mm > 25 mm ·    │
│  categoría Vigas × Ductos · sin pasada   │
│ Reglas aplicadas: R-EST-CLIMA-004 ↗      │
├─ Cambios desde la prueba anterior ───────┤
│ NUEVA en v14 · 0 decisiones previas      │
├─ Borrador de incidencia ─────────── (i) ─┤
│ Título: [Interferencia ducto DR-12 …]    │
│ …                                        │
├─ Historial ──────────────────────────────┤
│ 04-11 10:12 Agente propuso (run 7c1e)    │
├──────────────────────────────────────────┤
│ [Aceptar A] [Editar E] [Rechazar X] [Posponer S] │
└──────────────────────────────────────────┘
```

Section details:
- **Header**: position "Grupo {i} de {n}" within current filtered list; ◀ ▶ buttons (= `k`/`j`). Group id `font-mono text-xs text-gray-400`.
- **Evidencia**: distance range (mm, Spanish number format), level + elevation, grid location if the server provides it **[contract: `ClashGroup.location?: { level?: string; elevation?: number; grid?: string }`]**, two `ElementCard`s (A left / B right, color-coded border-l-4 `border-clash-a` / `border-clash-b`), showing category, family/type, system/run name, source model file, dbId/external id. "Comparar propiedades" (`p`) opens a two-column property diff modal using model properties (reuse `property-service.ts` lookups). Interference mini table: id, A, B, distance; click = focus that clash (`J`/`K`).
- **Propuesta del agente** (`ProposalCard`): one row per proposed field (`validity`, `priority`, `owner`, `action`, `groupMembership` if changed by agent). Each row: label, value, `ConfidenceBadge`, `SourceBadge`. If the coordinator changed a field: show `<s>` AI value `text-gray-400 line-through` then new value `font-medium` + reason code chip.
- **Razonamiento** (`RationaleBlock`): Spanish rationale from agent (max ~600 chars displayed, "Ver más"), "Señales" (structured key facts the decision used, as chips), "Reglas aplicadas" (links to `/reglas/:ruleId`), and for LLM judgments the line "Juicio de IA — modelo {model}, ejecución {runId}". Collapsed by default to 3 lines when confidence is Alta; expanded by default when Media/Baja.
- **Cambios desde la prueba anterior** (`ChangeSinceLastTest`): §4.3.
- **Borrador de incidencia** (`IssueDraftEditor`): only if action includes issue creation or user pressed `i`. Fields: título, descripción (prefilled template), disciplina/empresa responsable, asignado a (ACC user/role/company picker **[contract: server lists assignable users]**), fecha límite (default +7 days), tipo/subtipo de incidencia (ACC issue types), ubicación (level text), "Incluir vista 3D" (checkbox; captures viewer state + screenshot at approval time — not at triage time — so the snapshot reflects final framing; the user can press "Fijar vista actual" to store the current camera now). Editing any AI-drafted field marks the issue draft as corrected (reason R13 "Redacción de incidencia" auto-applied, no picker — text edits are low-signal and must not slow the user).
- **Historial**: timeline of agent proposals (run ids), human decisions (who, when, reason), notes, previous-test decisions, ACC status history if available.
- **Action bar** (`DecisionBar`): `sticky bottom-0 bg-white border-t border-brand-muted/20 p-3 grid grid-cols-4 gap-2`. Aceptar = primary `bg-brand text-white`; others secondary `border border-brand-muted/30 text-gray-700 hover:border-brand-light/40`. Each shows its key as `<kbd>` (`text-[10px] px-1 rounded border border-gray-300 text-gray-500 font-mono`). When a decision exists, the bar shows the decision summary ("Aceptada por RZ · 10:42 · Deshacer (U)").

### 3.8 How the clash is shown in the viewer

**Model loading.** On workspace load, the server returns the document URNs for the test **[contract: `TestRun.documents: { documentId, urn, name, discipline? }[]`]** (same source as legacy `processClashes` `modelUrns`). `ForgeViewer` loads them all once (existing `keepCurrentModels: true` logic). Required change: `ForgeViewer` must expose a map `documentUrn → model` (today `modelsRef` is a positional array that silently skips failures), via `onModelsLoaded?(map: Map<string, Model>, failed: string[])` and on `window.__apsViewer.getModelByUrn(urn)`. Clash instances reference `ldid`/`rdid` (document ids) → map to URN → model; **dbIds are per model** and must always be resolved against the correct model.

**On selection of a clash** (debounced 120 ms; applied only for the final cursor position):
1. Mode **Rayos X** (default): native ghosting for context. Call `viewer.setGhosting(true)`, then for each loaded model `viewer.isolate(dbIdsInThatModel, model)`. For models that contain none of the involved elements, ghost the whole model (isolate a non-geometry node such as the instance tree root's first non-leaf child, or use `model.visibilityManager` to hide all nodes with ghosting on); do not unload or `hideModel` them in this mode. Verify the chosen call against the Viewer v7 docs in `docs/forge-viewer-canonical.md`.
2. Glow A in `--color-clash-a` and B in `--color-clash-b` using the overlay glow technique from `shader-effects.ts`, **extended** (see below), plus `viewer.setThemingColor(dbId, Vector4(color, 0.6), model)` as a solid tint so colors read even at low glow.
3. Camera: `viewer.navigation.fitBounds(false, unionBBox.expandByScalar(max(0.5 m, 0.5 × diag)))` with a 300 ms transition (instant if `prefers-reduced-motion`). Only refit when the cursor settles (≥ 150 ms after last key repeat), never on every repeat.
4. **Clash point marker**: the MC payload has no clash point. Compute it client-side: intersection of world bounding boxes of A's and B's fragments; if empty (clearance clash), midpoint between the closest bbox faces; place a `sonar` marker (existing `addSonarMarker`, ring color brand `#A32428`, radius = 0.3 m). For a group, place an `object` marker per clash with its index label ("1".."n"); the active one is the sonar. Clicking a marker selects that clash (`onMarkerClick`).
5. **Legend overlay** (`ClashLegend`, bottom-left of viewer, `absolute left-3 bottom-3 rounded-lg bg-white/95 border border-brand-muted/20 shadow-sm px-3 py-2 text-xs`): `A ■ {disciplina} · {element}` and `B ▲ {disciplina} · {element}`, plus distance.

**On selection of a group**: same as above with all A dbIds and all B dbIds of the group (cap: glow overlay for ≤ 200 dbIds per side; above that use theming color only and show "Resaltado simplificado (grupo grande)" in the legend).

**Modes** (`c`, segmented control in `ClashViewerToolbar`, top-right of viewer `absolute right-3 top-3`):
- **Aislar**: only the involved elements visible (`viewer.isolate(ids, model)` ghosting off; other models hidden).
- **Rayos X** (default): involved elements in color + glow, everything else ghosted.
- **Contexto**: full models visible, involved elements tinted + glow (for understanding surrounding conditions).
Other toolbar buttons: Ajustar (`z`), Caja de sección (`b`, via `Autodesk.Section` extension `setSectionBox(bbox expanded by 1 m)`), Marcadores (`m`), Solo A (`[`), Solo B (`]`), Ambos (`=`). Hide the generic `ShaderToolbar`/marker toolbar extensions in the workspace (they are for the free-form viewer) — pass an `extensions` prop to `ForgeViewer` so the workspace can omit `ApsViewerToolkit.Shader`/`ApsViewerToolkit.Marker` toolbar buttons while still using the services.

**Required changes to `src/lib/viewer-tools/shader-effects.ts`** (or a new `clash-highlight.ts` that reuses its helpers):
- Today `enableXRay` and `enableGlow` are mutually exclusive (each disables the other), single-color, and only use `viewer.model` (first model). `enableXRay` also builds overlay meshes for **every** non-selected dbId in the model — O(model size), unusable on real projects.
- New API:
  ```ts
  export interface ClashSide { model: Model; dbIds: number[] }
  export type ClashViewMode = "isolate" | "xray" | "context";
  export function showClashPair(a: ClashSide[], b: ClashSide[], opts: {
    mode: ClashViewMode; colorA: string; colorB: string; glow?: boolean; maxGlowIds?: number;
  }): void;
  export function setSideVisibility(side: "a" | "b" | "both"): void;
  export function clearClashPair(): void;
  ```
  Implementation: native `isolate`/ghosting for context (no overlay meshes for non-selected), two glow overlay scenes (`glow-a`, `glow-b`) built per model using that model's fragment list, theming colors per model. Cache overlay meshes per `(modelId, dbId)` so j/k back-and-forth is instant; dispose cache on test change. The pulse animation must respect `prefers-reduced-motion` (static glow).
- Do not use the brand red (`#ff4444` default) for clash sides; red is reserved for errors and the clash point marker.

**Hover**: reuse `ElementTooltip` (hover shows name + key properties); add the side letter A/B to the tooltip header when the hovered dbId is part of the current pair.

**Viewer ↔ list sync**: clicking an element in the viewer that belongs to any clash in the current filtered list selects that row (if several, the first by sort, and the detail pane shows "Este elemento participa en {n} grupos" with links).

### 3.9 States

| State | Where | Behavior / copy key |
|---|---|---|
| Not authenticated | whole page | `AuthGate` (`auth.required`). |
| Loading triage data | list + detail | 12 skeleton rows `h-14 rounded bg-brand-surface animate-pulse`; detail skeleton blocks. Header shows `workspace.loading`. |
| Loading models | viewer | Centered progress "Cargando modelos ({loaded}/{total})…" (`viewer.loadingModels`); list is already usable — selection queues viewer action until ready. |
| Model failed to load | viewer banner | `viewer.modelFailed` amber banner top of viewer `bg-amber-50 border border-amber-200 text-amber-800`; affected rows show a "sin 3D" icon; decisions still allowed. |
| Viewer init failed | viewer | Existing ForgeViewer error block, translated (`viewer.initFailed`). |
| No agent analysis for this test | list | `EmptyState`: title `workspace.noAnalysis.title`, body with the copyable agent command, secondary button `workspace.noAnalysis.manual` → loads raw clashes in flat mode with no proposals; `a` disabled ("No hay propuesta que aceptar"). |
| Agent analysis in progress | header | Inline chip "El agente está analizando… {task}" (from agent status) + list shows what exists; newly written proposals arrive via the "new proposals" toast. |
| New/updated proposals while reviewing | list top | Non-blocking bar `bg-brand-surface text-brand text-sm`: `workspace.newProposals` with button "Actualizar (Shift+R)". Never reorder the list automatically. If an already-decided item changed: keep human decision, mark row with ⚑ and history entry `history.agentUpdatedAfterDecision`. |
| Filters exclude everything | list | `EmptyState` `list.emptyFiltered` + "Limpiar filtros". |
| Everything reviewed | list | `EmptyState` `list.allDone` with count and button "Enviar {n} a aprobación". |
| Stale model version | header banner | §4.3. Amber banner `stale.banner`; batches created from stale data are flagged and require override (§5.3). |
| Element no longer exists in newer version | row + detail | Gray row with `delta.elementMissing`; proposal actions limited to "Rechazar (R11)" / "Posponer". |
| Save failure | status bar | `save.failed` red text + "Reintentar"; decisions are kept in memory and mirrored to `localStorage["coord.pending.{modelSetId}"]` until the server confirms; on reload, pending local decisions are re-sent. |
| Server/store error | full pane | `ErrorState` (BRAND.md error display) with message and "Reintentar". |
| Token expired mid-session | modal | `auth.expired`, "Volver a iniciar sesión" preserves URL; unsaved decisions persist via the localStorage mirror. |

Decision persistence: optimistic UI; decisions are queued and POSTed in micro-batches every 500 ms or 20 items **[contract: `POST /api/triage/decisions` body `Decision[]`, idempotent by `decision.id` (client-generated UUID)]**. Status bar shows `save.saving` / `save.saved` / `save.failed`.

---

## 4. AI trust design

### 4.1 Confidence
- Agent provides a numeric confidence 0–1 **per proposed field** **[contract: `ProposalField.confidence: number`]**. UI bands (configurable in Ajustes; defaults): **Alta ≥ 0.85**, **Media 0.60–0.84**, **Baja < 0.60**.
- `ConfidenceBadge`: dots + text, never color alone. `●●● Alta` `text-green-800 bg-green-50 border-green-200`; `●●○ Media` `text-amber-800 bg-amber-50 border-amber-200`; `●○○ Baja` `text-red-800 bg-red-50 border-red-200`. Tooltip: "Confianza 0,92 · calibrada con 1 204 decisiones previas: el 96 % de las propuestas con esta confianza fueron aceptadas" — the calibration figure comes from `/api/learning/calibration` (§6.3); if not enough data (< 50 decisions in band) show "Calibración insuficiente".
- Row-level `ConfidenceDots` = **minimum** confidence across the row's proposed fields (weakest link), not average.

### 4.2 Rationale and origin
- Rationale text is Spanish, written by the agent **[contract: `Proposal.rationale: string` (es), `Proposal.signals: { label: string; value: string }[]`, `Proposal.ruleIds: string[]`, `ProposalField.source: "rule" | "llm" | "rule+llm" | "manual"`, `Proposal.runId`, `Proposal.model?`]**.
- `SourceBadge`: `Regla R-…` (deterministic; `bg-gray-100 text-gray-700 border-gray-200 font-mono`), `IA` (LLM judgment; `bg-brand/10 text-brand border-brand-light/30`), `Regla + IA` (rule matched, LLM adjusted; both styles split), `Manual`. Clicking a rule badge opens `/reglas/:ruleId` in a side drawer (do not leave the workspace).
- Plain-language legend in the `?` overlay and in Ajustes: "**Regla** = resultado determinista de una regla del proyecto. **IA** = juicio del modelo de lenguaje; revísalo con más atención."
- LLM-only fields with Baja confidence get a left border `border-l-2 border-red-300` on the proposal row as an attention cue.

### 4.3 What changed since the last test
Per clash, the server computes a delta versus the previous test run of the same model set **[contract: `Clash.delta: "new" | "persisting" | "reappeared" | "modified" | "resolved"`, `Clash.persistingSince?: testId`, `Clash.previousDistance?: number`, `Clash.previousDecision?: Decision`]**:
- `NUEVA` (blue-gray chip `bg-slate-100 text-slate-700`), `PERSISTENTE ({n} pruebas)` (not shown as chip in list, only in detail), `REAPARECIDA` (amber chip — previously resolved/closed, back again: strong signal), `MODIFICADA` (distance changed > 10 mm: "−80 → −120 mm"), `RESUELTA` (clash disappeared; shown only in a dedicated "Resueltas por la prueba" filter/section so the coordinator can confirm closure in ACC).
- **Heredada**: if a previous test had a human decision for the same clash (matched by element pair), the agent pre-fills the proposal from it; UI shows `↺ Heredada de {fecha} ({usuario}, {razón})`. Inherited decisions on persisting clashes are pre-accepted only if the setting "Aceptar decisiones heredadas automáticamente" is on (default **off** in v1; shows "Aceptar heredadas ({n})" quick action in the header instead).
- Group header summary in detail: "3 nuevas · 10 persistentes · 1 reaparecida".
- **Stale model version banner**: shown when `modelSet.latestVersion > analyzedVersion` or a newer test exists than the one opened. Copy: `stale.banner`. Actions: "Copiar comando para re-analizar" and "Abrir prueba más reciente". Decisions remain editable; batches are flagged stale (§5.3).

### 4.4 Capturing corrections (feeds learning)
A **correction** is any human decision whose effective value differs from the AI value for a field, or a rejection. Every correction requires a **reason code** (one keypress) and allows an optional note. Text edits to issue drafts are recorded automatically (R13) without a picker.

`ReasonCodePicker` (modal, 420 px, appears anchored over the detail pane, focus trapped):
```
┌ ¿Por qué corriges la propuesta? ─────────────────────────┐
│ Campo: Validez  Válida → Falso positivo                  │
│ 1 Falso positivo geométrico (no se tocan / tolerancia)   │
│ 2 Penetración prevista (pasada, manga, shaft)        ★   │  ★ = suggested from the change
│ 3 Tolerancia admisible (aislación, recubrimiento)        │
│ 4 Duplicada de otra interferencia o grupo                │
│ 5 Elemento provisorio / de referencia / fuera de alcance │
│ 6 Disciplina o sistema mal identificado                  │
│ 7 Ya resuelto en versión más reciente del modelo         │
│ 8 Otro (escribir)                                        │
│ Nota (opcional): [__________________________]            │
│ ☐ Sugerir una regla para casos similares                 │
│                         [Cancelar Esc]  [Guardar Enter]  │
└──────────────────────────────────────────────────────────┘
```
The list shown depends on the field corrected. Full taxonomy (stable codes; labels via i18n `reasons.*`):

| Code | Applies to | Meaning |
|---|---|---|
| R01 | validity | Falso positivo geométrico (no se intersectan / bajo tolerancia) |
| R02 | validity | Penetración prevista (pasada, manga, shaft diseñado) |
| R03 | validity | Tolerancia admisible (aislación, recubrimiento, holgura aceptada) |
| R04 | validity, grouping | Duplicada de otra interferencia o grupo |
| R05 | validity | Elemento provisorio, de referencia o fuera de alcance |
| R06 | owner, validity | Disciplina o sistema mal identificado |
| R07 | grouping | Agrupación incorrecta (dividir / unir) |
| R08 | priority | Prioridad sobreestimada |
| R09 | priority | Prioridad subestimada |
| R10 | owner | Responsable incorrecto |
| R11 | validity, action | Ya resuelto en versión más reciente del modelo |
| R12 | action | Acción incorrecta (no crear incidencia / sí crear / otro estado) |
| R13 | issue draft | Redacción de la incidencia (automático) |
| R99 | any | Otro (nota obligatoria) |

Suggested code (★) is preselected by mapping: priority up → R09, down → R08; validity → falso_positivo → R01; owner change → R10; group split/merge → R07. `Enter` accepts the suggestion: a correction costs 2 keystrokes (`1`..`4` + `Enter`).

**Correction record** **[contract: `POST /api/triage/decisions`, `Decision`]**:
```ts
interface Decision {
  id: string;                 // client UUID (idempotency)
  proposalId: string; targetType: "group" | "clash"; targetId: string;
  testId: string; modelSetId: string; projectId: string;
  kind: "accept" | "correct" | "reject" | "postpone" | "note";
  changes: { field: "validity" | "priority" | "owner" | "action" | "group" | "issueDraft";
             aiValue: unknown; humanValue: unknown; aiConfidence?: number; aiSource?: string; ruleIds?: string[] }[];
  reasonCode?: string; note?: string; suggestRule?: boolean;
  viewedInViewerMs: number;   // dwell with this target focused in viewer
  decidedAt: string; userId: string; userName: string;
  bulk?: { size: number };    // set when part of a bulk action
}
```
`suggestRule: true` creates a rule suggestion request for the agent (shows in `/reglas?tab=sugerencias` once the agent drafts it). Corrections are also exported as eval cases (`/reglas?tab=correcciones` → "Exportar como casos de evaluación").

### 4.5 Avoiding rubber-stamping
1. **Evidence before verdict**: detail pane order Evidencia → Propuesta → Razonamiento; the viewer is already framed when the row is focused.
2. **Dwell guard on risky items**: for rows with Baja confidence or P1 priority or delta `reapareció`, `a` requires the target to have been focused in a **ready** viewer for ≥ 1.5 s (setting). If not, the first `a` shows inline hint `guard.lookFirst` ("Revisa la interferencia en 3D antes de aceptar · pulsa A de nuevo para confirmar") and the second `a` within 3 s accepts (and is logged with `viewedInViewerMs`).
3. **Bulk guard** (§3.5): risky rows excluded from bulk accept by default; 500 cap; dialog shows breakdown.
4. **Random spot checks**: the server flags ~5 % of Alta-confidence proposals as `spotCheck: true` (deterministic per proposal id). These rows show a small "Revisión aleatoria" chip and get the same dwell guard. Never fabricated items — only real proposals selected for closer review. Spot-check correction rate feeds calibration (§6.3).
5. **Pace nudge**: if in the last 30 decisions acceptance ≥ 95 % **and** median dwell < 1.5 s, show a dismissible (once per session) banner `guard.paceNudge`. Non-blocking; logged.
6. **Session meter** in the status bar: decisions, rate/min, median dwell, % accepted — visible to the coordinator, aggregated (not per-person) in reports to avoid surveillance feel.
7. **Accountability text**: the accept button tooltip says "Aceptar: tú confirmas esta propuesta (quedará registrado con tu nombre)".
8. **Calibration visible**: confidence tooltips state empirical acceptance per band, so "Alta" means something measured.

---

## 5. Approval queue (`/aprobaciones`, `/aprobaciones/:batchId`)

### 5.1 Batches
- A **lote** (batch) is scoped to one project + model set + test run. There is at most one `draft` batch per (modelSet, test); "Enviar a aprobación" moves decided-but-unbatched items into it and sets it to `ready`. Accepting/correcting more items afterwards opens a new draft batch (the ready one is frozen).
- Batch states: `draft` Borrador · `ready` Listo para aprobar · `approved` Aprobado (aplicando) · `applied` Aplicado · `partial` Aplicado con errores · `discarded` Descartado · `stale` (flag, not state) Base desactualizada.
- **[contract]** `Batch { id, projectId, modelSetId, testId, modelSetVersion, state, createdBy, createdAt, approvedBy?, approvedAt?, appliedAt?, stale: boolean, counts: { issuesCreate, statusChanges, assignments, comments }, items: BatchItem[] }`, `BatchItem { id, decisionIds[], targetType: "clash" | "group" | "issue", targetIds[], operation: "clash.setStatus" | "issue.create" | "issue.update" | "issue.comment", accCurrent?: unknown, accNew: unknown, origin: "ai_accepted" | "ai_corrected" | "manual", reviewer, conflict?: { reason: string; accValueNow: unknown } }`.

### 5.2 Queue list (`/aprobaciones`)
Table (`BatchTable`), sorted by `ready` first, then newest:
```
Estado            Proyecto / Conjunto           Prueba        Cambios                                   Creado por      Fecha
● Listo           Torre B / Coord. general      v14 04-11     23 incidencias · 410 estados · 0 asign.   C. Rojas        05-11 18:20  [Revisar]
⚠ Listo (desact.) Edif. C / MEP                 v7  01-11     5 incidencias · 61 estados                C. Rojas        02-11 09:10  [Revisar]
✓ Aplicado        Torre B / Coord. general      v13 28-10     19 incidencias · 388 estados              C. Rojas        29-10 …     [Ver]
```
Tabs/filter chips by state. Empty state `approvals.empty`.

### 5.3 Batch review (`/aprobaciones/:batchId`)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Lote L-2026-11-05-01 · Torre B / Coordinación general · Prueba v14 (04-11-2026)   ● Listo     │
│ Creado por C. Rojas 05-11 18:20 · 433 cambios                                                 │
│ ⚠ Base desactualizada: el conjunto ya está en v15.   (only if stale)                         │
├ [Resumen] [Cambios 410] [Incidencias 23] [Conflictos 2] ─────────────────────────────────────┤
│ RESUMEN                                                                                       │
│  Se escribirá en ACC:                                                                         │
│   + 23 incidencias nuevas (asignadas: CLIMA 12, SAN 6, ELE 5)          [irreversible]         │
│   ~ 410 interferencias cambian de estado: Activa → Revisada 372 · Activa → Cerrada 38         │
│   = 0 asignaciones                                                                            │
│  Origen: 381 propuestas aceptadas · 44 corregidas · 8 manuales                                │
│  Revisión: 100 % revisado por persona · 12 baja confianza (todas vistas en 3D)                │
│  Pre-chequeo con ACC: ✓ hace 2 min · 2 conflictos excluidos                                   │
│                                                                                               │
│ [Comprobar con ACC]   [Devolver a revisión]   [Descartar lote]          [Aprobar y aplicar…]  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Cambios tab** (`BatchDiffTable`, virtualized): columns — ☐, Objeto (clash id / group title, link opens the workspace at that item in a new tab), Operación, Campo, **Actual en ACC** (struck-through `text-red-700 bg-red-50 line-through` style for removed values), **Nuevo** (`text-green-800 bg-green-50`), Origen (Aceptada IA / Corregida / Manual, with reason code), Revisado por, Confianza IA. Diff semantics are git-like: one row per field change. Grouped by operation with collapsible headers. Unchecking rows excludes them (they return to triage as "pendiente de aprobación" — not lost).
- **Incidencias tab**: `IssuePreviewCard` per issue — exactly the fields ACC will receive (title, description rendered as ACC will show plain text, type/subtype, assignee, due date, location, linked clashes count, snapshot thumbnail or "Se capturará al aplicar"). Edit inline (counts as R13 correction).
- **Conflictos tab**: items where ACC changed since triage (e.g. someone closed the clash in ACC, issue already exists for this element pair). Excluded by default; each has "Incluir de todos modos" or "Devolver a revisión".
- **Pre-chequeo** ("Comprobar con ACC") **[contract: `POST /api/batches/:id/preflight` → refreshes `accCurrent`, returns conflicts]**: runs automatically on opening if last preflight > 10 min; approval is disabled until a preflight < 10 min old exists.
- **Stale base**: if `stale`, approve requires checking "Aplicar igualmente sobre la versión v14" and a note.

### 5.4 Irreversible-action confirmation (`ApplyConfirmDialog`)
```
┌ Aprobar y aplicar en ACC ───────────────────────────────────────┐
│ Vas a escribir en Autodesk Construction Cloud (Torre B):         │
│  • Crear 23 incidencias — NO se pueden eliminar desde esta       │
│    herramienta (solo anular en ACC).                             │
│  • Cambiar el estado de 410 interferencias.                      │
│ Los destinatarios recibirán notificaciones de ACC.               │
│                                                                  │
│ ☐ Revisé el resumen y los cambios de este lote.                  │
│ Escribe APLICAR para confirmar: [__________]                     │  ← only if issues > 0 or changes ≥ 50
│                                     [Cancelar]  [Aplicar 433]    │
└──────────────────────────────────────────────────────────────────┘
```
- Button disabled until checkbox (+ typed word, case-insensitive, localized: `APLICAR` / `APPLY`) are satisfied. Button `bg-brand` with explicit count.
- If `approval.requireSecondApprover` (config; default off) applies (e.g. batch has P1 issues), the creator sees "Solicitar aprobación" instead and a different user must approve.

### 5.5 Apply progress
`ApplyProgress`: per-operation progress bars (Incidencias 12/23, Estados 300/410), live log, can leave page (applying continues server-side; nav badge shows a spinner). Each item has an idempotency key so "Reintentar fallidos" never duplicates. Final state `applied` or `partial` with a failures table (item, ACC error message translated when known, "Reintentar" / "Devolver a revisión"). Success toast links to created issues in ACC.

### 5.6 Audit trail (`/auditoria` and per-batch "Historial" section)
Every event is append-only **[contract: `GET /api/audit?…` → `AuditEvent { id, at, actor: { type: "agent" | "user" | "server"; id; name }, action, projectId, modelSetId?, testId?, batchId?, targetIds[], details, accResponseId? }`]**. Actions: `proposal.created`, `proposal.updated`, `decision.accepted|corrected|rejected|postponed|undone`, `batch.created|ready|returned|discarded|approved`, `preflight.run`, `acc.issue.created`, `acc.clash.statusChanged`, `acc.error`, `rule.suggested|approved|disabled`, `settings.changed`.
Table with filters (proyecto, usuario, acción, rango de fechas, lote), row expand shows JSON details in a readable key/value view, "Exportar CSV". For any ACC write the chain is visible: agent run → proposal → human decision (+reason) → batch → approver → ACC response id.

---

## 6. Dashboard and reports

### 6.1 Home (`/`)
```
┌ Hola, Camila ───────────────────────────────────────────────────────────────────────────┐
│ ┌ Tu cola ───────────────────────────────┐ ┌ Lotes por aprobar ───────────────────────┐ │
│ │ Torre B / Coord. general  692 pend. ▶  │ │ L-…-01 Torre B · 433 cambios   [Revisar] │ │
│ │ Edificio C / MEP          41 pend.  ▶  │ │                                          │ │
│ └────────────────────────────────────────┘ └──────────────────────────────────────────┘ │
│ KPIs (semana): [Interferencias activas 3 412 ▼8 %] [Grupos 1 812] [Revisados 1 120]     │
│                [Incidencias creadas 23] [Aceptación IA 88 %] [Horas ahorradas ≈ 31 h]   │
│ ┌ Actividad del agente ─────────────────────────────────────────────────────────────┐   │
│ │ hace 12 min  Agrupó 3 412 interferencias en 1 812 grupos (Torre B, v14)            │   │
│ │ hace 1 h     Redactó 23 borradores de incidencia                                  │   │
│ └───────────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```
"Tu cola" rows link straight into the workspace with `?decision=pendiente`. If not authenticated, Home shows the sign-in card (current Home behavior, translated, SalfaCorp copy).

### 6.2 Reports (`/reportes`, `/reportes/:projectId`)
Use `chart.js` + `react-chartjs-2` (already dependencies); reuse the `chartOptions`/tooltip styling from `DashboardPanel.tsx` (extract into `src/lib/charts/theme.ts`). Filters: proyecto, conjunto, rango de fechas.

| # | Widget | Definition | Chart |
|---|---|---|---|
| K1 | Interferencias activas | count with ACC status Activa in latest test; delta vs previous test | `KpiTile` |
| K2 | Grupos | groups in latest test; "reducción" = 1 − groups/raw clashes | `KpiTile` |
| K3 | Revisado | groups decided / total (latest test) | `KpiTile` with bar |
| K4 | Incidencias creadas / cerradas | in range, from ACC via audit + issue status | `KpiTile` |
| K5 | Aceptación de propuestas IA | accepted / (accepted + corrected + rejected), range | `KpiTile` |
| K6 | Tiempo ahorrado (estimado) | `rawClashesReviewed × baselineSecPerClash − actualReviewSeconds`; `baselineSecPerClash` default 45 s, editable in Ajustes; shown with "estimado" label and formula tooltip | `KpiTile` |
| C1 | Burn-down por versión de prueba | x = test runs (date · version), stacked counts by ACC status (Activa / Revisada / Resuelta / Cerrada) + line of "válidas" | stacked bar |
| C2 | Matriz de pares de disciplinas | rows/cols = disciplines, cell = active valid clashes; click opens workspace filtered by pair | HTML table heatmap (single-hue sequential brand scale `bg-brand/5` → `bg-brand/80`, number always printed) |
| C3 | Interferencias por estado y par | horizontal stacked bar per pair | bar |
| C4 | Nuevas vs. resueltas por prueba | two series per test run | grouped bar |
| C5 | Correcciones por código de razón | count per reason code (range) | horizontal bar |
| C6 | Calibración de confianza | per band: proposals, % accepted unchanged | table + bar |
| C7 | Antigüedad de P1 abiertos | P1 groups by age bucket (<1 sem, 1–2, 2–4, >4) | bar |

Status colors in charts match BRAND.md badges: Activa `#A16207` (yellow-700), Revisada `#A32428`, Resuelta `#15803D`, Cerrada `#9CA3AF`. Every chart has a "Ver tabla" toggle (accessible data table) and "Exportar CSV". Print stylesheet: `@media print` hides nav, charts at full width (report-to-PDF via browser).

### 6.3 Rules & learning (`/reglas`)
Tabs:
- **Reglas** — table: id (`font-mono`), nombre (es), alcance (par/categorías), efecto (validez/prioridad/responsable/agrupación), estado (activa/borrador/desactivada), coincidencias (7 días), **aceptación** (% of its proposals accepted unchanged), correcciones, última edición. Sort by worst acceptance to find misfiring rules. Row → `/reglas/:ruleId`: description, conditions rendered readable (from YAML), recent hits list with decisions (links into workspace), correction reasons distribution, "Desactivar" (writes via server, audited). Editing the YAML itself happens in the repo (the agent/coordinator in Claude Code); the page shows the file path and a "Copiar ruta" button.
- **Sugerencias** — `RuleSuggestionCard`: "12 correcciones R02 en EST×SAN · 'pasada prevista' en losas", the agent's proposed rule as a readable summary + YAML diff (`<pre>` with +/- lines colored green/red), affected past items count, buttons "Aprobar regla" / "Rechazar" / "Copiar para editar en Claude Code". Approval writes the rule file via the server and records `rule.approved`.
- **Correcciones** — log table of `Decision` with kind `correct|reject`: fecha, usuario, objeto, campo, IA → humano, razón, nota, regla(s), confianza. Filters; "Exportar como casos de evaluación" (JSONL).
- **Calibración** — C6 detail per field (validez/prioridad/responsable) and per source (regla vs IA), plus spot-check correction rate.

---

## 7. Component inventory

Paths: shared UI in `src/lib/components/`, workspace-specific in `src/features/triage/`, approvals in `src/features/approvals/`, reports in `src/features/reports/`, rules in `src/features/rules/`. Icons: inline SVG components in `src/lib/components/icons.tsx` (no emoji in the new UI; 16 px, `stroke-current`, `aria-hidden` + adjacent text or `aria-label`).

### 7.1 Reuse (as is or with small changes)

| Existing | Reuse for | Change needed |
|---|---|---|
| `ForgeViewer.tsx` | Workspace viewer | Add `extensions?: string[]` prop; `onModelsLoaded(map, failed)`; `getModelByUrn` on `__apsViewer`; progress callback `(loaded, total)`; translate the two state messages via i18n; replace emoji spinner with CSS spinner. |
| `viewer-tools/shader-effects.ts` | Glow technique, overlay helpers | Extend into `showClashPair` (§3.8): multi-model, two colors, simultaneous ghost + glow, no full-tree overlay X-ray, mesh cache, reduced-motion. Keep old exports for `/data-management`. |
| `viewer-tools/marker-service.ts` | Clash point markers | Use `addSonarMarker` (active clash) / `addObjectMarker` (group members); add `onMarkerClick` wiring to select clash; `clearAllMarkers` on selection change. |
| `viewer-tools/panels/ElementTooltip.tsx` + `tooltip-service.ts` | Hover info in workspace | Optional `sideOf(dbId)` resolver to prefix A/B. |
| `viewer-tools/property-service.ts` | Property compare modal, level lookup fallback | None. |
| `viewer-tools/panels/DashboardPanel.tsx` | Visual pattern for KPI tiles + chart options | Extract `KpiTile`, `ChartCard`, chart theme into shared modules; the panel itself is not used in the coordinator UI. |
| `auth-context.tsx` | Auth everywhere | None. |
| `routes/layout.tsx`, `nav.tsx` | App shell | Rewrite nav content (§2.3). |
| Legacy `docs/legacy/clash-viewer.tsx` | Reference only: status style map → `StatusBadge`; cascading hub/project select → `ProjectsPage`; clash row content → `ClashRow` | Do not copy the page; it is replaced by the workspace. |
| `ColorLegend`, `MarkerPanel`, `MarkerToolbar`, `ShaderToolbar`, `GanttPanel`, `PropertyPanel` | Not used in coordinator flows | Stay on `/data-management`. |

### 7.2 New components

| Component | Purpose | Key props | Tailwind guidance |
|---|---|---|---|
| `AuthGate` | Login wall | `children` | Card pattern; primary button `px-6 py-2 rounded-lg bg-brand hover:bg-brand-light text-white font-medium` |
| `PageHeader` | Title + breadcrumb + actions | `title, crumbs, actions` | `h1 text-2xl font-bold text-brand`; crumbs `text-sm text-gray-500` |
| `LanguageSwitch` | ES/EN | — | `inline-flex rounded border border-brand-muted/30 text-xs`; active `bg-brand text-white` |
| `AgentStatusIndicator` | Agent heartbeat | `status` | dot `h-2 w-2 rounded-full` |
| `CopyCommand` | Copy agent prompt | `text` | `font-mono text-xs bg-gray-50 border border-brand-muted/20 rounded px-2 py-1` + icon button |
| `ProjectCard`, `ModelSetCard` | Pickers | summary | Card pattern from BRAND.md, `p-4` |
| `TestVersionSelect` | Test run picker | `tests, value, onChange` | select style from legacy (`px-3 py-1.5 rounded bg-white border border-brand-muted/30 text-sm`) |
| `ProgressMeter` | Reviewed/total | `done, total, breakdown` | track `h-1.5 rounded-full bg-brand-surface`, fill `bg-brand` |
| `Banner` | stale / info / warning / error | `tone, children, actions` | warning `bg-amber-50 border-amber-200 text-amber-800`; info `bg-brand-surface text-brand`; error per BRAND.md |
| `FilterBar`, `FilterChip`, `MultiSelectPopover` | Filters | `facets, value, onChange` | chip `rounded-full border border-brand-muted/30 px-2.5 py-0.5 text-xs`, active `border-brand-light/40 bg-brand/5 text-brand` |
| `SortMenu`, `SavedViewsMenu`, `SearchInput` | List controls | | input `border-brand-muted/30 focus:ring-2 focus:ring-brand/30 focus:border-brand-light` |
| `GroupList` | Virtualized list | `rows, cursor, checked, onCursor…` | `role="listbox"`, `aria-activedescendant` |
| `GroupRow`, `ClashRow` | Rows | row model | §3.3 heights 56/36 px; cursor `bg-brand-surface border-l-2 border-brand` |
| `SelectionBar` | Bulk actions | `count, actions` | §3.3 |
| `PriorityChip` | P1–P4 | `value, edited?` | P1 `bg-brand text-white`; P2 `bg-brand/10 text-brand border border-brand-light/30`; P3 `bg-amber-50 text-amber-800 border border-amber-200`; P4 `bg-gray-100 text-gray-600 border border-gray-200`; all `rounded px-1.5 text-[10px] font-semibold` |
| `ConfidenceBadge`, `ConfidenceDots` | §4.1 | `value` | §4.1 |
| `SourceBadge` | §4.2 | `source, ruleIds` | §4.2 |
| `DeltaBadge` | §4.3 | `delta` | `rounded px-1.5 text-[10px] uppercase tracking-wide` |
| `ValidityBadge` | Válida / FP / … | `value` | Válida `text-brand`, FP `text-gray-500 line-through-none`, Tolerable `text-gray-600`, Duplicada `text-gray-500`, Por confirmar `text-amber-800` (+ icon) |
| `StatusBadge` | ACC status | `status` | BRAND.md status badges |
| `DisciplinePairChip` | A × B | `a, b` | swatch A `h-2.5 w-2.5 bg-clash-a` square; B triangle SVG `fill-clash-b`; text `text-xs font-medium` |
| `DecisionStateIcon` | §3.3 | `state` | |
| `ClashViewerPane` | Viewer + overlays orchestration | `test, selection, mode` | `relative flex-1 min-w-0` |
| `ClashViewerToolbar` | Modes & tools | `mode, onMode…` | `absolute right-3 top-3 flex gap-1 rounded-lg bg-white/95 border border-brand-muted/20 shadow-sm p-1`; buttons `h-8 px-2 text-xs rounded hover:bg-brand-surface`, active `bg-brand text-white` |
| `ClashLegend` | A/B legend | `a, b, distance` | §3.8 |
| `DetailPanel` + sections `EvidenceSection`, `ElementCard`, `ProposalCard`, `ProposalFieldRow`, `RationaleBlock`, `ChangeSinceLastTest`, `IssueDraftEditor`, `HistoryTimeline` | §3.7 | | section header `text-xs font-semibold uppercase tracking-wide text-gray-500 px-4 pt-4 pb-2`; body `px-4 pb-4 text-sm text-gray-800`; dividers `border-t border-brand-muted/20` |
| `DecisionBar` | Action buttons | `onAccept…, decision` | §3.7 |
| `ReasonCodePicker` | §4.4 | `field, aiValue, humanValue, suggested, onSave` | modal `rounded-lg bg-white shadow-xl border border-brand-muted/20 w-[420px]`; options `role="radiogroup"`, selected `bg-brand/5 border-brand-light/40` |
| `BulkConfirmDialog` | §3.5 | breakdown | |
| `PropertyCompareModal` | A vs B properties | `a, b` | two-column table, differing rows `bg-amber-50` |
| `ShortcutOverlay` | `?` | registry | `fixed inset-0 bg-black/30` + centered card, 3 columns of `kbd` + label |
| `Toast` / `UndoToast` | Feedback | `message, action` | `fixed bottom-12 left-1/2 -translate-x-1/2 rounded-lg bg-gray-900 text-white text-sm px-4 py-2 shadow-lg` |
| `StatusBar` | Session meter, save, viewer state | | `flex-shrink-0 px-4 py-1 border-t border-brand-muted/20 bg-white/80 text-xs text-gray-500 flex gap-4` (same as existing status bars) |
| `EmptyState`, `ErrorState`, `Skeleton` | States | `title, body, action` | Empty: `p-8 text-center text-gray-500`; Error: BRAND.md; Skeleton: `bg-brand-surface animate-pulse rounded` |
| `BatchTable`, `BatchSummary`, `BatchDiffTable`, `IssuePreviewCard`, `PreflightStatus`, `ApplyConfirmDialog`, `ApplyProgress` | §5 | | diff old `bg-red-50 text-red-700 line-through`, new `bg-green-50 text-green-800`; irreversible tag `text-[10px] uppercase text-red-700 border border-red-200 rounded px-1` |
| `AuditTable` | §5.6 | | |
| `RulesTable`, `RuleDetail`, `RuleSuggestionCard`, `CorrectionsTable`, `CalibrationTable` | §6.3 | | YAML diff `<pre className="text-xs font-mono">` lines `+` `bg-green-50`, `-` `bg-red-50` |
| `KpiTile`, `ChartCard`, `DisciplineMatrix` | §6 | | KpiTile: Card pattern, value `text-2xl font-bold text-gray-900 tabular-nums`, label `text-xs text-gray-500`, delta `text-xs` green/red with arrow icon |
| `Kbd` | key hint | `children` | §3.7 |

### 7.3 Theme tokens to add to `src/app.css`
```css
@theme {
  /* existing brand tokens … */
  --color-clash-a: #0072B2;      /* Okabe-Ito blue  — side A (left)  */
  --color-clash-a-ink: #005A8C;  /* A text on white (AA 7.1:1) */
  --color-clash-b: #E69F00;      /* Okabe-Ito orange — side B (right) */
  --color-clash-b-ink: #8A5A00;  /* B text on white (AA 5.9:1) */
}
```
Use `bg-clash-a`, `text-clash-a-ink`, `border-clash-b`, etc. Never put text in `clash-b` on white (2.1:1). Global focus style: `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand`.

### 7.4 State management
No new state library. One `TriageStore` per workspace (`src/features/triage/store.ts`) implemented with `useSyncExternalStore`: normalized `groups`, `clashes`, `proposals`, `decisions` (Maps), `cursor`, `checked:Set`, `filters`, derived `visibleRowIds` (memoized). Components subscribe with selectors so moving the cursor re-renders only two rows + detail pane. Undo stack lives in the store.

---

## 8. i18n

### 8.1 Mechanism
No i18n library is installed; implement a minimal one (`src/i18n/index.tsx`):
- `es.json` / `en.json` nested objects; lookup by dotted key: `t("workspace.sendToApproval", { count: 412 })`.
- Interpolation `{name}`. Plurals: keys suffixed `_one` / `_other`, resolved with `Intl.PluralRules(lang)` when params include `count`.
- Numbers via `Intl.NumberFormat("es-CL")` / `"en-US"` (`fmt.number`, `fmt.mm` helpers); dates `Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" })` → `04-11-2026`; relative times via `Intl.RelativeTimeFormat`.
- `I18nProvider` in `main.tsx`; `useT()` hook; sets `document.documentElement.lang`. Missing key in `en` falls back to `es`; missing in both renders the key and `console.warn` in dev.
- Agent-produced text (rationale, group titles, issue drafts) is **content**, not UI strings — shown as written (Spanish).
- Discipline names and rule names come from `rules/` data (they carry their own `es`/`en` labels).

### 8.2 `src/i18n/es.json`
```json
{
  "app": {
    "name": "Coordinación BIM",
    "company": "SalfaCorp",
    "governance": "Uso sujeto al Procedimiento Acceso Herramientas IA de SalfaCorp",
    "version": "v{version}"
  },
  "nav": {
    "home": "Inicio",
    "projects": "Proyectos",
    "approvals": "Aprobaciones",
    "rules": "Reglas",
    "reports": "Reportes",
    "audit": "Auditoría",
    "settings": "Ajustes",
    "signOut": "Cerrar sesión",
    "language": "Idioma"
  },
  "agent": {
    "active": "Agente activo",
    "idle": "Agente inactivo",
    "lastActivity": "Última actividad {time}",
    "analyzing": "El agente está analizando…",
    "never": "El agente aún no ha trabajado en este proyecto",
    "copyCommand": "Copiar comando",
    "commandCopied": "Comando copiado. Pégalo en Claude Code.",
    "commandHint": "Ejecuta este pedido en Claude Code para que el agente analice el conjunto:"
  },
  "auth": {
    "required": "Debes iniciar sesión con tu cuenta de Autodesk para continuar.",
    "signIn": "Iniciar sesión con Autodesk",
    "signedIn": "Sesión iniciada",
    "expired": "Tu sesión expiró. Tus decisiones sin guardar se conservan.",
    "signInAgain": "Volver a iniciar sesión"
  },
  "common": {
    "loading": "Cargando…",
    "retry": "Reintentar",
    "cancel": "Cancelar",
    "save": "Guardar",
    "close": "Cerrar",
    "confirm": "Confirmar",
    "edit": "Editar",
    "delete": "Eliminar",
    "back": "Volver",
    "search": "Buscar…",
    "clear": "Limpiar",
    "all": "Todos",
    "none": "Ninguno",
    "yes": "Sí",
    "no": "No",
    "more": "Ver más",
    "less": "Ver menos",
    "copy": "Copiar",
    "copied": "Copiado",
    "export": "Exportar",
    "exportCsv": "Exportar CSV",
    "showTable": "Ver tabla",
    "showChart": "Ver gráfico",
    "open": "Abrir",
    "openInNewTab": "Abrir en pestaña nueva",
    "error": "Error",
    "unknownError": "Error desconocido",
    "notFound": "Página no encontrada",
    "goHome": "Ir al inicio",
    "by": "por {name}",
    "ago": "hace {time}",
    "of": "{current} de {total}",
    "mm": "{value} mm",
    "estimated": "estimado"
  },
  "home": {
    "greeting": "Hola, {name}",
    "subtitle": "Revisa las propuestas del agente y aprueba los cambios hacia ACC.",
    "myQueue": "Tu cola",
    "pending_one": "{count} pendiente",
    "pending_other": "{count} pendientes",
    "queueEmpty": "No tienes revisiones pendientes.",
    "batchesToApprove": "Lotes por aprobar",
    "noBatches": "No hay lotes esperando aprobación.",
    "agentActivity": "Actividad del agente",
    "noActivity": "Sin actividad reciente del agente.",
    "weekKpis": "Esta semana",
    "signInTitle": "Coordinación BIM asistida por IA",
    "signInBody": "Conecta tu cuenta de Autodesk para revisar las interferencias de tus proyectos en ACC."
  },
  "projects": {
    "title": "Proyectos",
    "hubs": "Hubs",
    "selectHub": "Selecciona un hub",
    "searchProjects": "Buscar proyecto…",
    "recent": "Recientes",
    "noProjects": "No hay proyectos en este hub.",
    "modelSets_one": "{count} conjunto de modelos",
    "modelSets_other": "{count} conjuntos de modelos"
  },
  "modelSets": {
    "title": "Conjuntos de modelos",
    "empty": "Este proyecto no tiene conjuntos de Model Coordination.",
    "version": "v{version}",
    "lastTest": "Última prueba: {date} · {count} interferencias",
    "analysis": "Análisis del agente",
    "analysisUpToDate": "Actualizado (v{version})",
    "analysisStale": "Desactualizado (v{version})",
    "analysisNone": "Sin analizar",
    "reviewed": "{done} / {total} grupos revisados",
    "readyToApprove_one": "{count} decisión lista para aprobar",
    "readyToApprove_other": "{count} decisiones listas para aprobar",
    "openWorkspace": "Abrir coordinación"
  },
  "workspace": {
    "title": "Coordinación",
    "test": "Prueba",
    "testOption": "{date} · v{version} · {count} interferencias",
    "analyzed": "(analizada)",
    "progress": "{done} / {total} revisados",
    "sendToApproval_one": "Enviar {count} a aprobación",
    "sendToApproval_other": "Enviar {count} a aprobación",
    "sentToApproval": "Se enviaron {count} decisiones al lote {batch}.",
    "viewBatch": "Ver lote",
    "loading": "Cargando interferencias y propuestas…",
    "newProposals_one": "El agente agregó o actualizó {count} propuesta.",
    "newProposals_other": "El agente agregó o actualizó {count} propuestas.",
    "refresh": "Actualizar (Shift+R)",
    "acceptInherited": "Aceptar heredadas ({count})",
    "noAnalysis": {
      "title": "El agente aún no analiza esta prueba",
      "body": "Pide al agente en Claude Code que analice el conjunto. Las propuestas aparecerán aquí automáticamente.",
      "manual": "Revisar interferencias sin propuestas"
    },
    "toggleDetail": "Mostrar u ocultar panel de detalle",
    "elementInGroups": "Este elemento participa en {count} grupos"
  },
  "list": {
    "viewGroups": "Grupos",
    "viewClashes": "Interferencias",
    "groupsCount": "{count} grupos",
    "clashesCount": "{count} interferencias",
    "emptyFiltered": "Ningún elemento coincide con los filtros.",
    "clearFilters": "Limpiar filtros",
    "allDone": "Todo revisado. {count} decisiones listas para aprobación.",
    "selected": "{count} seleccionados",
    "selectAllFiltered": "Seleccionar los {count} filtrados",
    "clearSelection": "Quitar selección",
    "noViewer": "Sin vista 3D (modelo no cargado)",
    "edited": "Modificado por ti"
  },
  "filters": {
    "add": "Filtro",
    "decision": "Decisión",
    "pair": "Par de disciplinas",
    "validity": "Validez propuesta",
    "priority": "Prioridad",
    "confidence": "Confianza",
    "level": "Nivel",
    "accStatus": "Estado ACC",
    "delta": "Cambio",
    "source": "Origen",
    "owner": "Responsable",
    "issue": "Incidencia",
    "issueDraft": "Con borrador",
    "issueExisting": "Con incidencia existente",
    "issueNone": "Sin incidencia"
  },
  "sort": {
    "label": "Orden",
    "priority": "Prioridad",
    "confidenceAsc": "Baja confianza primero",
    "countDesc": "Más interferencias",
    "distance": "Mayor penetración",
    "level": "Nivel",
    "pair": "Par de disciplinas",
    "delta": "Nuevas primero",
    "updated": "Actualizadas recientemente"
  },
  "views": {
    "label": "Vistas",
    "save": "Guardar vista actual",
    "name": "Nombre de la vista",
    "pendingHigh": "Pendientes P1–P2",
    "lowConfidence": "Baja confianza",
    "newInTest": "Nuevas en esta prueba",
    "proposedFalsePositives": "Falsos positivos propuestos",
    "withIssueDraft": "Con borrador de incidencia",
    "resolvedByTest": "Resueltas por la prueba"
  },
  "decision": {
    "pending": "Pendiente",
    "accepted": "Aceptada",
    "corrected": "Corregida",
    "rejected": "Rechazada",
    "postponed": "Pospuesta",
    "inherited": "Heredada",
    "summary": "{decision} por {user} · {time}",
    "undo": "Deshacer (U)",
    "undone": "Deshecho: {action}",
    "redo": "Rehacer"
  },
  "actions": {
    "accept": "Aceptar",
    "acceptTooltip": "Aceptar: tú confirmas esta propuesta (quedará registrado con tu nombre)",
    "edit": "Editar",
    "reject": "Rechazar",
    "postpone": "Posponer",
    "issue": "Incidencia",
    "note": "Nota",
    "acceptSelected": "Aceptar propuestas",
    "rejectSelected": "Rechazar…",
    "setPriority": "Prioridad",
    "setValidity": "Validez",
    "merge": "Agrupar",
    "split": "Separar del grupo",
    "nothingToAccept": "No hay propuesta que aceptar"
  },
  "priority": {
    "p1": "P1 Crítica",
    "p2": "P2 Alta",
    "p3": "P3 Media",
    "p4": "P4 Baja",
    "short1": "P1",
    "short2": "P2",
    "short3": "P3",
    "short4": "P4"
  },
  "validity": {
    "valid": "Válida",
    "falsePositive": "Falso positivo",
    "tolerable": "Tolerable",
    "duplicate": "Duplicada",
    "toConfirm": "Por confirmar"
  },
  "accStatus": {
    "active": "Activa",
    "reviewed": "Revisada",
    "resolved": "Resuelta",
    "closed": "Cerrada",
    "unknown": "Desconocido ({value})"
  },
  "confidence": {
    "label": "Confianza",
    "high": "Alta",
    "medium": "Media",
    "low": "Baja",
    "value": "Confianza {value}",
    "calibrated": "Calibrada con {count} decisiones: el {pct} de las propuestas con esta confianza fueron aceptadas sin cambios.",
    "uncalibrated": "Calibración insuficiente (menos de {min} decisiones en este rango)."
  },
  "source": {
    "label": "Origen",
    "rule": "Regla {id}",
    "ruleGeneric": "Regla",
    "llm": "IA",
    "ruleLlm": "Regla + IA",
    "manual": "Manual",
    "llmDetail": "Juicio de IA — modelo {model}, ejecución {runId}",
    "legend": "Regla = resultado determinista de una regla del proyecto. IA = juicio del modelo de lenguaje; revísalo con más atención."
  },
  "delta": {
    "label": "Cambio",
    "new": "Nueva",
    "persisting": "Persistente",
    "persistingFor_one": "Persistente ({count} prueba)",
    "persistingFor_other": "Persistente ({count} pruebas)",
    "reappeared": "Reaparecida",
    "modified": "Modificada",
    "resolved": "Resuelta",
    "distanceChange": "{from} → {to} mm",
    "inheritedFrom": "Heredada de {date} ({user}, {reason})",
    "groupSummary": "{new} nuevas · {persisting} persistentes · {reappeared} reaparecidas",
    "noPrevious": "Primera prueba analizada para este conjunto",
    "elementMissing": "Un elemento ya no existe en la versión más reciente"
  },
  "detail": {
    "group": "Grupo {current} de {total}",
    "clash": "Interferencia {current} de {total}",
    "evidence": "Evidencia",
    "penetrationRange": "Penetración máx. {max} mm · mín. {min} mm",
    "clearance": "Holgura {value} mm",
    "location": "Ubicación",
    "level": "Nivel {level}",
    "grid": "Ejes {grid}",
    "elementA": "A",
    "elementB": "B",
    "category": "Categoría",
    "type": "Tipo",
    "system": "Sistema",
    "model": "Modelo",
    "elementId": "ID",
    "compareProperties": "Comparar propiedades (P)",
    "clashes": "Interferencias ({count})",
    "proposal": "Propuesta del agente",
    "field": {
      "validity": "Validez",
      "priority": "Prioridad",
      "owner": "Responsable",
      "action": "Acción",
      "group": "Agrupación"
    },
    "actionCreateIssue": "Crear incidencia",
    "actionSetStatus": "Estado → {status}",
    "actionNone": "Sin acción en ACC",
    "rationale": "Razonamiento",
    "signals": "Señales",
    "rulesApplied": "Reglas aplicadas",
    "changes": "Cambios desde la prueba anterior",
    "issueDraft": "Borrador de incidencia",
    "history": "Historial",
    "noHistory": "Sin historial",
    "collapse": "Contraer panel",
    "expand": "Expandir panel"
  },
  "issue": {
    "title": "Título",
    "description": "Descripción",
    "type": "Tipo de incidencia",
    "subtype": "Subtipo",
    "ownerDiscipline": "Disciplina responsable",
    "assignee": "Asignado a",
    "dueDate": "Fecha límite",
    "location": "Ubicación",
    "includeView": "Incluir vista 3D",
    "pinView": "Fijar vista actual",
    "viewPinned": "Vista fijada",
    "snapshotAtApply": "La imagen se capturará al aplicar",
    "linkedClashes": "{count} interferencias vinculadas",
    "create": "Crear borrador de incidencia",
    "remove": "Quitar incidencia",
    "existing": "Incidencia existente en ACC: {id}"
  },
  "viewer": {
    "mode": "Modo",
    "isolate": "Aislar",
    "xray": "Rayos X",
    "context": "Contexto",
    "fit": "Ajustar a la vista (Z)",
    "sectionBox": "Caja de sección (B)",
    "markers": "Marcadores (M)",
    "onlyA": "Solo A ([)",
    "onlyB": "Solo B (])",
    "both": "Ambos (=)",
    "legendA": "A · {discipline} · {element}",
    "legendB": "B · {discipline} · {element}",
    "simplified": "Resaltado simplificado (grupo grande)",
    "initializing": "Iniciando visor…",
    "initFailed": "No se pudo iniciar el visor",
    "loadingModels": "Cargando modelos ({loaded}/{total})…",
    "ready": "Visor listo ({loaded}/{total} modelos)",
    "modelFailed": "No se pudo cargar «{name}». Las interferencias con este modelo se muestran sin 3D."
  },
  "reasons": {
    "title": "¿Por qué corriges la propuesta?",
    "rejectTitle": "¿Por qué rechazas la propuesta?",
    "fieldChange": "Campo: {field}  {from} → {to}",
    "note": "Nota (opcional)",
    "noteRequired": "Nota (obligatoria)",
    "suggestRule": "Sugerir una regla para casos similares",
    "suggested": "Sugerido",
    "R01": "Falso positivo geométrico (no se tocan o bajo tolerancia)",
    "R02": "Penetración prevista (pasada, manga, shaft)",
    "R03": "Tolerancia admisible (aislación, recubrimiento, holgura aceptada)",
    "R04": "Duplicada de otra interferencia o grupo",
    "R05": "Elemento provisorio, de referencia o fuera de alcance",
    "R06": "Disciplina o sistema mal identificado",
    "R07": "Agrupación incorrecta (dividir o unir)",
    "R08": "Prioridad sobreestimada",
    "R09": "Prioridad subestimada",
    "R10": "Responsable incorrecto",
    "R11": "Ya resuelto en una versión más reciente del modelo",
    "R12": "Acción incorrecta",
    "R13": "Redacción de la incidencia",
    "R99": "Otro"
  },
  "bulk": {
    "title": "Aceptar {count} propuestas",
    "breakdown": "Alta: {high} · Media: {medium} · Baja: {low} · P1: {p1}",
    "excludedRisky": "Se excluyen {count} de baja confianza o P1 que no revisaste en 3D.",
    "includeRisky": "Incluir {count} de baja confianza / P1 no revisadas",
    "cap": "Máximo {max} elementos por acción masiva.",
    "confirm": "Aceptar {count}",
    "rejectTitle": "Rechazar {count} propuestas"
  },
  "guard": {
    "lookFirst": "Revisa la interferencia en 3D antes de aceptar · pulsa A de nuevo para confirmar",
    "paceNudge": "Estás aceptando muy rápido (≥95 % en menos de 2 s cada una). Tómate un momento para revisar las de baja confianza.",
    "spotCheck": "Revisión aleatoria",
    "spotCheckTooltip": "Propuesta seleccionada al azar para control de calidad. Revísala con atención."
  },
  "stale": {
    "banner": "Hay una versión más reciente del conjunto (v{latest}). Las propuestas se generaron sobre v{analyzed}.",
    "newerTest": "Existe una prueba más reciente ({date}).",
    "openLatest": "Abrir prueba más reciente",
    "copyReanalyze": "Copiar comando para re-analizar",
    "details": "Detalles"
  },
  "save": {
    "saving": "Guardando…",
    "saved": "Guardado",
    "failed": "No se pudieron guardar {count} decisiones",
    "retry": "Reintentar"
  },
  "session": {
    "decisions": "{count} decisiones",
    "rate": "{value}/min",
    "medianDwell": "mediana {value} s",
    "accepted": "{pct} aceptadas"
  },
  "shortcuts": {
    "title": "Atajos de teclado",
    "open": "? Atajos",
    "navigation": "Navegación",
    "decisions": "Decisiones",
    "selection": "Selección",
    "viewer": "Visor",
    "global": "General",
    "next": "Siguiente",
    "prev": "Anterior",
    "nextClash": "Siguiente interferencia del grupo",
    "prevClash": "Interferencia anterior del grupo",
    "expand": "Expandir grupo",
    "collapse": "Contraer grupo",
    "firstLast": "Primero / último",
    "accept": "Aceptar propuesta",
    "edit": "Editar propuesta",
    "reject": "Rechazar propuesta",
    "priority": "Prioridad P1–P4",
    "validity": "Validez",
    "issue": "Borrador de incidencia",
    "postpone": "Posponer",
    "note": "Nota",
    "undo": "Deshacer",
    "redo": "Rehacer",
    "toggleCheck": "Marcar / desmarcar",
    "rangeCheck": "Marcar rango",
    "checkAll": "Marcar todos los filtrados",
    "bulkAccept": "Aceptar marcados",
    "bulkReject": "Rechazar marcados",
    "search": "Buscar",
    "filters": "Filtros",
    "cycleMode": "Cambiar modo del visor",
    "fit": "Ajustar a la vista",
    "sectionBox": "Caja de sección",
    "markers": "Marcadores",
    "sides": "Solo A / solo B / ambos",
    "rationale": "Mostrar razonamiento",
    "toggleDetail": "Panel de detalle",
    "reload": "Cargar propuestas nuevas",
    "send": "Enviar a aprobación",
    "goTo": "Ir a Aprobaciones / Inicio / Reglas / Reportes",
    "help": "Esta ayuda",
    "escape": "Cerrar / limpiar"
  },
  "approvals": {
    "title": "Aprobaciones",
    "empty": "No hay lotes. Envía decisiones desde la coordinación para crear uno.",
    "state": {
      "draft": "Borrador",
      "ready": "Listo para aprobar",
      "approved": "Aplicando",
      "applied": "Aplicado",
      "partial": "Aplicado con errores",
      "discarded": "Descartado",
      "stale": "Base desactualizada"
    },
    "columns": {
      "state": "Estado",
      "project": "Proyecto / Conjunto",
      "test": "Prueba",
      "changes": "Cambios",
      "createdBy": "Creado por",
      "date": "Fecha"
    },
    "review": "Revisar",
    "view": "Ver",
    "changesSummary": "{issues} incidencias · {statuses} estados · {assignments} asignaciones"
  },
  "batch": {
    "title": "Lote {id}",
    "createdBy": "Creado por {user} · {date} · {count} cambios",
    "tabs": {
      "summary": "Resumen",
      "changes": "Cambios",
      "issues": "Incidencias",
      "conflicts": "Conflictos"
    },
    "willWrite": "Se escribirá en ACC:",
    "issuesCreate": "{count} incidencias nuevas",
    "statusChanges": "{count} interferencias cambian de estado",
    "statusTransition": "{from} → {to}: {count}",
    "assignments": "{count} asignaciones",
    "irreversible": "Irreversible",
    "origin": "Origen: {accepted} propuestas aceptadas · {corrected} corregidas · {manual} manuales",
    "reviewCoverage": "Revisión: {pct} revisado por persona · {low} de baja confianza",
    "preflight": "Comprobar con ACC",
    "preflightOk": "Pre-chequeo con ACC: correcto {time}",
    "preflightConflicts": "{count} conflictos excluidos",
    "preflightRequired": "Ejecuta el pre-chequeo con ACC antes de aprobar.",
    "preflightRunning": "Comprobando con ACC…",
    "returnToReview": "Devolver a revisión",
    "discard": "Descartar lote",
    "discardConfirm": "¿Descartar este lote? Las decisiones vuelven a la coordinación.",
    "approve": "Aprobar y aplicar…",
    "requestApproval": "Solicitar aprobación",
    "staleWarning": "Base desactualizada: el conjunto ya está en v{latest}.",
    "staleOverride": "Aplicar igualmente sobre la versión v{version}",
    "columns": {
      "object": "Objeto",
      "operation": "Operación",
      "field": "Campo",
      "current": "Actual en ACC",
      "new": "Nuevo",
      "origin": "Origen",
      "reviewer": "Revisado por",
      "confidence": "Confianza IA"
    },
    "op": {
      "clashSetStatus": "Cambiar estado",
      "issueCreate": "Crear incidencia",
      "issueUpdate": "Actualizar incidencia",
      "issueComment": "Comentar incidencia"
    },
    "originAccepted": "Aceptada (IA)",
    "originCorrected": "Corregida",
    "originManual": "Manual",
    "conflict": "Conflicto",
    "conflictReason": "Cambió en ACC desde la revisión: {reason}",
    "includeAnyway": "Incluir de todos modos",
    "excluded": "Excluido"
  },
  "apply": {
    "title": "Aprobar y aplicar en ACC",
    "intro": "Vas a escribir en Autodesk Construction Cloud ({project}):",
    "issuesWarning": "Crear {count} incidencias — no se pueden eliminar desde esta herramienta (solo anular en ACC).",
    "statusWarning": "Cambiar el estado de {count} interferencias.",
    "notifications": "Los destinatarios recibirán notificaciones de ACC.",
    "checkbox": "Revisé el resumen y los cambios de este lote.",
    "typeToConfirm": "Escribe {word} para confirmar",
    "confirmWord": "APLICAR",
    "button": "Aplicar {count}",
    "progress": "Aplicando cambios en ACC…",
    "progressIssues": "Incidencias {done}/{total}",
    "progressStatuses": "Estados {done}/{total}",
    "canLeave": "Puedes salir de esta página; la aplicación continúa.",
    "done": "Lote aplicado: {count} cambios escritos en ACC.",
    "partial": "Lote aplicado con {count} errores.",
    "retryFailed": "Reintentar fallidos",
    "viewInAcc": "Ver en ACC"
  },
  "audit": {
    "title": "Auditoría",
    "columns": {
      "date": "Fecha",
      "actor": "Actor",
      "action": "Acción",
      "object": "Objeto",
      "details": "Detalles"
    },
    "actor": {
      "agent": "Agente",
      "user": "Usuario",
      "server": "Servidor"
    },
    "empty": "Sin eventos para estos filtros.",
    "chain": "Cadena: ejecución del agente → propuesta → decisión → lote → aprobación → ACC"
  },
  "rules": {
    "title": "Reglas y aprendizaje",
    "tabs": {
      "rules": "Reglas",
      "suggestions": "Sugerencias",
      "corrections": "Correcciones",
      "calibration": "Calibración"
    },
    "columns": {
      "id": "ID",
      "name": "Nombre",
      "scope": "Alcance",
      "effect": "Efecto",
      "state": "Estado",
      "hits": "Coincidencias (7 días)",
      "acceptance": "Aceptación",
      "corrections": "Correcciones",
      "updated": "Última edición"
    },
    "state": {
      "active": "Activa",
      "draft": "Borrador",
      "disabled": "Desactivada"
    },
    "disable": "Desactivar",
    "enable": "Activar",
    "file": "Archivo",
    "copyPath": "Copiar ruta",
    "recentHits": "Coincidencias recientes",
    "reasonDistribution": "Razones de corrección",
    "suggestionHeader": "{count} correcciones {reason} en {pair}",
    "approveRule": "Aprobar regla",
    "rejectRule": "Rechazar",
    "copyForClaude": "Copiar para editar en Claude Code",
    "affected": "Afectaría a {count} interferencias anteriores",
    "noSuggestions": "Sin sugerencias de reglas por ahora.",
    "exportEval": "Exportar como casos de evaluación",
    "calibrationBand": "Rango",
    "calibrationProposals": "Propuestas",
    "calibrationAccepted": "Aceptadas sin cambios",
    "spotCheckRate": "Correcciones en revisiones aleatorias: {pct}"
  },
  "reports": {
    "title": "Reportes",
    "portfolio": "Portafolio",
    "filters": {
      "project": "Proyecto",
      "modelSet": "Conjunto",
      "from": "Desde",
      "to": "Hasta"
    },
    "kpi": {
      "activeClashes": "Interferencias activas",
      "groups": "Grupos",
      "reduction": "Reducción {pct}",
      "reviewed": "Revisado",
      "issuesCreated": "Incidencias creadas",
      "issuesClosed": "Incidencias cerradas",
      "aiAcceptance": "Aceptación de propuestas IA",
      "timeSaved": "Tiempo ahorrado",
      "timeSavedValue": "≈ {hours} h",
      "timeSavedFormula": "Interferencias revisadas × {baseline} s (referencia manual) − tiempo real de revisión",
      "vsPrevious": "{delta} vs. prueba anterior"
    },
    "chart": {
      "burndown": "Evolución por versión de prueba",
      "matrix": "Matriz de pares de disciplinas",
      "byStatusPair": "Interferencias por estado y par",
      "newVsResolved": "Nuevas vs. resueltas por prueba",
      "reasons": "Correcciones por razón",
      "calibration": "Calibración de confianza",
      "p1Aging": "Antigüedad de P1 abiertos",
      "valid": "Válidas"
    },
    "aging": {
      "lt1w": "< 1 semana",
      "w1to2": "1–2 semanas",
      "w2to4": "2–4 semanas",
      "gt4w": "> 4 semanas"
    },
    "empty": "Aún no hay datos suficientes para este reporte.",
    "print": "Imprimir / PDF"
  },
  "settings": {
    "title": "Ajustes",
    "language": "Idioma",
    "autonomy": "Nivel de autonomía",
    "autonomyValue": "L1 · Solo propuestas (requiere aprobación humana)",
    "autonomyReadOnly": "Definido en la configuración del proyecto.",
    "autoAdvance": "Avanzar automáticamente tras decidir",
    "confidenceBands": "Umbrales de confianza",
    "highFrom": "Alta desde",
    "mediumFrom": "Media desde",
    "dwellGuard": "Tiempo mínimo de revisión en 3D para propuestas de riesgo (s)",
    "autoAcceptInherited": "Aceptar decisiones heredadas automáticamente",
    "baseline": "Referencia manual por interferencia (s)",
    "devTools": "Herramientas de desarrollo",
    "dataManagement": "Explorador de modelos (Data Management)"
  },
  "errors": {
    "load": "No se pudieron cargar los datos.",
    "server": "El servidor local no responde. ¿Está corriendo la aplicación?",
    "acc": "ACC respondió con un error: {message}",
    "forbidden": "No tienes permisos en ACC para esta acción.",
    "notFoundProject": "Proyecto no encontrado o sin acceso.",
    "notFoundModelSet": "Conjunto de modelos no encontrado.",
    "notFoundBatch": "Lote no encontrado."
  },
  "a11y": {
    "groupList": "Lista de grupos de interferencias",
    "clashList": "Lista de interferencias",
    "decisionAnnounce": "{decision}. {position}.",
    "sideA": "Lado A",
    "sideB": "Lado B",
    "skipToList": "Ir a la lista",
    "skipToDetail": "Ir al detalle"
  }
}
```

### 8.3 `src/i18n/en.json`
```json
{
  "app": {
    "name": "BIM Coordination",
    "company": "SalfaCorp",
    "governance": "Use subject to SalfaCorp's AI Tools Access Procedure",
    "version": "v{version}"
  },
  "nav": {
    "home": "Home",
    "projects": "Projects",
    "approvals": "Approvals",
    "rules": "Rules",
    "reports": "Reports",
    "audit": "Audit",
    "settings": "Settings",
    "signOut": "Sign out",
    "language": "Language"
  },
  "agent": {
    "active": "Agent active",
    "idle": "Agent idle",
    "lastActivity": "Last activity {time}",
    "analyzing": "The agent is analyzing…",
    "never": "The agent has not worked on this project yet",
    "copyCommand": "Copy command",
    "commandCopied": "Command copied. Paste it into Claude Code.",
    "commandHint": "Run this request in Claude Code so the agent analyzes the model set:"
  },
  "auth": {
    "required": "Sign in with your Autodesk account to continue.",
    "signIn": "Sign in with Autodesk",
    "signedIn": "Signed in",
    "expired": "Your session expired. Your unsaved decisions are kept.",
    "signInAgain": "Sign in again"
  },
  "common": {
    "loading": "Loading…",
    "retry": "Retry",
    "cancel": "Cancel",
    "save": "Save",
    "close": "Close",
    "confirm": "Confirm",
    "edit": "Edit",
    "delete": "Delete",
    "back": "Back",
    "search": "Search…",
    "clear": "Clear",
    "all": "All",
    "none": "None",
    "yes": "Yes",
    "no": "No",
    "more": "Show more",
    "less": "Show less",
    "copy": "Copy",
    "copied": "Copied",
    "export": "Export",
    "exportCsv": "Export CSV",
    "showTable": "Show table",
    "showChart": "Show chart",
    "open": "Open",
    "openInNewTab": "Open in new tab",
    "error": "Error",
    "unknownError": "Unknown error",
    "notFound": "Page not found",
    "goHome": "Go home",
    "by": "by {name}",
    "ago": "{time} ago",
    "of": "{current} of {total}",
    "mm": "{value} mm",
    "estimated": "estimated"
  },
  "home": {
    "greeting": "Hi, {name}",
    "subtitle": "Review the agent's proposals and approve changes to ACC.",
    "myQueue": "Your queue",
    "pending_one": "{count} pending",
    "pending_other": "{count} pending",
    "queueEmpty": "You have no pending reviews.",
    "batchesToApprove": "Batches to approve",
    "noBatches": "No batches awaiting approval.",
    "agentActivity": "Agent activity",
    "noActivity": "No recent agent activity.",
    "weekKpis": "This week",
    "signInTitle": "AI-assisted BIM coordination",
    "signInBody": "Connect your Autodesk account to review clashes in your ACC projects."
  },
  "projects": {
    "title": "Projects",
    "hubs": "Hubs",
    "selectHub": "Select a hub",
    "searchProjects": "Search project…",
    "recent": "Recent",
    "noProjects": "No projects in this hub.",
    "modelSets_one": "{count} model set",
    "modelSets_other": "{count} model sets"
  },
  "modelSets": {
    "title": "Model sets",
    "empty": "This project has no Model Coordination model sets.",
    "version": "v{version}",
    "lastTest": "Last test: {date} · {count} clashes",
    "analysis": "Agent analysis",
    "analysisUpToDate": "Up to date (v{version})",
    "analysisStale": "Out of date (v{version})",
    "analysisNone": "Not analyzed",
    "reviewed": "{done} / {total} groups reviewed",
    "readyToApprove_one": "{count} decision ready to approve",
    "readyToApprove_other": "{count} decisions ready to approve",
    "openWorkspace": "Open coordination"
  },
  "workspace": {
    "title": "Coordination",
    "test": "Test",
    "testOption": "{date} · v{version} · {count} clashes",
    "analyzed": "(analyzed)",
    "progress": "{done} / {total} reviewed",
    "sendToApproval_one": "Send {count} to approval",
    "sendToApproval_other": "Send {count} to approval",
    "sentToApproval": "{count} decisions sent to batch {batch}.",
    "viewBatch": "View batch",
    "loading": "Loading clashes and proposals…",
    "newProposals_one": "The agent added or updated {count} proposal.",
    "newProposals_other": "The agent added or updated {count} proposals.",
    "refresh": "Refresh (Shift+R)",
    "acceptInherited": "Accept inherited ({count})",
    "noAnalysis": {
      "title": "The agent has not analyzed this test yet",
      "body": "Ask the agent in Claude Code to analyze the model set. Proposals will appear here automatically.",
      "manual": "Review clashes without proposals"
    },
    "toggleDetail": "Show or hide detail panel",
    "elementInGroups": "This element is part of {count} groups"
  },
  "list": {
    "viewGroups": "Groups",
    "viewClashes": "Clashes",
    "groupsCount": "{count} groups",
    "clashesCount": "{count} clashes",
    "emptyFiltered": "Nothing matches the filters.",
    "clearFilters": "Clear filters",
    "allDone": "All reviewed. {count} decisions ready for approval.",
    "selected": "{count} selected",
    "selectAllFiltered": "Select all {count} filtered",
    "clearSelection": "Clear selection",
    "noViewer": "No 3D view (model not loaded)",
    "edited": "Changed by you"
  },
  "filters": {
    "add": "Filter",
    "decision": "Decision",
    "pair": "Discipline pair",
    "validity": "Proposed validity",
    "priority": "Priority",
    "confidence": "Confidence",
    "level": "Level",
    "accStatus": "ACC status",
    "delta": "Change",
    "source": "Source",
    "owner": "Owner",
    "issue": "Issue",
    "issueDraft": "With draft",
    "issueExisting": "With existing issue",
    "issueNone": "No issue"
  },
  "sort": {
    "label": "Sort",
    "priority": "Priority",
    "confidenceAsc": "Low confidence first",
    "countDesc": "Most clashes",
    "distance": "Deepest penetration",
    "level": "Level",
    "pair": "Discipline pair",
    "delta": "New first",
    "updated": "Recently updated"
  },
  "views": {
    "label": "Views",
    "save": "Save current view",
    "name": "View name",
    "pendingHigh": "Pending P1–P2",
    "lowConfidence": "Low confidence",
    "newInTest": "New in this test",
    "proposedFalsePositives": "Proposed false positives",
    "withIssueDraft": "With issue draft",
    "resolvedByTest": "Resolved by the test"
  },
  "decision": {
    "pending": "Pending",
    "accepted": "Accepted",
    "corrected": "Corrected",
    "rejected": "Rejected",
    "postponed": "Postponed",
    "inherited": "Inherited",
    "summary": "{decision} by {user} · {time}",
    "undo": "Undo (U)",
    "undone": "Undone: {action}",
    "redo": "Redo"
  },
  "actions": {
    "accept": "Accept",
    "acceptTooltip": "Accept: you confirm this proposal (recorded under your name)",
    "edit": "Edit",
    "reject": "Reject",
    "postpone": "Postpone",
    "issue": "Issue",
    "note": "Note",
    "acceptSelected": "Accept proposals",
    "rejectSelected": "Reject…",
    "setPriority": "Priority",
    "setValidity": "Validity",
    "merge": "Group",
    "split": "Split from group",
    "nothingToAccept": "No proposal to accept"
  },
  "priority": {
    "p1": "P1 Critical",
    "p2": "P2 High",
    "p3": "P3 Medium",
    "p4": "P4 Low",
    "short1": "P1",
    "short2": "P2",
    "short3": "P3",
    "short4": "P4"
  },
  "validity": {
    "valid": "Valid",
    "falsePositive": "False positive",
    "tolerable": "Tolerable",
    "duplicate": "Duplicate",
    "toConfirm": "To confirm"
  },
  "accStatus": {
    "active": "Active",
    "reviewed": "Reviewed",
    "resolved": "Resolved",
    "closed": "Closed",
    "unknown": "Unknown ({value})"
  },
  "confidence": {
    "label": "Confidence",
    "high": "High",
    "medium": "Medium",
    "low": "Low",
    "value": "Confidence {value}",
    "calibrated": "Calibrated on {count} decisions: {pct} of proposals at this confidence were accepted unchanged.",
    "uncalibrated": "Not enough calibration data (fewer than {min} decisions in this band)."
  },
  "source": {
    "label": "Source",
    "rule": "Rule {id}",
    "ruleGeneric": "Rule",
    "llm": "AI",
    "ruleLlm": "Rule + AI",
    "manual": "Manual",
    "llmDetail": "AI judgment — model {model}, run {runId}",
    "legend": "Rule = deterministic result of a project rule. AI = language-model judgment; review it more carefully."
  },
  "delta": {
    "label": "Change",
    "new": "New",
    "persisting": "Persisting",
    "persistingFor_one": "Persisting ({count} test)",
    "persistingFor_other": "Persisting ({count} tests)",
    "reappeared": "Reappeared",
    "modified": "Modified",
    "resolved": "Resolved",
    "distanceChange": "{from} → {to} mm",
    "inheritedFrom": "Inherited from {date} ({user}, {reason})",
    "groupSummary": "{new} new · {persisting} persisting · {reappeared} reappeared",
    "noPrevious": "First analyzed test for this model set",
    "elementMissing": "An element no longer exists in the latest version"
  },
  "detail": {
    "group": "Group {current} of {total}",
    "clash": "Clash {current} of {total}",
    "evidence": "Evidence",
    "penetrationRange": "Max penetration {max} mm · min {min} mm",
    "clearance": "Clearance {value} mm",
    "location": "Location",
    "level": "Level {level}",
    "grid": "Grid {grid}",
    "elementA": "A",
    "elementB": "B",
    "category": "Category",
    "type": "Type",
    "system": "System",
    "model": "Model",
    "elementId": "ID",
    "compareProperties": "Compare properties (P)",
    "clashes": "Clashes ({count})",
    "proposal": "Agent proposal",
    "field": {
      "validity": "Validity",
      "priority": "Priority",
      "owner": "Owner",
      "action": "Action",
      "group": "Grouping"
    },
    "actionCreateIssue": "Create issue",
    "actionSetStatus": "Status → {status}",
    "actionNone": "No ACC action",
    "rationale": "Rationale",
    "signals": "Signals",
    "rulesApplied": "Rules applied",
    "changes": "Changes since previous test",
    "issueDraft": "Issue draft",
    "history": "History",
    "noHistory": "No history",
    "collapse": "Collapse panel",
    "expand": "Expand panel"
  },
  "issue": {
    "title": "Title",
    "description": "Description",
    "type": "Issue type",
    "subtype": "Subtype",
    "ownerDiscipline": "Responsible discipline",
    "assignee": "Assigned to",
    "dueDate": "Due date",
    "location": "Location",
    "includeView": "Include 3D view",
    "pinView": "Pin current view",
    "viewPinned": "View pinned",
    "snapshotAtApply": "The snapshot will be captured on apply",
    "linkedClashes": "{count} linked clashes",
    "create": "Create issue draft",
    "remove": "Remove issue",
    "existing": "Existing ACC issue: {id}"
  },
  "viewer": {
    "mode": "Mode",
    "isolate": "Isolate",
    "xray": "X-ray",
    "context": "Context",
    "fit": "Fit to view (Z)",
    "sectionBox": "Section box (B)",
    "markers": "Markers (M)",
    "onlyA": "A only ([)",
    "onlyB": "B only (])",
    "both": "Both (=)",
    "legendA": "A · {discipline} · {element}",
    "legendB": "B · {discipline} · {element}",
    "simplified": "Simplified highlight (large group)",
    "initializing": "Initializing viewer…",
    "initFailed": "The viewer could not be initialized",
    "loadingModels": "Loading models ({loaded}/{total})…",
    "ready": "Viewer ready ({loaded}/{total} models)",
    "modelFailed": "Could not load “{name}”. Clashes with this model are shown without 3D."
  },
  "reasons": {
    "title": "Why are you correcting the proposal?",
    "rejectTitle": "Why are you rejecting the proposal?",
    "fieldChange": "Field: {field}  {from} → {to}",
    "note": "Note (optional)",
    "noteRequired": "Note (required)",
    "suggestRule": "Suggest a rule for similar cases",
    "suggested": "Suggested",
    "R01": "Geometric false positive (not touching or within tolerance)",
    "R02": "Intended penetration (sleeve, opening, shaft)",
    "R03": "Acceptable tolerance (insulation, cover, accepted clearance)",
    "R04": "Duplicate of another clash or group",
    "R05": "Temporary, reference or out-of-scope element",
    "R06": "Discipline or system misidentified",
    "R07": "Wrong grouping (split or merge)",
    "R08": "Priority overestimated",
    "R09": "Priority underestimated",
    "R10": "Wrong owner",
    "R11": "Already fixed in a newer model version",
    "R12": "Wrong action",
    "R13": "Issue wording",
    "R99": "Other"
  },
  "bulk": {
    "title": "Accept {count} proposals",
    "breakdown": "High: {high} · Medium: {medium} · Low: {low} · P1: {p1}",
    "excludedRisky": "{count} low-confidence or P1 items you did not review in 3D are excluded.",
    "includeRisky": "Include {count} low-confidence / P1 unreviewed",
    "cap": "Maximum {max} items per bulk action.",
    "confirm": "Accept {count}",
    "rejectTitle": "Reject {count} proposals"
  },
  "guard": {
    "lookFirst": "Review the clash in 3D before accepting · press A again to confirm",
    "paceNudge": "You are accepting very fast (≥95% in under 2 s each). Take a moment on the low-confidence ones.",
    "spotCheck": "Random check",
    "spotCheckTooltip": "Proposal randomly selected for quality control. Review it carefully."
  },
  "stale": {
    "banner": "A newer model set version exists (v{latest}). Proposals were generated on v{analyzed}.",
    "newerTest": "A newer test exists ({date}).",
    "openLatest": "Open latest test",
    "copyReanalyze": "Copy re-analyze command",
    "details": "Details"
  },
  "save": {
    "saving": "Saving…",
    "saved": "Saved",
    "failed": "{count} decisions could not be saved",
    "retry": "Retry"
  },
  "session": {
    "decisions": "{count} decisions",
    "rate": "{value}/min",
    "medianDwell": "median {value} s",
    "accepted": "{pct} accepted"
  },
  "shortcuts": {
    "title": "Keyboard shortcuts",
    "open": "? Shortcuts",
    "navigation": "Navigation",
    "decisions": "Decisions",
    "selection": "Selection",
    "viewer": "Viewer",
    "global": "General",
    "next": "Next",
    "prev": "Previous",
    "nextClash": "Next clash in group",
    "prevClash": "Previous clash in group",
    "expand": "Expand group",
    "collapse": "Collapse group",
    "firstLast": "First / last",
    "accept": "Accept proposal",
    "edit": "Edit proposal",
    "reject": "Reject proposal",
    "priority": "Priority P1–P4",
    "validity": "Validity",
    "issue": "Issue draft",
    "postpone": "Postpone",
    "note": "Note",
    "undo": "Undo",
    "redo": "Redo",
    "toggleCheck": "Check / uncheck",
    "rangeCheck": "Check range",
    "checkAll": "Check all filtered",
    "bulkAccept": "Accept checked",
    "bulkReject": "Reject checked",
    "search": "Search",
    "filters": "Filters",
    "cycleMode": "Cycle viewer mode",
    "fit": "Fit to view",
    "sectionBox": "Section box",
    "markers": "Markers",
    "sides": "A only / B only / both",
    "rationale": "Show rationale",
    "toggleDetail": "Detail panel",
    "reload": "Load new proposals",
    "send": "Send to approval",
    "goTo": "Go to Approvals / Home / Rules / Reports",
    "help": "This help",
    "escape": "Close / clear"
  },
  "approvals": {
    "title": "Approvals",
    "empty": "No batches. Send decisions from coordination to create one.",
    "state": {
      "draft": "Draft",
      "ready": "Ready to approve",
      "approved": "Applying",
      "applied": "Applied",
      "partial": "Applied with errors",
      "discarded": "Discarded",
      "stale": "Outdated base"
    },
    "columns": {
      "state": "Status",
      "project": "Project / Model set",
      "test": "Test",
      "changes": "Changes",
      "createdBy": "Created by",
      "date": "Date"
    },
    "review": "Review",
    "view": "View",
    "changesSummary": "{issues} issues · {statuses} statuses · {assignments} assignments"
  },
  "batch": {
    "title": "Batch {id}",
    "createdBy": "Created by {user} · {date} · {count} changes",
    "tabs": {
      "summary": "Summary",
      "changes": "Changes",
      "issues": "Issues",
      "conflicts": "Conflicts"
    },
    "willWrite": "Will be written to ACC:",
    "issuesCreate": "{count} new issues",
    "statusChanges": "{count} clashes change status",
    "statusTransition": "{from} → {to}: {count}",
    "assignments": "{count} assignments",
    "irreversible": "Irreversible",
    "origin": "Origin: {accepted} proposals accepted · {corrected} corrected · {manual} manual",
    "reviewCoverage": "Review: {pct} human-reviewed · {low} low confidence",
    "preflight": "Check against ACC",
    "preflightOk": "ACC pre-check: OK {time}",
    "preflightConflicts": "{count} conflicts excluded",
    "preflightRequired": "Run the ACC pre-check before approving.",
    "preflightRunning": "Checking against ACC…",
    "returnToReview": "Return to review",
    "discard": "Discard batch",
    "discardConfirm": "Discard this batch? Decisions go back to coordination.",
    "approve": "Approve and apply…",
    "requestApproval": "Request approval",
    "staleWarning": "Outdated base: the model set is already at v{latest}.",
    "staleOverride": "Apply anyway on version v{version}",
    "columns": {
      "object": "Object",
      "operation": "Operation",
      "field": "Field",
      "current": "Current in ACC",
      "new": "New",
      "origin": "Origin",
      "reviewer": "Reviewed by",
      "confidence": "AI confidence"
    },
    "op": {
      "clashSetStatus": "Change status",
      "issueCreate": "Create issue",
      "issueUpdate": "Update issue",
      "issueComment": "Comment on issue"
    },
    "originAccepted": "Accepted (AI)",
    "originCorrected": "Corrected",
    "originManual": "Manual",
    "conflict": "Conflict",
    "conflictReason": "Changed in ACC since review: {reason}",
    "includeAnyway": "Include anyway",
    "excluded": "Excluded"
  },
  "apply": {
    "title": "Approve and apply to ACC",
    "intro": "You are about to write to Autodesk Construction Cloud ({project}):",
    "issuesWarning": "Create {count} issues — they cannot be deleted from this tool (only voided in ACC).",
    "statusWarning": "Change the status of {count} clashes.",
    "notifications": "Recipients will receive ACC notifications.",
    "checkbox": "I reviewed this batch's summary and changes.",
    "typeToConfirm": "Type {word} to confirm",
    "confirmWord": "APPLY",
    "button": "Apply {count}",
    "progress": "Applying changes to ACC…",
    "progressIssues": "Issues {done}/{total}",
    "progressStatuses": "Statuses {done}/{total}",
    "canLeave": "You can leave this page; applying continues.",
    "done": "Batch applied: {count} changes written to ACC.",
    "partial": "Batch applied with {count} errors.",
    "retryFailed": "Retry failed",
    "viewInAcc": "View in ACC"
  },
  "audit": {
    "title": "Audit",
    "columns": {
      "date": "Date",
      "actor": "Actor",
      "action": "Action",
      "object": "Object",
      "details": "Details"
    },
    "actor": {
      "agent": "Agent",
      "user": "User",
      "server": "Server"
    },
    "empty": "No events for these filters.",
    "chain": "Chain: agent run → proposal → decision → batch → approval → ACC"
  },
  "rules": {
    "title": "Rules and learning",
    "tabs": {
      "rules": "Rules",
      "suggestions": "Suggestions",
      "corrections": "Corrections",
      "calibration": "Calibration"
    },
    "columns": {
      "id": "ID",
      "name": "Name",
      "scope": "Scope",
      "effect": "Effect",
      "state": "Status",
      "hits": "Hits (7 days)",
      "acceptance": "Acceptance",
      "corrections": "Corrections",
      "updated": "Last edited"
    },
    "state": {
      "active": "Active",
      "draft": "Draft",
      "disabled": "Disabled"
    },
    "disable": "Disable",
    "enable": "Enable",
    "file": "File",
    "copyPath": "Copy path",
    "recentHits": "Recent hits",
    "reasonDistribution": "Correction reasons",
    "suggestionHeader": "{count} {reason} corrections in {pair}",
    "approveRule": "Approve rule",
    "rejectRule": "Reject",
    "copyForClaude": "Copy to edit in Claude Code",
    "affected": "Would affect {count} past clashes",
    "noSuggestions": "No rule suggestions for now.",
    "exportEval": "Export as evaluation cases",
    "calibrationBand": "Band",
    "calibrationProposals": "Proposals",
    "calibrationAccepted": "Accepted unchanged",
    "spotCheckRate": "Corrections in random checks: {pct}"
  },
  "reports": {
    "title": "Reports",
    "portfolio": "Portfolio",
    "filters": {
      "project": "Project",
      "modelSet": "Model set",
      "from": "From",
      "to": "To"
    },
    "kpi": {
      "activeClashes": "Active clashes",
      "groups": "Groups",
      "reduction": "Reduction {pct}",
      "reviewed": "Reviewed",
      "issuesCreated": "Issues created",
      "issuesClosed": "Issues closed",
      "aiAcceptance": "AI proposal acceptance",
      "timeSaved": "Time saved",
      "timeSavedValue": "≈ {hours} h",
      "timeSavedFormula": "Clashes reviewed × {baseline} s (manual baseline) − actual review time",
      "vsPrevious": "{delta} vs. previous test"
    },
    "chart": {
      "burndown": "Trend by test version",
      "matrix": "Discipline pair matrix",
      "byStatusPair": "Clashes by status and pair",
      "newVsResolved": "New vs. resolved per test",
      "reasons": "Corrections by reason",
      "calibration": "Confidence calibration",
      "p1Aging": "Age of open P1",
      "valid": "Valid"
    },
    "aging": {
      "lt1w": "< 1 week",
      "w1to2": "1–2 weeks",
      "w2to4": "2–4 weeks",
      "gt4w": "> 4 weeks"
    },
    "empty": "Not enough data for this report yet.",
    "print": "Print / PDF"
  },
  "settings": {
    "title": "Settings",
    "language": "Language",
    "autonomy": "Autonomy level",
    "autonomyValue": "L1 · Proposals only (human approval required)",
    "autonomyReadOnly": "Set in the project configuration.",
    "autoAdvance": "Auto-advance after deciding",
    "confidenceBands": "Confidence thresholds",
    "highFrom": "High from",
    "mediumFrom": "Medium from",
    "dwellGuard": "Minimum 3D review time for risky proposals (s)",
    "autoAcceptInherited": "Auto-accept inherited decisions",
    "baseline": "Manual baseline per clash (s)",
    "devTools": "Developer tools",
    "dataManagement": "Model explorer (Data Management)"
  },
  "errors": {
    "load": "Could not load data.",
    "server": "The local server is not responding. Is the app running?",
    "acc": "ACC returned an error: {message}",
    "forbidden": "You do not have ACC permissions for this action.",
    "notFoundProject": "Project not found or no access.",
    "notFoundModelSet": "Model set not found.",
    "notFoundBatch": "Batch not found."
  },
  "a11y": {
    "groupList": "Clash group list",
    "clashList": "Clash list",
    "decisionAnnounce": "{decision}. {position}.",
    "sideA": "Side A",
    "sideB": "Side B",
    "skipToList": "Skip to list",
    "skipToDetail": "Skip to detail"
  }
}
```

Discipline labels, rule names, issue types and ACC user names are data, not keys. Percentages passed as `{pct}` are pre-formatted with `Intl.NumberFormat(lang, { style: "percent" })` (es-CL renders `88 %`).

---

## 9. Accessibility and performance

### 9.1 Accessibility (target WCAG 2.2 AA)
- **Color is never the only carrier**: sides = color + letter (A/B) + shape (square/triangle) in every panel; confidence = dots + word; decisions = icon + word in `aria-label`; delta = text chip.
- **Side colors**: Okabe-Ito blue `#0072B2` (A) and orange `#E69F00` (B) — distinguishable under protanopia, deuteranopia and tritanopia, and both distinct from the ghosted gray context and from brand red (selection/marker). Text uses the `-ink` variants (§7.3) for AA contrast.
- **Lists**: `GroupList` is `role="listbox"` with `aria-multiselectable="true"`, rows `role="option"` with `aria-selected` (checked) and the list uses `aria-activedescendant` for the cursor so focus stays on the list container (works with virtualization). Expanded groups expose `aria-expanded`.
- **Live region**: a polite `aria-live` region announces decisions and position ("Aceptada. Grupo 24 de 418.") — key `a11y.decisionAnnounce`.
- **Focus**: visible focus ring (§7.3). Modals trap focus and restore it to the list on close. Skip links "Ir a la lista" / "Ir al detalle".
- **Shortcuts**: single-character shortcuts are suspended in inputs (WCAG 2.1.4 compliance); Ajustes allows turning off single-key shortcuts (fallback: buttons + `Alt+key`).
- **Motion**: glow pulse, camera transitions and sonar animation respect `prefers-reduced-motion` (static glow, instant camera, static ring).
- **Viewer**: the 3D canvas is supplemental; all evidence needed to decide (elements, distance, level, grid, rationale) is available as text in the detail pane.
- **Language**: `lang` attribute follows the selected locale; agent content in Spanish is wrapped with `lang="es"` when UI is English.
- Hit targets ≥ 24×24 px; row actions also reachable by keyboard.

### 9.2 Performance (10 000 clashes, 2 000 groups, 5–10 linked models)
- **Virtualized lists**: add `@tanstack/react-virtual` (v3) for `GroupList`, flat clash list, `BatchDiffTable`, `CorrectionsTable`, `AuditTable`. Fixed row heights (56 / 36 px), overscan 10. Expanded groups are rendered as additional rows in the same virtual list (flattened row model), not nested scroll containers.
- **Data loading**: one request per workspace for the test's triage payload **[contract: `GET /api/triage/:projectId/:modelSetId?test=` → `{ test, documents, groups, clashes, proposals, decisions, facets }` in compact form; clashes as arrays of tuples or columnar if > 5k]**; target < 2 MB gzipped for 10k clashes. Element names/properties needed for rows come pre-resolved from the server (Model Properties/Index API) — the UI must **not** call `getElementName` per row as the legacy viewer did.
- **Filtering/sorting**: precomputed indexes (Maps by pair, priority, decision…) in the store; filter + sort of 10k rows < 30 ms on main thread; if a measurement exceeds 50 ms, move to a Web Worker (`src/features/triage/filter.worker.ts`). Facet counts recomputed lazily when a popover opens.
- **Rendering**: selection store with selector subscriptions; `GroupRow` memoized by `(rowId, isCursor, isChecked, decisionVersion)`. Cursor move re-renders ≤ 3 components.
- **Keyboard repeat**: list cursor updates every keydown; viewer update debounced (120 ms) and camera refit only after 150 ms idle; in-flight viewer work is cancelled (generation counter) when a newer selection arrives.
- **Viewer**: never build overlay meshes for non-selected geometry (native ghosting instead); cap glow overlays at 200 dbIds per side; cache overlay meshes per `(model, dbId)` (LRU 2 000 meshes); dispose on test change. Load models in parallel (max 3 concurrent) rather than the current sequential loop; first-paint the list before models finish.
- **Persistence**: decisions micro-batched (500 ms / 20 items); localStorage mirror for unsaved decisions only.
- **Live updates**: poll `GET /api/triage/:…/changes?since=<cursor>` every 10 s (or SSE if the server offers it) — returns only changed proposal ids; never full reload while the user is reviewing.
- **Budgets**: workspace interactive (list usable) < 2 s after payload arrives; j/k list response < 16 ms; viewer focus after settle < 400 ms (cached) / < 1 s (uncached); bulk accept of 500 < 300 ms UI time.

---

## 10. Open items for other specs
- AI spec: confirm field-level `confidence`, `source`, `rationale` (es), `signals`, `ruleIds`, `spotCheck`, `agentCommand` strings; rule-suggestion flow from `suggestRule`.
- Server spec: endpoints listed as **[contract]**; delta computation across tests; preflight; idempotent apply; issue snapshot capture at apply (server needs a viewer state + image from the client — the client uploads the pinned screenshot when the batch is approved).
- BIM specialist: discipline matrix labels (es/en) and short codes; default tolerances that rationale refers to; validation of reason-code taxonomy R01–R13.
