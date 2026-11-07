# Engine review, November 2026: the deterministic engine and server against the fixture project

Reviewer: BIM coordination specialist, author of `docs/domain/*` and `rules/*.yaml`. Date: 2026-11-06.
Scope: `core/` and `server/` as built, run end to end on the synthetic fixture project (tests v41 → v42, 8 documents, 300/303 clashes), checked against `tests/fixtures/fixture-truth.json`.
Companion document: `docs/domain/proposed-rule-changes.md` holds the exact diffs.

## Verdict

**Not ready for a pilot yet.** The engine could be ready for a *shadow* pilot (read-only, no ACC writes; the coordinator compares the engine's output with their own triage) once the four P0 fixes below land. They are small, and the diffs for three of them are in the companion document.

What works, and works well:
- Duplicates (DUP-001/002), insulation (FP-002), sleeves (FP-010), sprinklers in ceilings (FP-008), embedded conduits (TOL-005) and tolerances (TOL-003) are all classified exactly as the taxonomy intends.
- New, persisting and resolved clashes are diffed correctly, including the 8 clashes that ACC renumbered (matched by pairKey).
- No real clash is auto-closed today. Clash ids stay out of titles, due dates follow the issue guide, and every closure goes through human approval.

P0, needed before any pilot:
1. **TOL-008 reads a missing fire rating as "not fire rated".** It then tolerates pipes through walls whose rating is unknown, and its rationale states as fact something the model does not contain. Fixture truth counts 6 real clashes in v42 (9 in v41) as wrongly tolerated. The policy holds them in review today, but only because 0.70 is below the 0.92 bar, so any loosening of the policy would auto-close them. Fix: diffs R2, R4 and M1.
2. **The review gate does not enforce "structural openings are always reviewed by a human"** (methodology §"always human"). The EST-009 missing-opening groups come out `auto_ok`. FP-010 and TOL-005 stay in review only by accident of the threshold. Fix: diffs R5 and C1.
3. **Reappeared clashes are reported as new**: 13 of 13 in the `server/` classify path. `historyBefore()` reads only cached tests older than the previous one, so v40 is never loaded. As a result, regressions never reach the meeting and the `regresion` tag never fires. (The `evaluate_ruleset` fixtures suite passes the history file explicitly, so its `diffAccuracy = 1` hides this.) Fix: keep a per-model-set clash-id ledger in the store, appended on every ingest, or fetch the clash ids of the previous version's predecessor during ingest. This is a code change; there is no diff for it in the companion document.
4. **Issue drafts can exceed ACC's limits**: 5 of 65 descriptions are over 1,000 characters (the maximum is 1,006), and they use markdown that ACC shows as literal `**`. Fix: the compact template in §5.

P1, for review load and usefulness (needed before a pilot with real coordinators): the threshold calibration and grouping changes (§3, §4); level-name normalization (`Level 1` vs `Nivel 1`); and correlating sleeves with pipes (§1.3).

## 1. Accuracy against the fixture truth

### 1.1 Per pattern (v42, 303 clashes; v41 is the same pattern for pattern)

| Fixture pattern | n | Engine (rule → validity) | Verdict |
|---|---|---|---|
| real_duct_beam | 50 | EST-004 43 · EST-005 7 → real | Correct. Duct size picks critical or high. |
| real_pipe_beam | 38 | EST-002 19 (gravity, critical) · EST-005 12 · EST-006 7 → real | Correct. |
| real_tray_duct | 22 | MM-010 → real | Validity correct. Responsibility is ELE, except equal-width ties, which go to COORD (see resolution 6). |
| real_inc_pipe_duct | 18 | MM-004 8 · MM-010 10 → real | Correct. Fire mains ≥ 65 mm go to MM-004. |
| real_pipe_wall | 21 | MA-006 12 · MA-007 3 → real; **TOL-008 6 → tolerated** | **6 unsafe**: the wall has an empty "Resistencia al fuego" value, so its rating is unknown, yet the engine treats it as unrated. |
| real_pipe_slab_no_sleeve | 12 | EST-009 4 · **EST-002 8 (critical)** → real | Validity correct. Severity and owner are wrong for vertical gravity stacks (§1.2). |
| tolerance_small | 20 | TOL-003 → tolerated | Correct. |
| clearance_soft | 5 | TOL-001 4 → tolerated · TOL-002 1 → real/clearance | Consistent with the 25 mm MEP×structure clearance in the matrix (gaps of 35–45 mm pass; 17 mm fails). The TOL-001 wording "Contacto" is wrong for a 40 mm gap (diff R1). |
| fp_insulation_own_pipe | 22 | FP-002 → false_positive | Correct (FP-001 cannot fire because the fixture insulation has no system name). |
| fp_same_element_dup_viewable | 6 | DUP-002 | Correct. |
| fp_duplicated_linked_model | 32 | DUP-001 | Correct. |
| by_design_sleeve_slab | 20 | FP-010 | Correct. |
| by_design_pipe_slab_sleeve | 14 | **EST-002 → real, critical** | Wrong: noise. The pipe runs inside a modeled sleeve, but the engine judges each clash alone (§1.3). |
| sprinkler_ceiling | 13 | FP-008 | Correct. Stays in review as a life-safety closure, which is right: a head can sit above the ceiling. |
| conduit_in_slab | 10 | TOL-005 | Correct. |

Validity accuracy (excluding the 5 ambiguous `clearance_soft` clashes): **278/298 = 93.3%** today. With the proposed rules it is **284/298 = 95.3%**, and with sleeve correlation it would reach 100%.

`real` precision and recall: **0.917 / 0.963** today; **0.920 / 1.000** with the proposed rules.

### 1.2 Unsafe closures

- Today: **6 (v42) and 9 (v41) real clashes are classified `tolerated`**, all by TOL-008. **None is auto-closed**: confidence 0.70 is below every closure threshold. The defect is in the rule, not the gate, and must be fixed *before* any threshold change. After diffs R2/R4/M1 the count is 0, and the scenario eval shows 0 unsafe closures with the new EV-26 (the current rules fail EV-26 with an unsafe closure).
- EST-002 on vertical gravity stacks through slabs is not unsafe, but it inflates critical: a stack through a slab is a missing opening (EST-009, owner EST, medium), not "a gravity system that cannot work". Diff R3 excludes vertical orientation from EST-002. EV-01 (no orientation) keeps EST-002.

### 1.3 Pipe with sleeve (by design)

Every by-design pipe has a sibling FP-010 clash: its sleeve against the same slab, at the same XY. The engine cannot see this, because each clash is judged alone. Proposal for phase 2 (code, not rules): a clash fact `coveredBySleeve`. It is true when another clash in the same test pairs a sleeve or opening (`isSleeveOrOpening`) with the same host `externalId`, and the sleeve's bbox contains the MEP element's crossing point in plan. A rule FP-016 placed before the EST rules would then close the clash as `false_positive`. It stays in human review through the structural-opening trigger, because the calculista still has to see it on the openings drawing. Expected effect: 14 false `real` clashes in v42 become non-issues.

### 1.4 Diff states (v41 → v42)

| State | Expected | Engine (server path) |
|---|---|---|
| new | 70 | 70 ✔ |
| persisting (including 8 with a new MC id, matched by pairKey) | 220 | 220 ✔ |
| reappeared | 13 | **0: all 13 reported as new** ✘ |
| resolved + element_deleted | 65 + 15 | 80 ✔ (merged; see note) |

Note: `resolvedSincePrevious` merges resolved clashes with clashes whose element was deleted. The issue guide §6 uses different text for "element deleted" ("confirmar que la eliminación es intencional"), so keep them apart in the record.

## 2. Review load: why 51 of 79

The server reports 51/79 groups (64.6%) and 215/303 clashes (71%) as needing review, in both v41 and v42.

| Reason (v42 groups) | Groups | Root cause |
|---|---|---|
| Critical severity | 24 | 9 EST-004 groups plus 15 EST-002 groups. Fragmentation (runs of 2, zones keyed by rule) splits about 12 meeting items into 24 groups. EST-002 also catches vertical stacks through slabs (§1.2). |
| Real confidence < 0.80 | 15 | MM-010 has confidence 0.75 in 12 groups. MM-010's uncertainty is about *who moves*, not validity: an MEP×MEP hard clash 20–100 mm deep is real. Auto-accepting `real` closes nothing; it only queues an issue draft that a human approves. |
| Closure confidence < 0.92 | 11 | The 0.92 threshold sits above **every closure rule except DUP-001/002, FP-001, FP-004 and FP-008**. The result is that every non-issue group goes to review, including deterministic geometry (TOL-003 within the tolerance table, TOL-001 no contact). |
| Closure with seguridad_personas | 2 | Correct and kept: sprinklers in the ceiling, and a cable tray against a sprinkler pipe. |

Other things the fixture itself inflates, so the review rate would be lower on a real project:
- **Structure-heavy mix**: 105 of the 383 pool clashes are ducts or pipes against beams, so 20% of v42 clashes are critical.
- **No shared elements**: each clash creates its own elements, so hub grouping (G4) never fires. A real project's most common pattern, one duct crossing 14 beams, would be 1 group.
- **Random system names**, so independent ducts form spurious runs of 2.
- **The ELE model is in English Revit** (`Level 1`), which splits levels across models.

Rule confidence is not miscalibrated per se: the values are relative priors. The thresholds were set as if closure rules would score above 0.92, and they do not. The fix is to calibrate the thresholds and add the safety triggers that thresholds should never decide (§4), not to inflate rule confidences.

## 3. Group quality

What a coordinator puts on the meeting agenda is one line per *level × responsible discipline × what it crosses*, plus a single line for one system run when a run exists. Against that standard, the current groups have these problems:

- **Too fragmented.** The zone key includes `ruleId`, so EST-004 and EST-005 on the same level split, and runs start at 2 clashes. Level 1 CLI×EST becomes four groups (a zone of 10, runs of 3 and 2, and an EST-005 zone of 2).
- **Keyed on the wrong element.** Runs and zones key on `whoMoves` even when the rule's responsible discipline owns the other side.
  - In MA-006 the wall "moves", so the run key and title read `ALC Muro básico vs tuberías gravitacionales`.
  - In EST-009 (owner EST) the zone title reads `Nivel 1: 2 EST vs EST`.
- **Titles say too little or the wrong thing.** Zone titles (`Nivel -1: 8 CLI vs EST`) do not name what clashes. Raw Revit family names leak into titles (`Cable Tray with Fittings`, `Muro básico`, duct type `Uniones por radio / Te`), as do English levels. The DUP-001 title names the same file twice, when the real finding is "PRJ-EST-MOD-001.rvt is loaded twice in the model set".
- **New rules get English titles.** MA-013 rendered "small MEP through wall with unknown fire rating", because Spanish rule names are hard-coded (resolution 13).
- **Merging is right.** Nothing is wrongly merged. One validity and one owner per group holds, and the non-issue and hygiene batches are good meeting items, for example `22 × Aislación contra su anfitrión (sin sistema) (AP)` and `20 × Pasada o camisa modelada (EST×SAN)`.

Proposed (diff C1): runs and zones key on the responsible side; runs need at least 3 clashes; the zone key is level × owner × crossed discipline and class × severity. When the owner owns the fixed side (EST-009), all crossing disciplines on a level form one "openings drawing" item. Titles become, for example, `Nivel 1: 12 interferencias CLI — ductos vs vigas de EST` and `Nivel 3: 12 interferencias EST — losas vs elementos de ALC/ALL/AP`.

Still to do in code, without a diff yet: normalize levels by elevation or with a project level map; keep a stop-list of generic Revit family names (Muro básico, Suelo, Tubería, Ducto rectangular, Uniones por radio…) and prefer system, then type, then category in titles.

## 4. Proposed review policy and its measured effect

Policy (diff C1 in `core/group/review.ts` and `core/group/index.ts`):
- `autoAccept`: real **0.75** (was 0.80); false_positive **0.88** (was 0.92); duplicate 0.90 (unchanged); tolerance **0.85** (was 0.92).
- `reviewFloor` 0.55, `minClashCount` 150 and `bulkClosureMax` 50 are unchanged.
- Safety triggers that no threshold can bypass:
  - critical severity (unchanged);
  - closure with `seguridad_personas` (unchanged);
  - **new**: structural opening, meaning the tag `pasada_estructural` from ANN-007 combined with either a closure or rootCause `missing_opening`. The trigger is hard-coded, not configurable.

Measured on the fixture by `scripts/review/simulate.ts`, plus a scratch copy of `core/` with diff C1 applied for the grouping rows:

| Configuration | v42 groups needing review | Clashes in review |
|---|---|---|
| Today | **51 / 79 (64.6%)** | 215 / 303 |
| Policy only | 34 / 79 (43%) | 149 |
| Rules only (R1–R5, M1) | 44 / 78 (56%) | 193 |
| Rules + policy | 36 / 78 (46%) | 167 |
| **Rules + policy + grouping (C1)** | **25 / 67 (37%)**; v41: 24 / 68 (35%) | 167 |

Of the remaining 25 groups, 13 are critical (CLI ducts vs beams on 4 levels; ALC/ALL gravity vs beams), 6 are structural openings (4 per-level openings items, FP-010, TOL-005), 2 are life-safety closures, and 4 are low-confidence groups (MA-007 ×2, TOL-002, FP-002). **Non-critical groups needing review: 12/54 (22%).** On a typical project, with hubs, real system runs and a lower critical share, I expect **20–25% of groups** to need review. That is the right range for a pilot. Below about 15% would mean the gate is too permissive for this domain.

Invariants check: no real clash is auto-closed (0 in every configuration); every critical group is reviewed; every closure involving life safety or a structural opening is reviewed. Auto-accepting `real` never writes to ACC by itself: it creates a classification proposal, and the issue draft still needs human approval.

## 5. Issue drafts

Five drafts judged against `issue-writing-guide.md`: ✔ = meets the guide, ~ = partly, ✘ = fails.

| Group | Title | What / where / why | Action | Owner and date | Main defects |
|---|---|---|---|---|---|
| G-3fe6324bf5 (EST-004 zone, 10) | ~ | ~ | ✘ | ✔ | The title claims one duct ("Ducto RET-5 800x400 atraviesa 10 vigas"), but the group holds 10 different ducts. "Ducto Uniones por radio / Te" is meaningless. The action is generic ("Revisar la solución con la especialidad consultada"). 981 characters, at the limit. |
| G-0e2b622c64 (EST-002, 2) | ✔ | ~ | ~ | ✔ | Should not exist: the pipes have modeled sleeves (by design, §1.3). |
| G-6a22069774 (MM-010 run, 6) | ~ | ✘ | ✔ | ✔ | "escalerilla portaconductores — (400 mm)" has an empty system placeholder and starts in lower case. The title uses the English level "Level 1". |
| G-53e2cd039f (EST-009, 2) | ✔ | ✔ | ✔ | ✔ | The best of the five: it follows guide example 4. Minor: "Losa Losa H.A. e=200 200 mm" repeats itself. |
| G-8b62a22548 (MA-007, 2) | ✔ | ✔ | ✘ | ✘ | The owner is AP, yet both the rationale ("ARQ debe incorporarlo") and the action ("modelarla en el elemento atravesado") are tasks for ARQ: one issue, two owners. |

Also seen: G-2ba8d52a07 is assigned to COORD and approved by COORD, and reads "mueve COORD". No skeletons are built for hygiene groups (DUP-001), because `engine.ts` builds drafts only for `real` groups, yet the guide's example 5 is the most useful issue in this test.

**Compact template (plain text; ACC limits: title ≤ 100, description ≤ 1000).** The assignee and due date are ACC fields, so they are not repeated in full.

```
Title (≤100): [P1][CLI×EST] Nivel 1 · 12 ductos CLI atraviesan vigas EST (máx. 274 mm)
              drop order when long: location → system name → "(máx. …)"; never band, pair or count.

PROBLEMA: {N} {qué} de {DISC} ({sistemas; rango de medidas}) {verbo} {qué} de {DISC2}. Penetración máx. {p} mm.   ≤160
UBICACIÓN: {Nivel}{ · eje/recinto}. Peor caso: {elemento A medida} / {elemento B tipo}. Modelos: {A} / {B}.        ≤220
POR QUÉ: {1 frase de consecuencia}.                                                                              ≤160
ACCIÓN ({DISC}):                                                                                                 ≤280
1. {acción específica}  2. {alternativa}  3. {escalamiento}. [Sujeto a aprobación del calculista.]
CONSULTAR: {DISC2 (calculista)}. PLAZO: {dd-mm-aaaa} ({banda} · {n} días hábiles, antes de la reunión del {dd-mm}).  ≤110
REF: {G-id} · {N} interf. · {reglas} · conjunto v{n}                                                             ≤70
```

Worked example for the EST-004 group of Level 1: **883 characters, 153 words; title 72 characters.**

```
PROBLEMA: 12 ductos de CLI (RET, IMP, EXT; 300x250 a 800x400) atraviesan vigas HA de EST. Penetración máx. 274 mm.
UBICACIÓN: Nivel 1. Peor caso: ducto RET-5 800x400 / viga V250x600 (h=600). Modelos: PRJ-CLI-MOD-001.rvt / PRJ-EST-MOD-001.rvt.
POR QUÉ: un ducto de más de h/3 no admite pasada en viga; tal como está modelado bloquea el montaje de clima del nivel.
ACCIÓN (CLI):
1. Verificar cota y offset de los tramos: el patrón sugiere ductos modelados a la altura de las vigas.
2. Bajar los tramos bajo las vigas o cambiar la sección (más baja y ancha) dentro del entretecho.
3. Si no hay altura, llevar a reunión con ARQ (cota de cielo). Toda pasada en viga queda sujeta a aprobación del calculista.
CONSULTAR: EST (calculista); ARQ si cambia el cielo.
PLAZO: 10-11-2026 (P1 · 3 días hábiles, antes de la reunión del 11-11).
REF: G-3fe6324bf5 · 12 interf. · EST-004 · conjunto v42
```

Engine rules for the template:
- Hard cap of 950 characters, leaving a margin for agent edits.
- Trim in this order: "Modelos", then the second element description, then alternative 3. Never trim the action, the owner or the date.
- Use plain text with uppercase labels, no markdown.
- Use one action list per `ruleId` from a Spanish action table, not per `rootCause`.
- For multi-element groups, describe the range ("300x250 a 800x400"), not the worst member as if it were the only one.

## 6. The 15 ambiguity resolutions by coder B

| # | Resolution | Verdict | Fix, when I disagree |
|---|---|---|---|
| 1 | Hygiene skips G1 so it reaches G2 | Agree | – |
| 2 | Responsible discipline added to G1 and hub keys | Agree | Keeps "one owner per group". |
| 3 | Group confidence = minimum over members | Agree | Conservative and correct for closures. If mixed-rule groups appear later, split out low-confidence members instead of reviewing the whole group. |
| 4 | Validity mapping + extra triggers (> 50 closures, seguridad_personas, member disagreement) | Agree | **Add the structural-opening trigger** (diff C1). It must not be configurable. |
| 5 | Two gravity pipes → no mover, COORD responsible | Agree | Matches MM-001 (escalate). |
| 6 | `{mover.discipline}` = COORD when there is no mover | **Disagree on wording** | "mueve COORD" is meaningless in an issue. Render it as "coordinación define quién desvía (sin jerarquía clara)". Also break `whoMoves` ties by cross-section (w×h) and class rank before width: a 300x100 cable tray against a 300x250 duct is not a tie, the tray moves. |
| 7 | Insulation moveRank inherits the host class (40 if unknown) | Agree | – |
| 8 | sizeMm is computed before the flags | Agree | The matrix header said the opposite; diff M1 fixes the comment. |
| 9 | A scoring set override is terminal (non-issues stay 0/NONE even with `regresion`) | Agree | A closed non-issue needs no priority. The reappearance itself must still appear in the diff and report, and today it does not (P0-3). |
| 10 | Hygiene issue drafts use band P3 | Agree | But `engine.ts` builds skeletons only for `real` groups, so hygiene skeletons (DUP-001) are never built. Build them for `strategy = hygiene` too. |
| 11 | Dedupe keeps same-element-both-sides clashes apart, keyed by document pair, and keeps the worst penetration | Agree | – |
| 12 | Rules without a/b bind a = left, so the rationale can reorder | **Partly disagree** | The order then depends on ACC's arbitrary left/right, so members of one group read "CLI/EST" and "EST/CLI". For rules with no a/b matcher, bind a = the mover side, or else the side whose discipline sorts first. Grouping must follow the responsible side, not the binding (diff C1). |
| 13 | Spanish rule names hard-coded in `core/group/labels.ts` | **Disagree** | Proven by MA-013, which rendered in English. Add an optional `nameEs` per rule in the YAML (schema + loader), use labels.ts only as a fallback, and have the loader warn when a rule lacks a Spanish name. Diff C1 adds MA-013 to labels.ts in the meantime. |
| 14 | Orientation from the bbox, MEP runs only, 3× ratio | Agree | Unknown orientation falls back to EST-011 (review), which is safe. Prefer viewer-fragment orientation when available. |
| 15 | Raw model text in titles, wrapped as untrusted | Agree on the wrapping | Do not use generic Revit family names in titles (stop-list, §3). Prefer system, type and Spanish category. |

## 7. Discipline codes (CLIMA/PCI vs CLI/INC)

Confirmed: the **binding codes are `CLI` and `INC`** (`rules/discipline-matrix.yaml`). `clima` and `pci` are only aliases used to recognize file names. `docs/ux/coordinator-ux-spec.md` uses `CLIMA`/`PCI` in its examples and also invents rule ids (`R-EST-CLIMA-004`). Update the spec to `CLI`/`INC` and real rule ids (`EST-004`). The UI must read codes and labels from the matrix (it already says it does).

## 8. Reproduce

```
export COORD_DATA_SOURCE=fixtures COORDINATOR_HOME="$(mktemp -d)"
npx tsx scripts/review/dump.ts out.json                       # groups, clashes, review reasons, issue drafts (v41, v42)
npx tsx scripts/review/simulate.ts <rules-candidate.patch> sim.json   # review load: current vs proposed rules/policy + eval
```

Both scripts are read-only. The rules candidate is applied through `Coordinator.candidateRulesDir()` to a temporary copy, so `rules/` is never touched. The grouping rows in §4 come from a scratch copy of `core/` with diff C1 applied. Once C1 is merged, `simulate.ts` reproduces them directly.
