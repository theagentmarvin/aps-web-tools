# Clash taxonomy

Owner: BIM coordination specialist. Status: v1 (seed). Binding for `core/classify`, `core/score`, the MCP tools and the agent prompts.

Machine-readable counterparts:
- `rules/classification-rules.yaml`: the rules that assign every dimension below.
- `rules/discipline-matrix.yaml`: discipline codes, element classes, who-moves, tolerances.
- `rules/priority-scoring.yaml`: severity → 0–100 priority → P1–P4.

Every classified clash carries the dimensions below. Enum values are English identifiers. UI labels are Spanish (column "ES").

```
Classification {
  validity, nature, rootCause,
  responsibleDiscipline, secondaryDiscipline?, mover?,
  severity, confidence, suggestedAction, humanReview,
  ruleId, rationale (es), tags[]
}
```

---

## 1. Nature (what kind of conflict)

| Value | ES | Definition | Source in our data |
|---|---|---|---|
| `hard` | Interferencia física | Two solids occupy the same space. | MC clash with `dist < 0` (penetration). This is almost everything ACC Model Coordination produces. |
| `clearance` | Holgura / espacio libre | Objects don't touch, but a required gap is violated: insulation not modeled, hangers, maintenance access, gas-to-electrical separation, sprinkler spray pattern. | (a) `dist ≥ 0` but below the pair's `clearanceMm`, if a clearance-capable source is ever ingested. (b) A hard clash against a **modeled clearance zone** (generic model named "zona de mantención…"). (c) Insulation against another system. |
| `duplicate` | Duplicado | The same thing is modeled twice: the same element in two files, two viewables of one file, identical overlapping instances, or ARQ re-modeling the structure. | Same `externalId`, or high `penetrationRatio` with the same category and type. |
| `workflow` | Secuencia / 4D | The conflict exists only in time: temporary works, demolished-versus-new, phases. | Phase parameters, temporary-works families. |

As far as we know, ACC Model Coordination runs **hard clash only** and has no user tolerance (confirm against `docs/research/aps-model-coordination-api.md`). It reports every touch. So in this harness, tolerance and clearance are applied *after* ingest (see `tolerances` in the matrix). Do not expect clearance results from MC itself.

## 2. Validity (is it a problem?)

| Value | ES | Test an expert applies | Default action | MC status we propose |
|---|---|---|---|---|
| `real` | Real | Would this stop or force rework on site if built as modeled? Yes. | Create an issue (or join a group issue). | Assigned to an issue. |
| `false_positive` | Falso positivo | The geometry overlaps by design or because of how the model is built. Nobody needs to change the design. | Close as "no es problema". Fix the **test configuration** so it doesn't come back. | Closed or not an issue, with reason = ruleId. |
| `tolerated` | Aceptable / tolerada | It is a real overlap, but it is absorbed on site by normal practice: within tolerance, a standard partition penetration, a conduit embedded within code limits, flex routing. | Mark reviewed. No issue. | Reviewed, with reason. |
| `needs_info` | Requiere información | You cannot judge it: a generic model with no stated function, a placeholder, missing properties, a stale model. | Ask the owner. No design issue yet. | Stays active, with a request recorded. |

Rules of thumb:
- **When in doubt between `real` and `false_positive`, choose `needs_info`.** Wrongly closing a real clash costs far more than asking.
- A false positive that repeats more than about 20 times per cycle is a **test-design defect**. The fix is a search-set or exclusion change, not 20 closures.
- `tolerated` always needs a reason a superintendent would accept ("pasada estándar en tabique", "bajo 1/3 del espesor de losa"). "Es chico" is not a reason.

## 3. False-positive patterns (catalogue)

These are the patterns a senior coordinator dismisses in seconds. Each one lists how it shows up in MC data and the rule that catches it.

| # | Pattern | How it looks in the data | Rule | Permanent fix |
|---|---|---|---|---|
| 1 | Insulation against its own pipe or duct | Insulation category, same file, same `systemName`. Penetration ≈ insulation thickness. | FP-001, FP-002 | Exclude Pipe/Duct Insulation and Linings against same-file MEP. |
| 2 | Connected components of the same run (pipe–fitting–valve, duct–terminal) | Same file, same `systemName`, both MEP. | FP-003 | Don't run self-clash inside MEP files. |
| 3 | Hosted fixtures in ceilings (lights, diffusers, sprinkler heads, detectors) | Ceiling-hosted category against Ceilings. | FP-008 | Exclude those categories against Ceilings. Coordinate the reflected ceiling plan (RCP) separately. |
| 4 | Wall-hosted devices (outlets, switches, wall-hung WCs, grilles) | Wall-hosted category against Walls, penetration ≤ 150 mm. | FP-009 | Exclude, except electrical panels (*tableros*), which need a niche. |
| 5 | Sleeves and openings modeled as separate families (*pasadas*, *camisas*) | Generic Model or Accessory named pasada, camisa, sleeve or hueco. | FP-010 | Ask the modelers to make sleeves cut their host (void-based). Then no clash appears at all. |
| 6 | Fire stopping, collars, intumescent seals | Firestop families. | FP-011 | Exclude. |
| 7 | Fire damper inside a rated wall or slab | Duct Accessory named damper, compuerta or cortafuego, against Walls/Floors. | FP-012 | Exclude dampers against walls and floors. |
| 8 | Slab versus a penetrating pipe *with* an opening | **Key insight:** if a real void cut the slab, there would be no clash. A clash against a slab therefore means the opening is missing, undersized, or modeled as a non-cutting family (pattern 5). | FP-010 when a sleeve exists. Otherwise EST-009/EST-011 (real: missing opening). | Openings in EST cut the slab. |
| 9 | The same element in two files (copied or linked model, model loaded twice) | Same `externalId`, different `modelFile`. | DUP-001 | Clean the model set. |
| 10 | The same file entered twice (two 3D viewables, e.g. "{3D}" and "Navisworks") | Same `externalId`, same `modelFile`, different `documentId`. | DUP-002 | One viewable per file in the coordination view. |
| 11 | ARQ re-modeled the structure (RC walls, slabs) | ARQ wall or floor overlapping an EST wall or floor by ≥ 80% of thickness. | DUP-005, DUP-006 | ARQ links EST and models only finishes. Raise one hygiene issue, not hundreds of clashes. |
| 12 | Foreign copies (structural columns inside the ARQ file) | `isForeign` (category belongs to another discipline group) and same category on the other side. | DUP-004 | Delete the copy and link the source. |
| 13 | Analytical or placeholder elements (analytical model, masses, rooms, spaces, "referencial" or "dummy" families) | Non-physical categories, analytical, Mass; placeholder names. | HYG-002, NI-002 | Exclude non-physical categories in the test. Ask for LOD on placeholders. |
| 14 | Generic Models with unknown purpose | Category Generic Models that isn't a sleeve, firestop or clearance zone. | NI-001 | Require proper categories (BEP clause). |
| 15 | Nested family subcomponents | One element is the parent of the other in the instance tree. | FP-013 | Nothing. This is an engine artefact. |
| 16 | Rebar against its concrete host | Rebar category against EST or structural elements. | FP-004, FP-005 | Exclude rebar from coordination tests at this stage. |
| 17 | Ceiling grid or panels against light fixtures and terminals | Same as pattern 3. | FP-008 | — |
| 18 | Small or flexible conduit under tolerance | Conduit ≤ Ø25 with ≤ 25 mm penetration against non-structure; flex duct or pipe ≤ 100 mm. | TOL-007, TOL-004 | Accept. These are field-routed. |
| 19 | Conduit embedded in an RC slab or wall (normal Chilean practice) | Conduit against an EST floor or wall, Ø ≤ 1/3 of the thickness. | TOL-005 (otherwise TOL-006 is real) | Accept per ACI 318 / NCh 430 embedment limits. Larger ones need the structural engineer (*calculista*). |
| 20 | Finish layers over structure (*sobrelosa*, *revestimiento*, *pavimento*) | ARQ Floors or Walls whose type looks like a finish, against structure. | FP-014 | Model finishes as separate thin layers. Exclude finish types versus EST. |
| 21 | Same-file architectural joins (ceiling to wall, wall to wall, railing on stair) | Same file, both architectural categories. | FP-007 | Don't self-clash the ARQ file in coordination tests. |
| 22 | Same-file structural joins (beam to column to slab) | Same file, both EST. | FP-006 | Don't self-clash the EST file. |
| 23 | Demolished or existing-phase elements | `phaseDemolished` is set. | HYG-001 | Filter by phase in the view. |
| 24 | Topography against foundations or buried networks | Site or Toposolid categories. | FP-015 | Exclude topography. |

## 4. Root cause

| Value | ES | Meaning | Typical signals |
|---|---|---|---|
| `design_coordination` | Coordinación de diseño | The disciplines' designs genuinely conflict and someone has to make a design decision. | MEP versus structure, gravity versus gravity, beam below ceiling. |
| `routing_conflict` | Conflicto de trazado | Correct systems, wrong path. A modeler can fix it without changing the design intent. | MEP against MEP, MEP in a door opening, a horizontal pipe embedded in a slab (wrong offset). |
| `missing_opening` | Falta pasada / vano | The crossing is intended, but the opening, sleeve or fire seal is not modeled or approved. | A vertical riser through a slab, MEP through an RC wall, MEP through a rated wall. |
| `modeling_error` | Error de modelado | A geometry mistake: wrong level or offset, wall modeled into a beam, duplicate instances. | Very large penetrations (`penetracion_mayor` tag), identical instances. |
| `lod_mismatch` | Nivel de desarrollo insuficiente | An element is too generic or schematic to coordinate. | Generic models, placeholders. |
| `outdated_model` | Modelo desactualizado | One side was not republished. The clash may already be solved. | The `modelo_desactualizado` annotation (model age > 21 days). Coordinator sets it manually. |
| `duplicate_model` | Modelo duplicado | Copied, linked-twice or re-modeled content. | DUP-* rules. |
| `model_hygiene` | Higiene de modelo | Things that shouldn't be in the test at all. | HYG-* rules. |
| `not_applicable` | No aplica | False positives and tolerated clashes. | — |

`outdated_model` is deliberately not produced by any rule. The engine only tags. A human decides, because a 30-day-old EST model can be perfectly current.

## 5. Responsibility and who moves

Two different questions:
1. **Who must act?** That is `responsibleDiscipline`, the owner of the issue.
2. **Which element moves?** That is the `mover`. Usually it belongs to the same discipline, but not always. A riser crossing a slab is moved by nobody: EST models the opening (EST-009).

`secondaryDiscipline` is the approver or the party consulted. Examples: EST approves every opening in structure; ARQ approves ceiling height changes; INC approves a sprinkler change.

### Who-moves hierarchy (from hardest to easiest to move)

```
100  Structure (columns > beams, RC walls, slabs, foundations) · elevators · site
 95  Stairs, roofs
 90  Gravity drainage (ALC/ALL, condensate) · doors/windows · facade
 85  Architectural walls and floors
 80  Large ducts (≥400 mm) and smoke-control / pressurization ducts · railings
 70  MEP equipment (fixed by plant-room layout)
 65  Cable trays (escalerillas)
 60  Ducts < 400 mm
 58  Fire mains (INC ≥ Ø65)
 55  Pressurized pipe ≥ Ø100
 50  Furniture / other
 45  Ceilings (ARQ decides; lowering a ceiling is a design change)
 40  Pressurized pipe < Ø100
 35  Fire branch lines
 30  Sprinkler heads
 25  Terminals (lights, diffusers, devices)
 20  Conduit
 10  Flex duct / flex pipe
```

Resolution algorithm (`whoMoves` in the matrix):
1. **Overrides first.** Examples: structure never moves against MEP. Gravity always wins. A sprinkler adjusts to the obstruction. Terminals and equipment are fixed by the reflected ceiling plan or the room layout, so the distribution moves. Fixed architectural elements against MEP: MEP moves.
2. Otherwise the lower `moveRank` moves.
3. A tie (≤ 5 points apart) goes to the smaller `sizeMm`. If there is still a tie, the mover is `none` and the responsible party is `COORD` (the coordinator decides in the meeting).

Opinions encoded here that you may want to tune per project:
- **The fire main is not sacred against ducts.** It ranks slightly below small ducts because steel pipe is easier to offset than a duct. Life-safety priority comes through **severity**, not rank.
- **Ceilings rank low (45) but never move automatically.** The rule assigns MEP first, with ARQ as secondary. Lowering a ceiling changes the clear height in the permit drawings (DOM).
- **Gravity against gravity always escalates to COORD.** Choosing which network gives up slope needs both engineers.

### Chilean responsibility context
- *Arquitecto* (ARQ) leads design. *Ingeniero calculista* (EST) owns structure, and **every penetration in structure needs their written approval**. Large or seismic-relevant structures also carry an independent structural review (*revisor de cálculo*). Specialists (*especialistas*: CLI, SAN, ELE, CORR, INC, GAS) design their systems. SalfaCorp as builder (the *constructora*'s BIM team) coordinates. The ITO inspects.
- Sanitary projects often include the wet riser network (*red húmeda*) and sometimes the dry riser (*red seca*). The engine re-assigns fire systems to INC by system classification even inside a SAN file.
- Gas follows the SEC regulation (DS 66) and electrical follows the RIC technical specifications. Gas against electrical is never "tolerated" (TOL entries for GAS-ELE have 0 mm tolerance).
- Seismic: RC shear walls (*muros HA*) are everywhere and are critical. Penetrations through them are `high` by default. Non-structural components follow NCh 3357. MEP crossing seismic joints needs flexible connections (SEI-001).
- Embedded conduits in slabs and walls are standard practice (TOL-005).
- Post-tensioned slabs (*losas postensadas*) are common in towers and parking. Any unplanned penetration is `critical` (EST-003).

## 6. Severity

Severity is the **consequence if built as modeled**, independent of urgency.

| Value | Score | ES | Definition | Examples |
|---|---|---|---|---|
| `critical` | 4 | Crítica | Structural integrity, life safety, regulatory rejection, or a gravity system that cannot work. Needs a design decision by an engineer. | MEP through a column; gravity pipe through a beam; large duct through a beam; anything in the elevator shaft; unplanned penetration of a post-tensioned slab. |
| `high` | 3 | Alta | Significant rework or redesign across disciplines; affects egress, fire protection, openings or structure approval. | MEP through an RC wall; sprinkler obstructed; MEP in a stair or door opening; beam below the ceiling; gas against electrical; gravity against other MEP. |
| `medium` | 2 | Media | A routing conflict solvable within one discipline with moderate effort; a missing opening in a slab. | Duct against tray; pipe against pipe; MEP below the ceiling; riser without an opening. |
| `low` | 1 | Baja | Local adjustment on site or a modeling-hygiene item. | Conduit against MEP; insulation clearance; partition overlapping a beam > 100 mm; MEP through a roof needing a flashing detail. |
| `none` | 0 | — | Not a problem (false positive or tolerated). | — |

Severity is assigned by the rule. The engine forces `none` whenever validity is `false_positive` or `tolerated`.

## 7. Priority

Priority is **urgency**: severity plus context. It is computed in `rules/priority-scoring.yaml`:

```
score = 100 × (0.35·severity + 0.15·disciplineCriticality + 0.15·penetration
             + 0.10·elementSize + 0.10·zoneCriticality + 0.10·groupCount
             + 0.05·scheduleProximity)
```

The overrides then apply:
- non-issues → 0;
- `critical` → at least 75;
- life-safety `high` or `critical` → at least 70;
- `needs_info` → at most 60;
- hygiene → at most 45.

Bands:

| Band | Score | Meaning | Target |
|---|---|---|---|
| **P1** | ≥ 75 | Resolve before the next coordination meeting | 3 business days |
| **P2** | 50–74 | Resolve within the weekly cycle | 7 business days |
| **P3** | 25–49 | Resolve before the delivery milestone | 14 business days |
| **P4** | < 25 | Backlog or next model revision | 30 business days |

Calibration of the seed weights against the eval set:
- every `critical` clash lands in P1;
- life-safety `high` clashes land at 70 or above;
- MEP-versus-MEP `medium` clashes land around 45–50.

The schedule factor is neutral (0.5) until a schedule source exists. Once it does, it moves a clash by at most ±2.5 points. It is intentionally weak.

## 8. Confidence and human review

- `confidence` comes from the rule. It reflects how often a senior coordinator would agree with that rule on that pattern.
- The engine sets `humanReview = true` when any of these hold:
  - severity is `critical`;
  - confidence < 0.70;
  - validity is `needs_info`;
  - the rule says so (e.g. EST-011 when orientation is unknown, DEF-999).
- Bulk closures of non-issues: at autonomy L3 (future), only `false_positive` with confidence ≥ 0.9 and no `seguridad_personas` tag may be auto-applied. In v1 everything is a proposal.

## 9. Suggested actions

| Value | ES | When |
|---|---|---|
| `close_not_issue` | Cerrar: no es problema | False positives. |
| `mark_reviewed` | Marcar revisada | Tolerated. |
| `create_issue` | Crear incidencia | Real. Normally on the **group**, not per clash. |
| `hygiene_issue` | Incidencia de higiene de modelo | Duplicates and copies. **One per responsible file and rule**, not per clash. |
| `request_info` | Solicitar información | Needs info. |
| `escalate` | Escalar a reunión | COORD-owned decisions: gravity versus gravity, equipment versus equipment. |
