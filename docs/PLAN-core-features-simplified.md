# Five core features — simplified plan (recommendation)

Owner: orchestrator. Status: **approved by the product owner, 2026-11-09** (decisions in §7).
Refines [`PLAN-core-features.md`](PLAN-core-features.md) (the brief). Where this document is silent, the brief applies.
Sources: [`docs/ux/core-features-ux-analysis.md`](ux/core-features-ux-analysis.md), [`docs/ai/core-features-agent-analysis.md`](ai/core-features-agent-analysis.md), [`docs/domain/core-features-bim-analysis.md`](domain/core-features-bim-analysis.md).

## 1. Principles (all three analyses agree)

1. **One workspace.** Everything happens in the existing coordinación screen (Grupos | Interferencias tree + panel + viewer) plus the existing approval batch page. **No new pages.**
2. **Rules before LLM.** If a step can be written as a rule, the engine/server does it. The agent is used only for judgment on `humanReview` items, for reading human-written text (meeting notes, later ACC comments) and for issue wording.
3. **Agent prepares, human decides.** The agent runs in VS Code (`/preparar-ciclo`), the UI shows its work, the human approves in one batch. Autonomy stays L1.
4. **Few visible concepts.** Per row: max 3 chips + 1 state icon. Max 2 banners. Users see 3 change words, not 7 states.

## 2. What the coordinator sees: three lenses on the same tree

A row of **lenses** above the tree. A lens = saved filter + sort + which panel section opens first. Nothing else changes.

```
[ Qué cambió ]  [ Incidencias ]  [ Reunión ]  [ Todo ]          31 grupos · 245 ubicaciones · 5.549 interf.
```

| Lens | Feature | Shows | Row additions |
|---|---|---|---|
| **Qué cambió** (default from cycle 2) | F1 | New, changed and reappeared items vs the **last version the coordinator reviewed**; inherited items collapsed | One change word: *Nuevo · Cambió · Reapareció*; ↺ icon = inherited (no change) |
| **Incidencias** | F2 + F5 | Grupos that have an ACC issue, with the verdict for this run | One verdict chip: *Resuelta n/n · Avance n/m · Sigue abierta · Dice resuelta ✕ · No verificable*; reminder "Copiar" per discipline |
| **Reunión** | F4 | Agenda for D-1: regressions → P1 → overdue/contradicted issues → new grupos, by responsible discipline | Panel opens on "Nota de reunión" (key N); print view of the lens for distribution |

Who-did-what with minimal chrome: a thin violet bar on agent-prepared content in the panel (disappears when the human edits), row icons ○ pending · ✓/✎/✕ you decided · ↺ inherited · ? agent question, and one header line "Preparado por el agente · 08:12".

**Cut from the brief's UI:** the "Verificación" 4-column page, "Preparar reunión", "Seguimiento" and "Preguntas del agente" pages (all become lenses or panel sections), the regression banner (reappeared items sort first instead), showing the 7 F1 states.

## 3. Feature by feature — minimum version for the pilot

| | Deterministic (engine/server) | Agent (LLM) | Human (UI) |
|---|---|---|---|
| **X1 ACC sync** | Read assigned/closed groups (`existing[]`, `resolved[]`, `issueId`) on every ingest; ACC wins (D8) | — | — |
| **X6 Scope guard** | Document added/removed/replaced, test config changed, or > 30% of one document's clashes resolve at once → freeze `resolved` for that document | — | One banner per document |
| **F1 Decision memory** | Ledger stores *human, family and ACC* decisions only; rule verdicts are simply recomputed each run (no ruleset-version tracking). Inherit when the clash is unchanged (Δpenetration ≤ 10 mm, same element types); never inherit a closure for a `real` clash | Re-reviews *Cambió / Reapareció* items that still need judgment (`clash-triager`) | Lens "Qué cambió"; Enter keeps the previous decision |
| **F2 Verification** | Verdict per issue from `existing/resolved`; **displacement check v1** = an element of the resolved set clashes again in this run; model-age check (the responsible model must have a new version); evidence text from a template | Only explains regressions in Spanish when asked | Lens "Incidencias"; accept/reject with V01–V05 |
| **F4 Meeting** | Agenda = a server table (no agent); "Guardar vista" stores the viewer camera locally | `/acta`: meeting notes → family-decision drafts; never a closure of `real`, never invented dates, ambiguous → question | Decides **during** the meeting in the existing "Aprobar grupo" modal; notes field per grupo |
| **F5 Follow-up** | "Dice resuelta ✕" = issue closed/in review while `existing ≠ ∅` (a rule); reminder per discipline from a template (counts + ids, no names); "P1 stuck 2 cycles" = a flag that puts the item on the meeting agenda | — (comment classification deferred, §5) | "Copiar recordatorio" per discipline |
| **X3 Questions** | Stored with the version; marked stale when their clashes change | Asks when it can't decide (`ask_coordinator`) | `?` icon on the row + callout in the panel; a validity/action answer becomes a proposal at once |

## 4. Agent side — minimal additions

- **Skills:** `/preparar-ciclo` replaces `/coordinar-test` (automatic first-cycle mode; the old command stays as a pointer for one release). `/acta` is a separate ~15-line skill (different day, different untrusted input).
- **MCP tools:** 32 → 34: `list_issue_checks` (read; F2/F5) and `ask_coordinator` (X3). Extend existing tools for delta filters, `previousDecision`, meeting notes and agenda/reminder report kinds.
- **Proposal kinds:** `issue_update` is created **only by the engine** (no agent tool can propose an ACC issue write).
- **Weekly loop:** D-1 `/preparar-ciclo` → review in the UI (lens by lens) → approve one batch → "aplica el lote" (dry run, then confirm). D+1 `/acta` → approve. Two commands per cycle.

## 5. Deferred (not in the pilot)

| Item | Why |
|---|---|
| **ACC status write (`issue.update`, X2)** | Changing statuses by hand costs ~20 min/week. Build it after **2 cycles with ≥ 90 % of "Resuelta" verdicts accepted unchanged**. Until then F2 is read-only and the coordinator moves the issue in ACC. *(Needs the owner's decision: the brief's D3 approved it now.)* |
| Reading/classifying ACC comments (`classify_issue_replies`, `issue-reader`) | Waits for O-3 (can the API read comments?) and O-7 (governance for sending comment text to Claude) |
| Reopening issues automatically | Never automatic; a closed issue that still clashes goes to the meeting agenda |
| PNG/HTML meeting pack, screenshots to ACC | ACC already holds viewpoints once an issue exists; browser print of the Reunión lens is enough |
| Metrics module, promotion gates, L2 policies | Need ≥ 3 real cycles of decisions; computable later from the decision log |
| Grid location spike, drag merge/detach, R07 axis, reply-class corrections, progress comments in ACC | Low value for the pilot |

**Captured now at ~zero cost:** reason codes V01–V05, the ledger decision reference, and an engine/agent tag on every proposal. These feed the later autonomy work without extra UI.

## 6. Sequencing

```
M0  Verify: D5 clash-id stability on real v10→v11 · ledger reappeared test · TOL-008 · 1000-char issue limit
    · humanReview flag (payload shows 0 on 140 needs_review groups — check) · O-7 governance confirmation
M1  X1 ACC sync · X6 scope guard · lenses UI shell (Todo + Qué cambió)                  — read-only
M2  F1 decision memory · X3 questions · /preparar-ciclo                                  — read-only
M3  F2 verification (Incidencias lens, read-only) · F5 contradiction chip + reminders
M4  F4 Reunión lens + notes + /acta
M5  (after 2 cycles of evidence) X2 issue.update write
```
Each milestone: typecheck, tests, eval (0 unsafe closures), MCP smoke, a BIM review on fixtures + real data, and a live check in the browser before handing over.

**Expected value** (BIM estimate, typical SalfaCorp building, not measured): F1 3–4 h + F2 2.5–3.5 h + F4 2–3 h + F5 0.5–1 h per weekly cycle; F1 + F2 ≈ 70 % of it. Clicks per cycle ≈ 25 → 12; screens 4 (+3 outside tools) → 2.

## 7. Owner decisions (2026-11-09)

1. **Approved:** three lenses on the existing coordinación workspace, no new pages.
2. **Approved:** F2 read-only first; the X2 ACC status write is built in M5 after 2 real cycles with ≥ 90 % of "Resuelta" verdicts accepted unchanged. This supersedes the brief's D3 timing.
3. **Approved:** all pilot scope cuts in §5.
4. **Open:** O-7 governance confirmation with the BIM lead (*Procedimiento Acceso Herramientas IA*).
