# Core features: BIM coordinator analysis

Owner: BIM coordination specialist. Status: **analysis, 2026-11-09.** Reviews [`docs/PLAN-core-features.md`](../PLAN-core-features.md) as the coordinator who runs the weekly cycle. No code changed.
Reference project: a typical SalfaCorp building (10–20 floors, 8–10 disciplines, 3–8k raw clashes per run, 20–40 real families, 40–80 open clash issues). Real data checked read-only: test `T-3bde5861` (v11).

---

## 0. Bottom line

- **Pilot = F1 (decision memory) + F2 (verification, read-first).** With F3 already built, these two remove the two biggest weekly time sinks: re-triaging what was already decided and checking fixes by hand. Together they save **≈ 6–7 h of the ≈ 9–10 h** the five features can save per cycle; the "Reunión" agenda filter that falls out of them for free brings it to **≈ 80%**.
- Everything stays inside the existing **Familias | Grupos | Interferencias** tree: F1 is a filter and a badge, F2 is one more view of the same rows, F4 is a sort order plus a note field. No new pages are needed for the pilot except "Verificación".
- Simplify three things in the brief: **4 visible F1 states, not 7**; **F2 displacement check by shared element only**; **no PNG/HTML meeting pack** (ACC already holds the viewpoint once the issue exists).
- Real-data caveat: v11 has **0 ACC assigned or closed groups** (all 245 groups `active`), **0 family decisions**, and every group is `new`. F1/F2 can't be proven on v11 alone. The pilot's first cycle creates the baseline; validate clash identity (D5) on the existing **v10 → v11** pair before that.

## 1. Ranking: hours saved per weekly cycle, and risk

Baseline effort today for the clash part of the cycle on the reference project: ≈ 16–20 h per week for one coordinator.

| Rank | Item | What it removes | Saved / cycle | Risk | Why that risk |
|---|---|---|---|---|---|
| 1 | **F1** Decision memory | Re-reviewing persisting families and groups every week | **3–4 h** | Medium | Wrong inheritance after a model change hides a real problem. |
| 2 | **F2** Verification | Opening each open issue in the viewer to see if it's fixed (≈ 5 min × 40–60) | **2.5–3.5 h** | **High** | A false "resuelto" is the error that kills trust; any ACC write raises stakes. |
| 3 | F3 Families (built) | Regrouping for the meeting | (3–4 h, already banked) | Medium | Over-merge (see families §6). Remaining items are polish. |
| 4 | **F4** Meeting pack + capture | Building the agenda (1.5–2 h) and typing outcomes into ACC (1–1.5 h) | **2–3 h** | Medium | `/acta` misreads a note; mitigated by proposals only. |
| 5 | F5 Follow-up | Chasing replies, writing reminders | **0.5–1 h** | Medium | Comment reading not confirmed (O-3); injection; a nagging tone annoys disciplines. |
| — | X1 ACC sync | Duplicate issues; manual cross-check with ACC | 0.5 h + enables F1/F2 | Low | Read only. **Must have.** |
| — | X6 Scope-change guard | Mass false "resuelto" when a file leaves the set | 0 h, prevents disasters | Low | Read only. **Must have before F2.** |
| — | X5 `/preparar-ciclo` | Running 5 commands by hand | 0.5 h | Low | Chaining only. |
| — | X2 `issue.update` write | Clicking status changes in ACC (≈ 1 min × 10–20) | 0.3 h | **High** | First write to issues; stale-issue and permission edge cases. |
| — | X3 Question store | Re-asking the same doubt each cycle | 0.2 h | Low | Mostly UI work. |
| — | X4 Capture codes | Nothing this week; feeds learning | 0 h | Low | Cost is UI keystrokes. |

**Top 2 for the pilot: F1 + F2 (read-first), on top of X1 + X6.**
The point of X2 is low: once the coordinator has a trusted Verificación list, changing 10–20 statuses in ACC by hand costs ≈ 20 minutes. The trust is the value, not the click.

## 2. Minimum trusted version of each feature

### F1. Decision memory: "Qué cambió"
What I need to see, in my words:

| Visible label (ES) | Brief states it covers | What I do |
|---|---|---|
| **Nuevo** | `new` | Normal triage. |
| **Cambió** | `persisting_changed` | Look again; previous decision shown beside it. One key: keep / change. |
| **Reapareció** | `reappeared` | Top of the list, red badge, priority +1. |
| **Sin cambio** (hidden by default) | `persisting_unchanged` | Nothing. Badge "heredado de vNN · familia / coordinador / ACC". |

The other three are not per-clash labels for me:
- `resolved` and `element_deleted` belong in **F2 Verificación** ("resuelto" vs "elemento eliminado, confirmar"), not in triage.
- `out_of_scope` is a **banner per document** ("Sitio Vol.rvt salió del conjunto: 853 interferencias no se evalúan"), not a state on 853 rows.

Simplifications to the inheritance rules:
- **Rule decisions don't need inheritance at all.** The engine re-runs the rules every cycle and is deterministic, so a rule verdict is simply recomputed. Only **human, family and ACC decisions** inherit. This removes `rulesetVersion` tracking from the ledger (rule 3 becomes automatic).
- Keep rules 1, 2, 4 and 5 as written. They are exactly what a careful coordinator does.
- **Compare against the last triaged version, not the previous version.** ACC creates a model-set version on every publish (v11 has 11 versions); a coordinator skips some of them. The diff baseline is "the version I last reviewed".
- "Same element types" check: a type rename alone ≠ change if the pair key is the same and Δpenetration ≤ 10 mm. Flag only a **category or system class** change.

### F2. Verification: "Verificación"
Minimum version I'd trust in the pilot: a **read-only list per open issue**, three columns, Spanish evidence text with a copy button and an "Abrir en ACC" link.

| Column | Condition | What the card says |
|---|---|---|
| **Listo para revisar** | `existing` empty, responsible model republished since the issue, no shared-element clash | "v43: 0 de 120 interferencias. Modelo CLI publicado el 12-11. Proponer *En revisión*." |
| **Avance** | some resolved | "v43: quedan 40 de 120 (P2 entretecho: 3 vigas)." |
| **Revisar en reunión** | closed in ACC but `existing` not empty; or deletion; or model not republished | Reason in one line. **No automatic reopen.** |

- **Displacement check, start simple:** block "Listo" if any element (`externalId`) of the resolved set clashes with anything in this run. That catches the duct that left V-12 and now hits V-13 (same duct). Drop the "same family on the same host" variant until clash points exist; it needs geometry the payload doesn't have.
- **Model-age check, keep:** if the responsible document has no new version since the issue was created, nothing counts as resolved. Simple and very convincing to disciplines.
- **Counts must be unique conflicts, not raw clashes** (v11 inflates ×2–3 because MECHANICAL.rvt is loaded twice). "Quedan 40 de 120" with raw ids that don't match what the modeler sees in ACC destroys credibility.
- Target status: propose **`in_review` only**. Closing stays a human act in the meeting.
- X2 write (status + comment) is phase 2, after two cycles with ≥ 90% of "Listo" cards accepted unchanged.

### F3. Families (built)
Pilot needs only: Spanish level names (`entretecho P1 (viga nivel 201)`), the generic-family stop-list in titles, and **unique counts everywhere**. Grid location, merge/detach UI and the solution catalogue can wait. Real v11: 31 families (22 pair, 6 model set, 3 non-issue), 26 with real members, 0 decided.

### F4. Meeting: "Reunión"
- **Agenda = a saved sort/filter of the tree**, per responsible discipline: Reapareció → P1 → cerrada-pero-persiste → nuevas familias → listas para revisar. Plus one printable view (browser print). That's the D-1 deliverable.
- **Viewpoints:** cut the PNG/HTML pack. Once an issue exists, ACC already stores the pushpin and the clash group view; in the meeting we open ACC or our own viewer live on the shared screen. For new families not yet issued, the app viewer's "focus worst instance" is enough.
- **Capture live, not D+1.** The coordinator is already driving the screen in the meeting. Deciding in the "Aprobar familia" modal during the meeting creates the proposal immediately. Keep **one free-text note per family** for what can't be decided live; `/acta` only turns those leftover notes into drafts (and asks if ambiguous). Guards stay: no closures of `real`, no invented dates, discipline code only.

### F5. Follow-up
Over ACC's own filters (overdue, assigned to, status), F5 adds only two things: the **"dice resuelto pero el modelo no"** contradiction, and **one reminder text per discipline**. The first needs comment reading (O-3 unverified); the second is a 20-line template. Pilot version: a "Copiar recordatorio" button per discipline on the Verificación view, listing that discipline's overdue issues and its "Revisar en reunión" cards. No comment classification, no escalation proposals yet.

## 3. The real weekly cycle and where each feature plugs in

| Day | Step | Who | Feature |
|---|---|---|---|
| Mon (D-2) | Disciplines publish to ACC by the BEP cut-off; ACC builds the model-set version and runs MC | Modelers / ACC | X6 detects files added, removed, replaced; banner |
| Mon night–Tue AM (D-1) | `/preparar-ciclo`: ingest, ACC sync, classify, families, "Qué cambió", verification | Agent | X1, F1, F2, F3, X5 |
| Tue (D-1), 2–3 h | Coordinator reviews only **Nuevo / Cambió / Reapareció**, decides families, spot-checks, checks Verificación; approves issue batch for new real families | Coordinator | F1, F3, F2 |
| Tue PM (D-1) | Agenda sent (print or link); new issues published so disciplines see them before the meeting | Coordinator | F4 agenda, `clashes:assign` |
| Wed (D) | Meeting by discipline: regressions, P1, contested closures, typical details needing calculista | Everyone | F4 live capture |
| Thu (D+1) | Approve meeting proposals; set statuses in ACC (by hand in pilot) | Coordinator | F4 `/acta` leftovers, F2 |
| Fri (D+2) | Reminders per discipline (copy-paste to mail/WhatsApp group) | Coordinator | F5 template |
| Next Mon | New publish; loop | — | — |

- **Before the meeting:** everything automatic (sync, diff, verification) and every decision the coordinator can make alone (non-issues, hygiene, inherited confirmations, new issues). Rule: **never discuss in the meeting what the coordinator can close alone.**
- **During:** only what needs another party: structural openings (calculista), ceiling heights (ARQ), gravity vs gravity, contested "resuelto", reopen decisions.
- **After:** status changes, leftover notes to proposals, reminders.

## 4. Domain risks that break trust, and the simplest guard

| # | Risk | How it happens on site | Simplest guard |
|---|---|---|---|
| 1 | **False "resuelto"** | Element deleted, workset/view not exported, file left the set, model not republished, link unloaded | "Listo" only if both elements still exist in the index, the responsible doc has a new version, and the doc set is unchanged (X6). Propose `in_review`, never `closed`. |
| 2 | **Mass false "resuelto" from a replaced model** | Discipline re-creates the file or copy-pastes elements: all UniqueIds change, so every old clash looks resolved and every new one looks new | If > 30% of a document's clashes resolve in one cycle, or the doc lineage changed, **freeze F2 for that doc** with a banner. |
| 3 | **Wrong inheritance** | FP "conectada a su artefacto" inherited after the fixture moved; decision inherited on a renamed type | Inherit only human/family/ACC decisions, only while Δpenetration ≤ 10 mm and category/system class unchanged; new instances inherit as `pendiente de confirmación`. Never inherit to a closure of `real`. |
| 4 | **Reopened issue annoys a discipline** | Agent flags an issue closed by the modeler as still clashing, often because their fix isn't published yet | No automatic reopen. Card goes to "Revisar en reunión" only if the clash persists **in a version published after the closure**. The coordinator reopens, with the evidence, in the meeting. |
| 5 | **Counts nobody recognises** | Raw clash ids duplicated by a model loaded twice | Unique conflict counts in every card, comment and agenda line. |
| 6 | **Wrong floor on site** | Beam level "201" vs work in ceiling void P1 | `hostLevelLabel` everywhere ("entretecho P1 (viga nivel 201)"). |
| 7 | **Duplicate issues** | Someone else created the issue in the ACC UI | X1 sync before any `clashes:assign` proposal. |
| 8 | **Noise drowns the signal** | v11: ≈ 66% of unique conflicts are non-real or model superposition | Hygiene families (PT12/PT13) first on the agenda; ask to clean the model set before judging F1/F2 metrics. |

## 5. Cut or defer for the pilot

| Item | Decision | Reason |
|---|---|---|
| F1 states `element_deleted`, `out_of_scope` as per-clash UI states | Fold into F2 / banner | The coordinator acts on them per issue or per document, not per clash. |
| `rulesetVersion` inheritance tracking | Cut | Rules are deterministic and re-run every cycle; only human decisions need memory. |
| F2 displacement by family + host | Defer | Needs clash points; shared-element check covers the common case. |
| F2 automatic reopen proposal | Cut | Reopening is a conversation with the discipline, not a batch. |
| X2 `issue.update` write | Defer to phase 2 | ~20 min/week by hand; build after 2 cycles of accepted cards. |
| F4 viewpoint PNG rendering and HTML pack | Cut | ACC already holds the viewpoint; the meeting runs on a live screen. |
| F4 `/acta` as main capture path | Reduce | Capture live in the modal; `/acta` only for leftover notes. |
| F5 comment classification (fixed/question/dispute) | Defer | O-3 unverified; F2 already finds "says fixed but isn't" from model data. |
| F5 escalation proposals | Defer | The coordinator sees the P1 stuck two cycles on the agenda; no extra machinery. |
| X3 "Preguntas del agente" panel | Defer | Use `needs_info` proposals and the family note field for now. |
| X4 R07 split axis, reply-class codes | Defer | Keep only V01–V05 on F2 rejections (1 key). |
| X6 test tolerance/config change detection | Defer | Rare mid-project; document add/remove/replace is what matters. |
| F3 grid spike, merge/detach, solution catalogue | Defer | Level grouping works; merge only needed for #8/#14-type splits. |
| §9 metrics module on `/reglas` | Defer | Count accepted/rejected F2 cards and F1 "Cambió" overrides in the weekly report instead. |

## 6. Pilot acceptance in coordinator terms

1. Second cycle opens on "Qué cambió" and I review **≤ 30% of families** (the rest are Sin cambio).
2. Zero "Listo para revisar" cards that a discipline proves wrong in the meeting over 2 cycles.
3. Agenda ready by Tuesday 14:00 without manual regrouping.
4. Every count in a card matches what the modeler sees in ACC.

Before data use on a real project, confirm O-7: model data sent to Claude from VS Code must be covered by SalfaCorp's *Procedimiento Acceso Herramientas IA*.
