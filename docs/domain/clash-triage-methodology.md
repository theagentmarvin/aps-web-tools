# Clash triage methodology

How a senior BIM coordinator at SalfaCorp gets through clash review, and how the agent replicates it. Read this with `clash-taxonomy.md` (vocabulary), `grouping-strategies.md` (algorithms) and `issue-writing-guide.md` (output).

The workflow in one line:

> **Clean the models → test the right pairs → filter by tolerance → kill false positives in bulk → group → classify and assign → write few, good issues → re-test → measure.**

A coordinator who reviews clash by clash, top to bottom, in Navisworks or ACC, is doing it wrong. Thousands of clashes usually collapse to **20–80 real decisions per cycle**. The job is finding those decisions fast.

---

## Step 0. Inputs and roles

| Input | Source |
|---|---|
| Model set, coordination views, clash tests, clash resources (pairs, `dist`, status) | ACC Model Coordination API (see `docs/legacy/model-coordination.ts`) |
| Element properties (category, family, type, level, system, size, material, workset, phase, UniqueId) | Model Properties (Index) API |
| Object tree (nesting) and geometry-derived orientation and clash point | Model Derivative or the viewer (optional; see "Gaps") |
| Previous triage decisions | `.coordinator/` store, keyed by element pair (see Step 8) |
| Project config: zones, critical levels, meeting day, holidays, tolerance overrides | `.coordinator/project.yaml` |

People involved:
- **Coordinator** (SalfaCorp BIM): owns the process and decides.
- **Discipline modelers and designers** (ARQ, EST, MEP specialists): fix their models.
- **Calculista**: approves every penetration in structure.
- **Project manager / site manager**: consumes priorities against the schedule.

## Step 1. Model hygiene pre-check (before any clash is looked at)

A dirty model produces garbage clashes. Check each document in the model set, every cycle. The engine automates the checks marked ⚙.

| # | Check | Why | Auto |
|---|---|---|---|
| H1 | Every document resolves to a discipline (file-name pattern, ISO 19650 role, or system refinement). The share of `UNK` elements is below 2%. | Without a discipline there is no responsibility. | ⚙ |
| H2 | One 3D viewable per file in the coordination view. | Two viewables mean every element clashes with itself (DUP-002). | ⚙ |
| H3 | No file appears twice and no copied model is in the set (same UniqueIds across files). | DUP-001. | ⚙ |
| H4 | Model age: each file published within the agreed cycle (default ≤ 21 days). | Stale models create clashes that are already solved. | ⚙ (annotation) |
| H5 | Generic Models below about 5% of a discipline's elements. | Generic models can't be classified (NI-001). | ⚙ |
| H6 | No foreign copies (structural columns in ARQ, the ARQ slab duplicating EST). | DUP-004/005/006 hide real problems. | ⚙ |
| H7 | Levels named consistently across disciplines ("Piso 3" ≠ "N+3" ≠ "Nivel 03"). | Grouping by level breaks otherwise. | ⚙ (level-name map proposal) |
| H8 | Shared coordinates and origin match (survey point, project base point). | A displaced model produces thousands of fake clashes. **Detect by symptom:** > 30% of one pair's clashes have penetration > 300 mm, or one file clashes with everything. | ⚙ (symptom) |
| H9 | MEP systems assigned (`systemName` populated) on pipes, ducts and trays. | Same-system false positives and run grouping need it. | ⚙ |
| H10 | Rooms, spaces, masses, analytical models and rebar excluded from coordination viewables. | Noise. | ⚙ |

If H3, H8 or H2 fail, **stop**. Report hygiene issues and do not triage that pair: every result would be noise. The agent must say so explicitly rather than classify 10,000 garbage clashes.

## Step 2. Test matrix

ACC MC clashes everything in a coordination view against everything. Control which pairs you look at through **views and post-filtering by discipline pair**. Recommended matrix (✓ = review every cycle, ○ = review at milestones, — = don't review):

|        | EST | ARQ | CLI | ALC/ALL | AP | INC | ELE | CORR | GAS |
|--------|-----|-----|-----|---------|----|-----|-----|------|-----|
| **EST**  | — (self) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **ARQ**  |  | — (self) | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | ✓ |
| **CLI**  |  |  | ○ (self, plant rooms) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **ALC/ALL** |  |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **AP**   |  |  |  |  | ○ | ✓ | ✓ | ○ | ✓ |
| **INC**  |  |  |  |  |  | ○ | ✓ | ✓ | ✓ |
| **ELE**  |  |  |  |  |  |  | ○ | ○ | ✓ |
| **CORR** |  |  |  |  |  |  |  | — | ✓ |

Notes:
- Do not review self-clash of ARQ or EST. They are joins (FP-006/007).
- Review MEP self-clash only where several systems are modeled in one file (a SAN file with AP+ALC+ALL, a CLI file with ducts and hydronics).
- Recommended **coordination views** in ACC: (1) EST + ARQ, (2) EST + all MEP, (3) ARQ + all MEP, (4) all MEP. Fewer, smaller views make faster tests and easier reading.
- By project stage: in schematic or early design development, run only EST×ARQ and EST×(ALC, CLI large ducts). Full matrix from construction documents (*proyecto de ejecución*) onward.

## Step 3. Tolerance strategy

MC reports every touch. Tolerance is applied after ingest (`tolerances` in `discipline-matrix.yaml`, first match wins):

| Pair | Hard tolerance | Rationale |
|---|---|---|
| GAS × ELE/CORR | 0 mm | Regulatory separation; never tolerated. |
| Gravity × structure, MEP × column | 3 mm | No real tolerance. |
| MEP × structure | 5 mm | Absorbs modeling noise only. |
| Sprinkler × anything | 5 mm | Spray pattern. |
| Gravity × MEP | 5 mm | Slope. |
| Conduit × anything | 15 mm | Field-routed. |
| Flex × anything | 50 mm | Field-routed. |
| MEP × ceiling | 20 mm | Ceiling build-up and hangers. |
| ARQ fixed elements × structure | 20 mm | Partitions modeled to the beam soffit. |
| MEP × MEP | 10 mm (clearance 25) | Insulation and supports not modeled. |
| ARQ × MEP | 15 mm | — |

Philosophy: tolerance removes **noise**, not problems. If a tolerance is hiding real issues, lower it. Never widen tolerances to "get the count down". Get the count down with false-positive rules and grouping.

## Step 4. Review order

Review in the order of **who can't move**. Decisions upstream make downstream clashes disappear:

1. **Hygiene and duplicates** (DUP/HYG). Bulk close and raise model issues.
2. **Bulk false positives and tolerated** (FP/TOL). One decision per rule group, with spot checks (see Step 6).
3. **Structure × everything** (EST-*, AE-*), starting with columns, then beams, RC walls, post-tensioned slabs, foundations. Each structural opening needs a calculista decision, which is the longest lead time.
4. **Life safety:** elevator shaft, stairs, sprinklers, fire mains, rated walls, gas.
5. **Gravity networks** (ALC/ALL) against everything else.
6. **Large ducts, then trays, then pressurized pipe, then conduit.**
7. **Ceilings and architecture fit** (MEP below the ceiling, beam below the ceiling).

Inside each step go **bottom-up by level** (foundations and basements first: densest MEP, earliest to build), or follow the construction sequence if a schedule exists.

## Step 5. Grouping

See `grouping-strategies.md`. Summary: dedupe → batch non-issues by rule → hygiene by file → hub elements (one duct crossing 12 beams = 1 group) → runs (same system, level and counterpart) → zones (level and grid bay) → singletons. **An issue is written per group, not per clash.**

## Step 6. Classify, verify, assign

For each group:
1. Apply the rules (deterministic, first match wins). Read the rationale.
2. **Spot-check the bulk groups.** For a false-positive or tolerated group, open 3 random members in the viewer (5 if the group has more than 100 members). If one is wrong, the rule is wrong: fix the rule and re-run. Don't hand-patch.
3. Look at every `critical` and every `humanReview` group in the viewer. No exceptions.
4. Confirm the responsible discipline and the mover. Apply who-moves, and override with project knowledge (e.g. "this duct route is fixed by the façade louvre").
5. Decide the action: close or review (non-issues), request info, create an issue, or escalate to the meeting.

## Step 7. Issues

See `issue-writing-guide.md`. Few, specific, actionable, in Spanish, with a viewpoint, one responsible party, a due date and the clash IDs.

## Step 8. Re-test cycle

Weekly cadence (typical in Chile; adjust in `project.yaml`):

| Day | Activity |
|---|---|
| D-2 | Disciplines publish models to ACC (cut-off time agreed in the BIM execution plan). |
| D-1 | MC re-runs. The agent ingests, diffs against the last cycle, classifies, groups and drafts proposals. The coordinator reviews and approves. |
| D | Coordination meeting (*reunión de coordinación*): go through P1/P2 groups and escalations, agree on owners and dates. |
| D+1 | Approved issues published to ACC and assigned. |

Clash memory (critical for not re-reviewing):
- **Identity key (corrected 2026-11-09, M0/D5):** the MC clash `id` first, then `sortedPair(externalIdL, externalIdR)` as the fallback for clashes whose id did not match (for example a document replaced in the model set, which gives a new lineage and new clash ids). Without a UniqueId the side token is `<lineageUrn>:<objectId>` (`loid`/`roid`, stable per seed-file lineage), never the viewer `dbId`, which changes between seed versions.
  - The earlier text said MC clash ids are not stable and must never be used as identity. That was wrong. `docs/research/aps-model-coordination-api.md` §3.2 is right: the API documents `id` as stable across successive model set versions.
  - Measured on the real model set (v10 → v11): all 5,215 v10 ids reappear in v11 with the same element pair. 0 ids were reused for a different pair. 0 clashes matched by element pair but not by id. This held even though MC renumbered every `documentId` between versions; the lineages did not change.
  - The element pair is not unique within a version. The same model loaded twice, or a linked copy, gives several MC clashes per pair: 5,549 clashes but only 2,619 pairs in v11. So the pair cannot be the primary key of an MC clash. It identifies the physical conflict, which is what counts and families use.
- **New** = key not seen before.
- **Persisting** = key seen. Inherit the previous decision if:
  - the previous decision was non-issue or tolerated; and
  - |Δpenetration| ≤ 10 mm; and
  - the rule version is unchanged.
- **Resolved** = key absent now while both elements still exist. Propose closing the linked issue. The coordinator confirms.
- **Element gone** = an element was deleted. Mark it resolved-by-deletion and flag it for review: deleting things is a classic way to "solve" clashes.
- **Regression** = a key that was resolved before and is active again. Bump priority one band and tag it `regresion`.

## Step 9. KPIs (per cycle, per discipline and per level)

| KPI | Definition | Healthy signal |
|---|---|---|
| Real open clashes (by group and by clash) | validity = real, not resolved | Monotonic decrease after construction documents start. |
| New vs resolved | Per cycle | Resolved > new from mid-design onward. |
| False-positive rate | (FP + tolerated) / total | Falls cycle over cycle as tests are tuned. Above 60% means fix the tests. |
| Hygiene issues open | By file | 0 before the construction-documents freeze. |
| Issue on-time closure | Closed by due date / due | ≥ 80%. |
| Median issue age, P1/P2 | Days | P1 ≤ 5, P2 ≤ 10. |
| Regressions | Count | Close to 0. |
| Agent agreement | Coordinator accepted the proposal unchanged / total proposals | ≥ 85% (tracks rule quality). |
| Override hot-spots | Rules with the most overrides | Feeds the rule backlog. |

---

## How the agent replicates this

Split the work: **deterministic engine for volume, LLM for judgment and language.**

| Step | Engine (`core/`) | Agent (LLM via MCP tools) |
|---|---|---|
| 1 Hygiene | Run H1–H10 and produce a hygiene report. | Summarize it in Spanish. Recommend stopping if H2, H3 or H8 fail. |
| 2–3 Matrix and tolerance | Filter pairs, apply tolerances. | Explain the matrix when asked; propose project overrides. |
| 4 Order | Sort groups by band, then review step, then level. | Present the queue in that order. |
| 5 Grouping | Run the deterministic algorithms. | Name groups in plain Spanish; suggest merges the algorithm can't see (same root cause across levels). |
| 6 Classification | Rules, scores, rationale. | Review `humanReview` groups with the viewer; challenge low-confidence rules; draft rule changes as proposals. **Never re-classify silently.** An override is a recorded proposal with a reason. |
| 7 Issues | Fill templates (title, location, IDs, due date). | Write the description, the requested action and options. |
| 8 Re-test | Diff, inherit, regressions. | Report what changed since the last cycle in five lines. |
| 9 KPIs | Compute. | Narrate trends and blockers for the meeting. |

Agent operating rules:
1. Always start a session with the hygiene report and the cycle diff, not with a list of clashes.
2. Work on **groups**. Show clash-level detail only on request or for `critical`.
3. Every proposal cites the `ruleId`, the confidence, and the clash keys it covers.
4. Use Spanish for everything a coordinator reads.
5. Say "no sé" (I don't know) and propose `needs_info` rather than guess. A wrongly closed real clash is the worst error class.

### Where human judgment is mandatory (the agent proposes, a human decides)

- Any `critical` severity, and any **opening in structure**. Only the calculista can approve it. The agent never states that an opening is acceptable.
- Changing **ceiling heights, clear heights, door or window openings, or egress paths**. These are ARQ design and permit-drawing (DOM) matters.
- **Life safety** and **regulatory** calls: NFPA 13 obstructions, gas separations (DS 66), fire ratings (OGUC/NCh). The agent cites them as references, never as compliance verdicts.
- **Bulk closure** of more than 50 clashes in one action, or any closure of a group tagged `seguridad_personas`.
- Gravity-versus-gravity and equipment-layout conflicts (`escalate`).
- **Assigning to a company or person** and setting due dates that change the contract schedule.
- Editing rules in `rules/`. The agent drafts a change and its eval impact; a coordinator commits it.
- Anything with confidence < 0.70, `needs_info`, or DEF-999.

### Gaps the engine must handle explicitly

| Need | Status | Handling |
|---|---|---|
| Clash point / bounding box (zones, grid bays) | Probably not in the MC clash resource | Compute from viewer fragment bounding boxes (browser) or the derivative. Until then, group by level only. |
| `orientation` of MEP segments | Not in Model Properties | Derive from bounding-box aspect ratio (vertical if dz > 3·max(dx, dy)). Rules degrade to EST-011 and MA-005 without it. |
| Nesting (`nestedRelation`) | Instance tree, not properties | Model Derivative object tree or viewer `instanceTree`. Without it, FP-013 never fires. |
| `modelAgeDays` | Document version metadata | From the model-set version `documentVersions` and the Data Management API version dates. |
| Fire rating, structural flag, phases | Instance or type parameters; names vary with Revit language | Map aliases in the property normalizer, not in the rules. |
| Schedule | None | Neutral factor (0.5). |
