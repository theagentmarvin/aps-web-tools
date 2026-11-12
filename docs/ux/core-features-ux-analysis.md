# Core features F1–F5: UX analysis (smallest UI on the coordinación workspace)

Status: analysis, 2026-11-09. Input: `docs/PLAN-core-features.md`. Base: the live coordinación workspace
(`/coordinacion/:p/:m`, Grupos | Interferencias tree + detail panel + viewer), checked on Sandbox v11.
UI words: **grupo** = family, **ubicación** = instance (implementation-notes §"Rename and counting").

## 0. Verdict in one paragraph

All five features fit in the **existing workspace** with **zero new pages**. The one structural addition is a
row of three **lenses** (saved filter + sort + which panel section opens first) above the tree. Most of the
plumbing already exists: `delta` filter (nueva/modificada/reaparecida/resuelta), `decision=heredada`,
the "Aceptar heredadas (n)" header button, `issue=existente` filter, the "Resueltas por la prueba" preset,
the "Cambios" and "Historial" detail sections, the violet "Sugerido por el agente" chip, the stale-version
banner and the batch page's status-transition section. The features are mostly **new data in old slots**.

## 1. Smallest UI per feature

The lens row replaces the "Vistas" presets for the cycle (user views stay under ☆ Vistas):

```
[ Qué cambió 34 ]  [ Incidencias 18 ]  [ Reunión 12 ]  [ Todo ]        ← lens = filter+sort, in the URL (?lente=)
```

| Feature | Brief proposes | Smallest UI (recommendation) | New page? |
|---|---|---|---|
| F1 decision memory | "Qué cambió" filter, "heredado de vNN" badge, regression banner | **Lens "Qué cambió"** (default when a previous version exists) = `delta∈{nueva,modificada,reaparecida}` + pending + questions; sort reaparecida → P1 → rest. Inherited items: **no new badge**, reuse the ↺ state icon; tooltip "Heredada de v11 · grupo aprobado por RZ · regla TOL-008". `persisting_changed`: one line at the top of the panel, "Antes (v11): Válida · Crear incidencia. Cambió: penetración 20 → 45 mm" with **[Mantener Enter] [Cambiar E]**. **No regression banner**: reappeared rows sort first and the lens count says "3 reaparecidas". | No |
| F2 verification | "Verificación" view, 4 columns | **Lens "Incidencias"** = grupos with an ACC issue (`issue=existente`) that have a verification result, sorted reabrir → mover → no verificable. The row's single status chip becomes the verdict: `Resuelta 120/120` · `Reabrir` · `No verificable`. "Avance 80/120" is **plain text in the counts**, not a card. Panel section **"Verificación en v12"** at the top of FamilyPanel: existing/resolved counts, the agent's evidence comment (editable), proposed transition "→ En revisión", displacement warning if blocked; **[Aceptar A] [Rechazar X → V01–V05]**. Viewer: existing markers for `existing[]`; displaced new clashes in the same red. Accepted transitions join the **same "Enviar a aprobación" batch**. | No (4 columns cut) |
| F3 families | tree exists | Already built. Only adds: title stop-list and level names (engine). No UI work in the pilot beyond merge/detach later. | No |
| F4 meeting pack | "Preparar reunión" page, notes per family/instance, HTML export | **Lens "Reunión"** = agenda: same tree **grouped by responsible discipline** (new sort "Por responsable") filtered to regresiones, P1, overdue, new grupos, transitions to confirm. **Viewpoint**: a camera button in the viewer toolbar, "Guardar vista para la reunión" (stores camera + PNG on the cursor grupo); a ✓ in the panel shows it exists. **Notes**: a "Nota de reunión" textarea that opens first in the panel in this lens (shortcut N). **Export**: one "Exportar agenda" button (print-styled HTML of the lens + saved PNGs). After the meeting, the panel shows the `/acta` copy-command chip; `/acta` output returns as normal pending proposals with the violet agent chip. | No |
| F5 follow-up | "Seguimiento" page: contradictions, reminder drafts, escalations | Fold into **lens "Incidencias"**. Contradiction = verdict chip `Dice resuelta ✕` (ACC comment says fixed, `existing>0`); it is the same row as "Reabrir"-class items. Reminder draft per discipline = section on the **discipline header node** (NodePanel) in this lens: draft text + [Copiar]. Escalation = "2 ciclos" text on the row and automatic inclusion in the Reunión agenda; no separate proposal UI. | No (page cut) |
| X3 questions | "Preguntas del agente" panel | **Inline**: a `?` icon in the row's state-icon slot (replaces ○), counted in the lens tab, filterable as `decision=pregunta`. In the panel, a callout at the top: question + option buttons. An answer that is a decision is a normal decision (same log, same batch). | No |
| X6 scope change | banner | Keep the **banner** (it is the one item that must interrupt): "v12 quitó STRUCTURAL_VDC.rvt: 412 interferencias fuera de alcance, sin propuestas". Rows hidden by default. | No |
| §9 metrics | metrics module on /reglas + informe | **No new UI in pilot.** Compute in the server, show in `/informe-semanal` and the existing calibration tooltip. | No |

## 2. One cycle on one screen

```
┌ Proyectos / Torre B / Coordinación   Prueba [v12 ▾]  Preparado por el agente · hoy 08:40   [Enviar 23 a aprobación] ┐
│ ⚠ v12 quitó STRUCTURAL_VDC.rvt · 412 interferencias fuera de alcance (sin propuestas)                     [Detalle]   │
│ [Qué cambió 34 · 3 ?] [Incidencias 18] [Reunión 12] [Todo]   Buscar…  +Filtro                  Grupos|Interferencias │
├─ tree (380px) ──────────────────────┬─ viewer ───────────────────────┬─ panel (400px) ──────────────────────────────┤
│ ALC × EST            P1  3 grupos   │                                │ ALC × EST · Tramo embebido en losa · 12 ubic.│
│  ▸ P1 Válida REAPARECIDA  12 ubic ○ │      (markers of cursor grupo) │ ┃ Antes (v11): Válida · Crear incidencia     │
│     Tuberías ALC Ø76 embebidas…     │                                │ ┃ Cambió: 3 ubicaciones nuevas en N4         │
│  ▸ P1 Válida CAMBIÓ        5 ubic ○ │   [Guardar vista reunión]   │ ┃ Sugerido por el agente (violet bar)        │
│  ▸ P2 Válida               8 ubic ↺ │                                │ [Mantener ⏎]  [Cambiar E]  [Rechazar X]       │
│  ▸ P2 Req. info            2 ubic ? │                                │ Ubicaciones (12) ▸   Cambios ▸  Historial ▸  │
└─────────────────────────────────────┴────────────────────────────────┴──────────────────────────────────────────────┘
```

Journey (VS Code steps in brackets; they stay outside the UI by D1):

| Step | Today (in app + outside) | Proposed |
|---|---|---|
| Open new version | Proyectos → proyecto → celda/abrir (2–3) · version select (1) · Analizar (1) · copy command (1) · [run `/coordinar-test`] · reload (1) | Inicio "Continuar ciclo v12" (1) · [run `/preparar-ciclo`, ingest included] · "Actualizar" banner (1) |
| See what changed | ☆ Vistas → "Nuevas" (2) — misses modificada/reaparecida, add delta chip by hand (3–4) | Lens opens by default (0) |
| Review agent prework | per grupo: A + spot-check opens (unchanged); inherited: "Aceptar heredadas" (1) | same keys; persisting_changed = Enter (keep) |
| Verify fixes | ☆ Vistas → "Resueltas por la prueba" (2), clash view, then **ACC by hand**, ~5 clicks per issue | Lens "Incidencias" (1) · A per verdict · goes into the same batch |
| Send + apply | Enviar (2) · go to batch (1) · approve + typed word + dry run + APLICAR (≈5) | unchanged (≈8) — one batch for triage **and** transitions |
| Meeting prep | **outside**: screenshots, slides (≈5 min per grupo) | Lens "Reunión" (1) · "Guardar vista" per P1/regression grupo (1 each) · Exportar (1) |
| Capture outcomes | **outside**: type into ACC after the meeting | N + type during meeting · [run `/acta`] · approve proposals (A each) |
| Follow up | **outside**: ACC filters, email per discipline | Lens "Incidencias" · discipline header → Copiar (1 per discipline) |

Count, excluding per-item decisions: **today ≈ 25 in-app navigation clicks, 4 app screens (Proyectos,
proyecto, workspace, lote) + 3 outside tools (ACC by hand, slides, email)**. **Proposed ≈ 12 clicks, 2
screens (workspace, lote), outside tools reduced to VS Code + sending the copied reminder.**

## 3. Human + agent touchpoints, with minimal chrome

Where the human meets the agent's work (all already-existing surfaces):
1. **Header line** "Preparado por el agente · hoy 08:40 (`/preparar-ciclo`)" — replaces the bare "Agente inactivo" as
   the cycle's timestamp; the nav chip stays for live status. A newer agent run raises the existing "nuevas propuestas · Actualizar" banner (never auto-reorders).
2. **Lens counts** are the agent's delivery report in 3 numbers; the ≤25-line report in VS Code links to `?lente=cambios`.
3. **Panel top block** = the agent's proposal, rationale, evidence comment, question, or reminder draft.
4. **Copy-command chips** where the human hands work back (empty state, after meeting notes → `/acta`).

Provenance, one visual rule each, no new badge family:

| Who | Row (state icon slot) | Panel |
|---|---|---|
| Agent prepared, waiting for you | ○ (or `?` if it asks) | thin **violet** left bar + existing "Sugerido por el agente" chip on the proposal block and on any agent text (titles, comments, reminders) |
| You decided (this version) | ✓ / ✎ / ✕ (existing icons) | green "Decidido por RZ · v12" pill (exists for families) |
| Carried forward from an earlier human decision | ↺ | "Heredada de v11 · RZ" line; Enter keeps it |
| Engine rule (deterministic) | — | existing `Regla R-…` source badge, only in the panel |

Editing agent text removes the violet bar (it becomes yours; R13 diff recorded automatically). Nothing
says "IA" on rows: the list stays a list of work, provenance lives one click away in the panel.

## 4. Cut or defer for the pilot

| Item in the brief | Decision | Reason |
|---|---|---|
| "Verificación" 4-column board | Cut | A lens + one verdict chip gives the same triage; a board duplicates the tree and its keyboard model. |
| "Preparar reunión" page | Cut | The agenda is a sort of the same tree; the viewer is already on screen. |
| "Seguimiento" page | Cut | Contradictions are a verification verdict; reminders fit on the discipline node. |
| "Preguntas del agente" panel | Cut | A `?` row state + panel callout keeps questions next to the evidence. |
| Regression banner (F1) | Cut | Sort order + "3 reaparecidas" in the lens is enough; banners are reserved for scope change and stale version. |
| Showing all 7 F1 states | Cut | Users see 3 words (Nueva, Cambió, Reaparecida); the rest is icon, lens or banner. |
| Progress comments to ACC each version ("quedan 40 de 120") | Defer | ACC write volume and issue noise for little value; show progress locally. |
| `closed` as target status, configurable | Defer | `in_review` only in the pilot (O-2 still open). |
| `escalate` proposal kind (F5) | Defer | "2 ciclos" + automatic agenda entry covers it; escalation happens in the meeting. |
| Reply-class correction UI (fixed/question/dispute) | Defer | Show the agent's class as text; add correction capture once O-3 confirms comments are readable. |
| R07 axis capture (level/system/owner/severity) | Defer | Extra keystroke on a rare action; infer it from the merge/split diff instead. |
| Auto-rendering viewpoints for the whole agenda (isolate, colour by discipline, batch) | Defer | On-demand "Guardar vista" on P1/regressions first; batch rendering after perf is proven. |
| Screenshots to ACC at issue creation | Defer | New write path + 5-image cap; nice-to-have, not the time sink. |
| Designed HTML meeting pack | Defer | Print-styled export of the lens first. |
| Per-feature metrics module UI | Defer | No promotion logic in scope (D2); numbers go to `/informe-semanal`. |
| Grid location ("ejes C–D/4–5") | Defer | Engine spike; UI keeps levels until it succeeds. |
| Family merge / detach UI | Defer | Already second in the brief; the selection bar's Agrupar/Dividir covers rare cases. |

Keep (they are cheap and protect users): V01–V05 on transition rejection (1 key + Enter), X6 banner,
stale-issue preflight refusal, per-item confirmation for critical / `seguridad_personas` / > 50 transitions.

## 5. Top 5 UX risks and how to avoid them

1. **Badge overload on rows.** Today a ubicación row can show up to 9 tokens (P, confidence, pair, count,
   delta, spot-check, flagged, inherited, state); adding verdicts and questions breaks the 380 px list.
   **Rule: per row, at most 3 chips + counts + 1 state icon.** Chips: (1) priority, (2) validity or pair,
   (3) **one** status chip chosen by precedence: Reabrir/Dice resuelta ✕ > Reaparecida > Cambió > Resuelta n/n >
   Nueva > No verificable > Típico/validez mixta. Everything else (confidence dots, spot-check, orientación,
   "Revisión aleatoria", source) moves to the tooltip or panel; spot-check still enforces its guard.
   One right-side icon: ○ ✓ ✎ ✕ ⏸ ↺ ?.
2. **State explosion.** F1 (7) × F2 (4) × decision (6) × family decision × question is unreadable.
   **User vocabulary: 3 "what changed" words + 3 issue verdicts + 7 icons.** Engine states map to them;
   `persisting_unchanged` has no chip; `element_deleted` becomes a question; `out_of_scope` is hidden behind the banner.
3. **Lens = hidden items.** A lens is a filter; people forget it and think work is done.
   Lens tabs always show counts; the active filter chips stay visible; "Todo" is one click; the empty state
   of a lens says "Nada más en Qué cambió · 18 en Incidencias →".
4. **Automation bias on inherited and agent work.** "Aceptar heredadas" and Enter-to-keep make approving
   cheap. Bulk-inherit only `persisting_unchanged`; `persisting_changed`, reappeared, P1 and Reabrir keep the
   dwell guard; reopen/critical transitions are never bulk; spot-check stays; violet marks agent text until edited.
5. **Async hand-off between VS Code and the UI.** The agent and the human edit the same state at
   different times (questions answered after a new ingest, `/acta` run while the UI is open, stale issues
   at apply). Show "Preparado por el agente · hora" and keep the non-reordering "Actualizar" banner; mark
   stale questions "Ya no aplica (v13)" instead of deleting them; translate preflight refusals into one
   Spanish line ("La incidencia cambió en ACC después de la propuesta; vuelve a verificar").

Maximum visible per row: **3 chips + 1 icon** (plus the count text). Maximum lenses: **3 + Todo**.
Maximum banners at once: **2** (scope change, stale version); everything else is a count.
