# Solution families: a classification tree for grouping clashes

Owner: BIM coordination specialist. Status: **proposal v1 (2026-11-09)**, measured on real data. Extends `grouping-strategies.md` (G0–G7 stay as they are) and `clash-taxonomy.md`. No code has been changed yet.

Data used: ACC project `da524c2d…`, model set `71941e30…` **v11**, test `T-3bde5861` (5,549 clashes, 201 groups), from `GET /api/coord/triage/…?test=T-3bde5861` on 2026-11-09. The analysis was a throw-away Node prototype (signature versions v0–v6), not repo code.

---

## 0. Executive summary

- **The coordinator's feedback is right, and the data proves it.** The 15 groups titled "Viga 12" x 18" atravesada por 8 tuberías de CAL — {nivel}" are **one** decision: the same 8-pipe, 4-pipe hydronic bundle (Ø22–Ø54) in the bottom 35–86 mm of the same beam type on 3 floors. They become **one family with 15 instances** (120 unique conflicts, 360 raw).
- **Real groups 153 → 28 real families** (5.5× fewer decisions). **99.7% of the unique real conflicts (1,060 of 1,063)** fall in families with ≥ 2 instances. Across all validities: **201 groups → 245 instances → 33 families**, and 95.2% of unique conflicts (97.6% of raw clashes) are in families with ≥ 2 instances. 19 families qualify as a **typical detail** (≥ 3 instances on ≥ 2 levels).
- **Recommendation: go with changes.** The 4-level tree works. These changes are needed:
  1. Compute the signature **per clash**, not per group. An instance is *group ∩ family*: 31 of 201 groups mix 2 to 5 solutions (for example, one slab with ALC, CAL, AP and CLI risers).
  2. **Leave validity out of the signature.** Validity is the decision, not an input. Leaving it out exposed 5 families where the engine gave the same physical situation different verdicts (AP supply into a basin: 432 tolerated against 96 real).
  3. Use a **host-relative** size band (Ø vs h/3 for beams), not absolute Ø bands.
  4. Take the geometric relation from the **required displacement** (penetration vs host depth), because the payload has no orientation or coordinates.
  5. Put the host *type* in the key only where the type changes the solution (beams, slabs, walls). Use the class only for columns and footings.
  6. Give hygiene and duplicates their own level-1 bucket. Do not file them under discipline pairs.
- Families also work as a **classification audit**. 4 of the top 15 real families are almost certainly false positives that the rules miss: a drain or supply connected to its own fixture, pipes inside a "PIPE COVER" enclosure, a duct connected to its fan-coil. A further 166 "real" DEF-999 conflicts are three structural models superimposed. Once the families exist, the coordinator closes each of these with one decision.

---

## 1. What the real v11 data looks like

| Fact | Value | Consequence for the design |
|---|---|---|
| Raw clashes in the payload | 5,549 | Groups' `clashIds` are raw. "atravesada por 8 tuberías" carries 24 clashIds. |
| Unique physical conflicts (sorted `externalId` pair) | **2,619** | Families must count **unique** conflicts. The ×2–×3 inflation comes from MECHANICAL.rvt being loaded twice (docs 1 and 2). Doc 2 also carries a linked copy of STRUCTURAL_VDC with the same externalIds. |
| Pairs whose raw duplicates fall in different groups | 0 | G0 dedupe is consistent. Only the counts are inflated. |
| Unique conflicts by validity | real 1,063 · tolerated 563 · false_positive 558 · needs_info 435 | |
| Structural models in the set | MODELING TEST S3, MODELING TEST S4, STRUCTURAL_VDC (+ VDC copy inside MECHANICAL doc 2) | 166 "real" DEF-999 conflicts are **model superposition**, not design conflicts. |
| Fields per side | category, family, type, system (instance name, e.g. "Hydronic Supply 38"), sizeHint (Ø29, 305x457, 6"ø-6"ø-4"ø), level, modelName, discipline | **Missing:** orientation (vertical/horizontal/sloped), slope, clash point, bbox, connector graph, per-clash `ruleId`. The rules use orientation internally (EST-002/009/010/011), but it does not reach the payload. |
| Level semantics | The beam "201 SECOND FLOOR" is clashed by pipes on "101 FIRST FLOOR" | The beam's level is the floor it supports. The work happens in the **ceiling void of floor 1**. Instance labels must say "entretecho P1 (viga nivel 201)". |

---

## 2. The signature (final definition, v6)

A **signature** is computed **per unique clash**. Clashes with the same signature are resolved the same way, wherever they are. Location (level, grid, host instance) is deliberately **not** part of it.

```
signature = problemType
          | hostKey        // the element that does not move
          | moverClass     // the element that moves
          | systemClass    // of the mover
          | sizeBand       // host-relative where the host governs the solution
          | relation       // geometric relation / required displacement

familyId = "F-" + sha1(signature)[0..10]        // stable across cycles while the signature is stable
instance = (groupId, familyId)                  // today's group, cut by family
```

### 2.1 Roles (host vs mover)
Rank each side and make the higher rank the host: structure 100 > equipment/fixture 95 > gravity pipe 90 > ARQ wall 85 > duct 60 > pressure pipe 40 > conduit/tray 30. This follows the who-moves hierarchy in `clash-taxonomy.md` §5. For PT12–PT14 roles don't matter.

### 2.2 Components

| Component | Definition | Why (expert reasoning) |
|---|---|---|
| `problemType` | §3, derived from the **physical configuration** (classes + the rule's orientation evidence), not from validity. | The decision lives inside the family. Validity is its *output*. |
| `hostKey` | Structure: `class:type` for **beam, slab, foundation slab, RC wall**. **Class only** for column, footing, slab edge. Equipment/fixture: `class:family`. MEP host: `class:systemClass`. | The beam type gives h, so the admissible-opening rule (Ø ≤ h/3, middle third) depends on it. The slab type gives thickness and deck. Columns never take openings whatever the type, so splitting by column type only adds noise. |
| `moverClass` | `tub_grav` · `tub_pres` · `ducto` · `elec`. **Pipe + fitting + accessory are merged**, and so are duct + fitting. | A wye and the pipe beside it are the same run and the same fix. |
| `systemClass` | ALC-servidas / ALC-ventilación / ALL-aguas lluvia / AP-agua potable / CAL-hidrónica / INC / CLI-inyección / CLI-retorno / CLI-extracción. **Not** the Revit system instance name ("Hydronic Supply 38"). For PT09 (MEP vs equipment) use the discipline only. If a duct has no system, inherit the group's dominant system class. | HHWS, CHWS and HHWR in the same 4-pipe bundle are one detail. AP-fría and AP-caliente cross a slab the same way. |
| `sizeBand` | **Beam:** `≤h/3` or `>h/3` (mover Ø or max side vs beam depth). **Slab or foundation slab:** `≤Ø110` · `Ø111–160` · `>Ø160` · `rect` (duct). MEP×MEP and equipment: `tubería`/`ducto`. Other hosts: absolute `≤Ø50` · `Ø51–110` · `Ø111–160` · `>Ø160`; ducts `≤300` · `301–600` · `>600`. | An absolute band split the CAL bundle at Ø50 (Ø29 beams vs Ø54 beams) although the solution is identical. Ø110 is the Chilean PVC stack size: above it the slab opening needs explicit calculista approval and rib checks. |
| `relation` | **Beam:** `atraviesa_alma` if penetration ≥ h/2, else `desplazar≤100` / `desplazar101–250` / `desplazar>250`. **Slab:** `vertical` (EST-009/003), `horiz_pend·desplazar≤100` or `>100` (EST-002/010), `orient_desc` (EST-011). Foundation: `fundación`. Column: `atraviesa`. Equipment: `contacto_equipo`. MEP: `cruce`. | MC distance is the minimum separating translation. A pipe through the middle of a 457 mm beam shows ≈ 230 mm or more. 35–86 mm means it sits in the bottom band, so "bajar ~100 mm" solves it with no opening. This is the "ducto bajo viga, altura insuficiente" case the coordinator named. |

Non-real fallback: a false-positive or tolerated clash joins a physical family **only if that family also has real members**. That is where a contradiction is worth showing. Otherwise it goes to a rule-based batch family `PT14 | ruleId | validity | con estructura / entre instalaciones`. Hygiene (PT13) is keyed `ruleId | offending file`. Duplicates (PT12) are keyed by the **origin-file pair**: the origin is the document whose discipline matches the element, which undoes the linked copy inside MECHANICAL.rvt.

### 2.3 How the signature was iterated (all measured on v11, instance = group ∩ family)

| Version | Change | Instances | Families | Families ≥ 2 inst. | % unique in families ≥ 2 | Families with real | Single-instance real families |
|---|---|---|---|---|---|---|---|
| v0 | rule + host type + mover category + system name | 600 | 195 | 110 | 71.3% | 89 | 27 |
| v1 | + problem type, pipe/fitting merged, system class, absolute Ø bands | 278 | 75 | 45 | 73.7% | 58 | 17 |
| v2 | host-relative band (Ø vs h/3) | 268 | 70 | 40 | 73.7% | 53 | 17 |
| v3 | duplicates by file pair, PT09 by discipline | 249 | 47 | 28 | 74.3% | 32 | 8 |
| v4 | relation = required displacement, column/footing by class, non-issues by rule | 246 | 35 | 29 | 95.2% | 29 | 4 |
| v5 | validity removed from the signature (physical typing) | 249 | 43 | 27 | 91.8% | 28 | 3 |
| **v6 (final)** | MEP host by system class, non-real joins only real families, origin-file resolution | **245** | **33** | **28** | **95.2%** (97.6% raw) | **28** | **3** |

Distribution in v6, by instances per family: 1 → 5 families · 2–4 → 9 · 5–9 → 10 · ≥ 10 → 9.
Real only: **153 real groups → 195 real instances → 28 families**. 25 of the 28 have ≥ 2 instances and cover **1,060 / 1,063** unique real conflicts.

### 2.4 Top 15 families (v6) and the single decision each one needs

Counts are unique conflicts. "Ubic." is the number of instances (today's groups, or group slices).

| # | Family (signature, readable) | Ubic. | Unique (raw) | Validity today | Host levels | Proposed single decision |
|---|---|---|---|---|---|---|
| 1 | PT09 · ALC Ø38–41 (pipe/tee/elbow) vs lavamanos "Bathroom Sink (Yacht)" | 36 | 129 (258) | 111 real, 18 tol. | P1–P3 | **False positive: drain connected to its own fixture.** Close it and add rule FP-016 "red conectada a su artefacto". Exception: a straight pipe crossing the cabinet body. |
| 2 | PT13 · HYG-004 · elements without a category in **Sitio Vol.ifc** | 18 | 435 (853) | needs_info | all | Remove the site-volume IFC from the clash test. One hygiene issue to COORD (shared with #3). |
| 3 | PT13 · HYG-002 · Mass in **Sitio Vol.rvt** | 15 | 435 (853) | FP | all | Close. Exclude the Mass category / the file from the set. |
| 4 | **PT02 · viga 12"x18" (h 457) · CAL-hidrónica Ø22–54 · ≤h/3 · desplazar ≤100** | 15 | 120 (360) | real (P2/P3) | 201, 301, 401 (ceiling voids P1–P3) | **Typical detail:** lower the 8-pipe bundle ~100 mm below the beam soffit (max. penetration 86 mm), with ARQ checking ceiling height. Alternative: typical sleeves Ø ≤ 150 in the middle third, subject to the calculista. One issue to CAL; EST and ARQ consulted. |
| 5 | PT12 · superposition **S4 + STRUCTURAL_VDC** | 15 | 53 | "real" DEF-999 | foundation | Model-set hygiene: VDC is a foreign sample model. Remove it from the set and close the clashes as a duplicated model. |
| 6 | PT04 · losa 3" LW/deck · ALC-servidas ≤Ø110 · vertical | 12 | 86 (258) | real | 201–401 | EST models typical slab sleeves (Ø + 50) from the ALC opening schedule; ALC confirms Ø and grid; fire seal. |
| 7 | PT05 · losa 3" LW/deck · ALC-servidas ≤Ø110 · horizontal/sloped · desplazar ≤100 | 12 | 72 (216) | real P1 | 201–401 | Correct the start level and slope of the Ø75–100 branches that sit 25–50 mm inside the slab: lower them into the ceiling void. One issue to ALC. |
| 8 | PT04 · losa · CLI-extracción rect (6"x6" taps) · **orient_desc** | 12 | 56 (168) | real (EST-011, humanReview) | 201–401 | **Look at one instance and decide for all 12.** If it is a riser, it becomes an opening and merges with #14. If it is embedded, CLI lowers it. |
| 9 | PT12 · superposition **S3 + S4** (S301 vs S401 families) | 11 | 52 | "real" DEF-999 | Nivel 1°, fundación | Two revisions of the same structure are loaded together. Keep only the current one. |
| 10 | PT09 · CAL vs equipment "PIPE COVER" | 9 | 72 (144) | real | 401 ROOF | False positive: the cover encloses the pipes by design. Exclude the PIPE COVER family from the test, or check its clear inside size once. |
| 11 | PT12 · superposition **S3 + VDC** | 8 | 40 | "real" DEF-999 | foundation | Same decision as #5 and #9. |
| 12 | PT09 · AP vs "PIPE COVER" | 8 | 32 (64) | real | 401 ROOF | Same as #10, responsible AP. |
| 13 | PT04 · losa · CAL-hidrónica ≤Ø110 · vertical | 8 | 28 (84) | real | 201, 301 | Same as #6. The sleeve allows for insulation (Ø + insulation + 25 mm). |
| 14 | PT04 · losa · CLI-extracción rect · vertical | 8 | 16 (48) | real | 201, 301 | EST models rectangular openings; CLI confirms size; fire damper/collar per rating. |
| 15 | PT09 · AP Ø16–54 vs lavamanos "Bathroom Sink (Yacht)" | 6 | **528** | **432 tolerated + 96 real** | P1–P3 | Supply connection to a fixture is a false positive. Make the verdict consistent: today a penetration threshold splits one physical situation into two verdicts. |

Also worth noting: #18 PT02 · duct CLI-inyección 356x203 vs the same beam type, 3 instances and 47 conflicts, penetration 173–174 mm. Decision: lower 200 mm, or flatten to ≈ 457x152 (similar area). An opening is not admissible (> h/3).

### 2.5 Where the signature still merges or splits wrongly (honest list)

**Merges a coordinator might keep apart:**
1. **#1 and #15 (connections to fixtures).** Without a connector graph the signature cannot tell "the trap enters the basin" from "a pipe passes through the vanity". Mitigation: spot-check 3 instances before approving. A straight `Pipes` member with penetration > Ø becomes a candidate exception.
2. **#6 (ALC ≤Ø110 vertical).** Ø41 lavatory drains and Ø105 stacks are merged. The decision (EST models from the schedule) is the same, but the sleeve sizes differ. The family detail pane must show the Ø breakdown.
3. **PT07 foundation slab (5 instances, 48 real + 16 tolerated).** The family mixes risers through the slab-on-grade and buried runs touching its underside. Neither orientation nor coordinates are available, so they can't be separated.

**Splits a coordinator would merge:**
1. **#8 vs #14.** The same CLI exhaust system through the same slabs is split only because EST-011 lacks orientation. One look resolves it. The UI needs **"Fusionar familias"**.
2. **PT04 ALC ≤Ø110 vs Ø111–160** (2 instances, 6 conflicts). The split is defensible (the calculista threshold), but it is a borderline case.
3. **PT12 by file pair** (S3+S4, S4+VDC, S3+VDC, MECH+S3, MECH+S4). The real decision is "which structural model is valid", one decision at problem-type level. The tree's level 2 handles it ("aprobar todo el tipo").
4. **A duct with no system** (1 conflict) lands in its own family, "CLI-ducto". The group-dominant fallback missed it. There is the same risk wherever system data is incomplete.
5. **Heterogeneous hub groups.** A hub-fixed slab group ("Losa … atravesada por 16 elementos de ALC/AP/CAL/CLI") is one work location but 3–4 families. This is correct for decisions. Execution still needs the per-location view ("plano de pasadas nivel X"), see §5.4.

---

## 3. Level 2: problem-type taxonomy (closed list)

Each type has one Spanish name, a mapping from the existing rules, a default responsible party, and the typical solution options (from `issue-writing-guide.md`, in preference order). `PT00` is the catch-all, so the list stays closed.

| Code | Nombre (ES, UI) | Rules / signals that map to it | Default responsible → consulted | Typical solution options |
|---|---|---|---|---|
| PT01 | Pasada de instalación en viga | EST-004/005/006 with penetration ≥ h/2 | mover → EST | 1) Reroute under the beam. 2) Opening in the middle third, Ø ≤ h/3, subject to the calculista. 3) Split or flatten the duct. |
| PT02 | Instalación invade franja de viga (altura insuficiente) | EST-004/005/006 with penetration < h/2; AE-002 for ARQ | mover → ARQ (ceiling), EST | 1) Lower by penetration + 25 mm, checking ceiling height. 2) Flatten the duct (same area). 3) Typical opening if Ø ≤ h/3. |
| PT03 | Instalación atraviesa pilar | EST-001 | mover → EST | Reroute, mandatory: columns take no openings. |
| PT04 | Montante cruza losa sin pasada | EST-009, EST-003 (post-tensioned), EST-011 *provisional* (`orient_desc`) | **EST** → mover | EST models the opening from the discipline's schedule. Fire seal. Post-tensioned slab: coordinate with the tendons before pouring. |
| PT05 | Tramo horizontal o en pendiente embebido en losa | EST-010, EST-002 vs slab | mover → EST | 1) Lower into the ceiling void (fix the level/slope). 2) Gravity pipes with no fall available: slab recess or shaft (calculista). |
| PT06 | Instalación atraviesa muro estructural o cortafuego | EST-007, MA-006, MA-007, MA-013 | mover → EST / ARQ | Opening approved by the calculista and modeled by EST; certified fire seal; or reroute. |
| PT07 | Red enterrada o pasada en fundación | EST-008, EST-002 vs foundation | mover → EST | Check the buried network levels (below the founding level) or a sleeve in the grade beam. Decide **before excavation**. |
| PT08 | Cruce entre redes de instalaciones | MM-001, MM-002 (vs MEP), MM-003, MM-004, MM-008, MM-010 | lower in the who-moves hierarchy (gravity never moves) | Move the one lower in the hierarchy. Gas vs electrical: regulatory separation. Gravity vs gravity: joint level study (COORD). |
| PT09 | Red contra equipo o artefacto | MM-005, MM-006, MM-009, MM-002 vs fixture | network → equipment owner | 1) If it is the network's own connection: false positive (new rule). 2) Reroute the network. 3) Relocate the equipment (layout). |
| PT10 | Holgura insuficiente (mantención, aislación, cielo, rociadores) | MM-007, TOL-002, CLR-001/002, INC-001, MA-005 | mover → ARQ / INC | Move to restore clearance; adjust the access zone; lower the ceiling (ARQ decision). |
| PT11 | Arquitectura, vanos y zonas restringidas | AE-001/003/004/005/006, MA-001…004, MA-008…012, ELV-001, SEI-001 | ARQ or mover → EST | Adjust the opening, wall or element; reroute out of the stair, shaft or seismic joint (flexible joint if it must cross). |
| PT12 | Modelos superpuestos o duplicados | DUP-001…006; structure×structure from **different origin files** (today DEF-999) | COORD / file owner | Clean the model set (one viewable per file, remove foreign or old copies). **One hygiene issue per file pair.** |
| PT13 | Higiene / información faltante | HYG-*, NI-*, `needs_info` | COORD / file owner | Exclude from the test or ask for LOD / category. |
| PT14 | No es problema (falso positivo / tolerado) | FP-*, TOL-* (with no real twin); structure×structure **in the same origin file** (FP-006 seen through a linked copy) | — | Close or mark reviewed with the reason; fix the test so it doesn't come back. |
| PT00 | Sin tipificar | DEF-999 that matches none of the above | COORD | Human review; the outcome feeds the rules curator. |

v11 coverage by type (unique conflicts / families): PT09 812/5 · PT13 870/2 · PT12 287/6 · PT04 212/6 · PT02 168/3 · PT14 107/3 · PT05 72/1 · PT07 66/2 · PT08 17/2 · PT03 6/1 · PT06 2/2. PT01, PT10, PT11 and PT00 have no members in this test.

Rule improvements the families surfaced (hand to `rules-curator`):
- **FP-016** "red conectada a su artefacto/equipo": a pipe/fitting with system ∈ fixture/equipment connected systems, against Plumbing Fixtures or Mechanical Equipment, penetration ≤ Ø + 25 mm. It would close #1, #15 and the fan-coil family: ≈ 700 unique conflicts.
- **FP-017** "envolvente de tuberías" (PIPE COVER, *cubre-tubería*, *shaft box*) vs the pipes it encloses.
- **DUP-007** "modelos de estructura superpuestos": structure×structure from different origin files with the same level band. It turns 166 "real" DEF-999 conflicts into one hygiene item per file pair.
- **FP-006** must compare the **origin** file (resolved by externalId), not `documentId`. Otherwise joins seen through a linked copy end up "real" (16 conflicts here).
- **Payload:** emit `orientation` (vertical / horizontal / sloped), `slopePct` and the clash point. Without them PT04/PT05 rely on rule ids, and `orient_desc` stays provisional.

---

## 4. Decision inheritance

### 4.1 What a family decision sets
A **family decision** is a versioned record:
```
FamilyDecision {
  familyId, version, decidedBy, decidedAt,
  validity,                       // real | false_positive | tolerated | needs_info
  action,                         // create_issue | close | mark_reviewed | hygiene_issue | escalate
  responsibleDiscipline, secondaryDiscipline?,
  solutionOption,                 // one of the problem type's catalogue options + free text
  typicalDetail?: { name, note }  // "Pasada tipo losa ALC ≤Ø110: camisa Ø+50, sello…"
  issueMode: 'family' | 'per_instance',
  spotChecked: groupId[]          // instances the coordinator actually looked at (≥1 required, ≥3 if > 50 members)
}
```
Approving a family applies these fields to **every instance that is not an exception**. Instance state becomes `heredada` (inherited). Priority is not inherited: each instance keeps its computed band, and the family shows the worst one (invariant 3 of the grouping doc, lifted one level).

### 4.2 Exceptions
- Exceptions are **instance-level**: override any field, with a mandatory reason (`excepción: tramo recto atraviesa mueble`). Clash-level exceptions are allowed. The clash is then split into its own instance under the same family.
- An exception survives later family decisions. A new family decision version never overwrites an exception, but the exception shows a "familia cambió" marker for review.
- **Detach instance** ("Separar de la familia") moves an instance to a manual family. The engine remembers the move (instance key → manual family) across cycles while the instance exists.
- **Merge families** ("Fusionar familias") records an alias `F-a → F-b`. Signatures that map to `F-a` resolve to `F-b` from then on. This is the fix for the #8/#14 case.
- **Mixed-validity guard:** if the family's instances currently carry different validities (5 families in v11), "Aprobar familia" lists the instances whose validity would change and asks for an explicit tick. Silent re-classification is never allowed.

### 4.3 Re-tests (new cycle)
| Situation in the new test | Behaviour |
|---|---|
| Instance still present and the family is decided | It keeps the inherited decision. Membership deltas are reported as today. |
| **New instance** whose signature matches a decided family | The decision is inherited as a **proposal**, with state `heredada · pendiente de confirmación`. The coordinator confirms in bulk ("Confirmar 3 nuevas ubicaciones"). **A real instance is never auto-closed or auto-assigned.** For FP/TOL families the inherited close is still a proposal and goes through the normal approval batch (with spot-check). |
| Instance disappears | Normal resolved logic. When every instance is resolved, the family is proposed for closure ("Ciclo n: familia sin interferencias"). |
| Signature changes (type renamed, system renamed, model replaced) | **Lineage match:** if ≥ 70% of the old family's clash identity keys now sit in one new family, link them, carry the decision as `pendiente de confirmación`, and note "firma cambió: {diff}". Otherwise the old family closes as resolved and the new one starts undecided. |
| Decision revised (new version) | Applies to non-exception instances. Any ACC issue already created gets a comment, not a new issue. |

### 4.4 Issues: one per family or one per instance?

**Default: one ACC issue per family** (`issueMode: 'family'`), with a per-instance fallback.

Reasons:
- The coordinator's complaint *is* that 15 issues for one decision is noise. `coordinator-ux-spec.md` §1 asks for "one issue per root cause". A family is a root cause. The modeler applies one typical detail, and the calculista approves one typical opening once, not 15 times.
- **ACC mechanics:** `clashes:assign` creates **one issue per assigned clash group**, with one pushpin, up to 1,000 clashes. A family issue is therefore **one assigned group holding all of the family's clashes** (≤ 1,000), with the pushpin on the worst instance. MC then tracks resolution per clash, so partial progress stays visible ("quedan 40 de 120"). It also costs 1 of the 250 assign jobs per hour, instead of 15.
- The description stays under ACC's 1,000-character limit by listing locations **grouped by level** (`P1 entretecho (vigas nivel 201): 6 vigas · P2: 5 · P3: 4`). The full location table goes in a follow-up comment (Issues v1 allows comments) and in the web UI.

Use **per instance** (`issueMode: 'per_instance'`, one issue per instance, all titled with the family code `[F-xxxx]` and linked) when:
- different site crews or contract packages execute the instances (for example a basement network vs the floors);
- the family exceeds 1,000 clashes or spans more than one responsible party (it must not: split it);
- or the coordinator asks for it ("Emitir por ubicación").

**Known ACC gap (verify before implementing):** the public API has no documented way to **add clashes to an existing assigned group**. New instances in later cycles therefore can't join the family issue in MC. Proposal: comment on the family issue ("Ciclo n: 2 nuevas ubicaciones coinciden con la familia F-xxxx: …"). After the coordinator confirms, assign the new clashes as a **linked follow-up issue** titled `[F-xxxx · ciclo n]`. Never create the follow-up automatically.

---

## 5. UI and server contract

### 5.1 Tree in the left list
```
▾ CAL × EST                                   3 familias · 19 ubic. · 168 interf.      ← level 1 (pair)
  ▾ Instalación invade franja de viga                                                  ← level 2 (problem type, chip PT02)
    ▸ [Típico] Haz CAL Ø22–54 bajo vigas 12"x18" · bajar ≤100 mm                       ← level 3 (family row)
         15 ubic. · P1–P3 · 120 interf. · Real P2 · ● sin decidir        [Aprobar familia]
      ▾ (expanded) Entretecho P1 · viga id 208337 · 8 tuberías · nuevo                ← level 4 (instance = today's group row)
                   Entretecho P1 · viga id 208343 · 8 tuberías · nuevo
                   …
▾ Conjunto de modelos (higiene y duplicados)  10 familias …                            ← special level-1 bucket (PT12/PT13)
▾ No es problema                              3 familias …                             ← special level-1 bucket (PT14)
```
- **Level 1 = discipline pair** (`responsible × other`) for PT01–PT11 and PT00. PT12 and PT13 go to **"Conjunto de modelos"**, because a site-volume file clashing with 5 disciplines must not appear 5 times. PT14 goes to **"No es problema"**. A toggle "Agrupar por: Par · Tipo de problema · Nivel" re-roots the tree. The "Nivel" view is the execution view ("plano de pasadas P2").
- **Family row:** generated Spanish title (pattern below) plus badges: `{n} ubic.`, level range, unique count (not raw), proposed validity chip, worst band, state (`sin decidir` · `decidida` · `{k} excepciones` · `{m} heredadas pendientes`), `Típico` (≥ 3 instances on ≥ 2 levels), `Validez mixta`, `Orientación por confirmar`.
- **Family title pattern:** `{moverClass ES} {systemClass} {Ø range} {relation verb} {host ES} {host type} · {solution hint}`. Example: "Haz CAL Ø22–54 invade fondo de vigas 12"x18" · bajar ≤100 mm".
- **Instance row:** today's group row, location-first title (level, then grid or host id), count, delta badge, inheritance icon (`↳ heredada`, `⚑ excepción`, `◌ pendiente`).
- **Singleton families** (1 instance) are rendered flat, with no expander.
- **Keyboard:** J/K move through visible rows; → / Enter expands, ← collapses; `A` on a family row opens "Aprobar familia"; `E` on an instance marks an exception; `M` merges (multi-select of families).
- **Filters:** "solo familias ≥ 2 ubicaciones", "validez mixta", "pendientes de confirmación".

### 5.2 Family detail pane
1. **Decision form:** validity, action, responsible / consulted, solution option (dropdown from the PT catalogue), typical-detail name and note, issue mode.
2. **Evidence:** the size breakdown (Ø histogram), penetration range, 3 sampled instances (worst, median, random-seeded) with the existing element cards and viewer focus. **Approval requires that at least 1 instance was opened** (≥ 3 if the family has > 50 members); this is recorded in `spotChecked`.
3. **Locations table:** level (with the "entretecho de" label for beams), host element, clash count, state, exception reason.
4. **Issue preview:** family issue (title + description + location table), or N per-instance previews.
5. **Approve modal:** "Aplicar a 15 ubicaciones · 120 interferencias · 0 excepciones". Lists the instances whose validity would change (mixed guard).

### 5.3 Server contract changes (`/api/coord/triage/...`)
```ts
// groups[] — new fields
interface TriageGroup {
  // …existing…
  familyId: string;               // F-xxxxxxxxxx
  problemType: ProblemTypeCode;   // 'PT00'…'PT14'
  signature: string;              // human-readable signature (debug + tooltip)
  uniqueClashCount: number;       // after G0 by externalId pair (raw stays in clashIds)
  hostLevelLabel?: string;        // "Entretecho P1 (viga nivel 201)"
  inheritance: { state: 'none'|'inherited'|'inherited_pending'|'exception'|'detached';
                 decisionVersion?: number; exceptionReason?: string };
}

// new top-level collection
interface TriageFamily {
  id: string;                     // F-xxxxxxxxxx (aliases resolved server-side)
  signature: string;
  parts: { problemType; hostClass; hostType?; moverClass; systemClass; sizeBand; relation };
  title: string;                  // Spanish, generated
  bucket: 'pair'|'model_set'|'non_issue';
  pair?: [string, string];        // responsible × other
  groupIds: string[];             // instances
  instanceCount: number; uniqueClashCount: number; rawClashCount: number;
  levels: string[];
  validityMix: Partial<Record<Validity, number>>;
  proposed: { validity; action; responsibleDiscipline; secondaryDiscipline?; solutionOption?; band };
  decision?: FamilyDecision;      // §4.1
  exceptions: { groupId: string; fields: Partial<FamilyDecision>; reason: string; by: string; at: string }[];
  tags: ('tipico'|'validez_mixta'|'orientacion_por_confirmar'|'sin_sistema')[];
  issue?: { mode: 'family'|'per_instance'; draftId?: string; accIssueIds?: string[] };
}
// response: { …, groups, families: TriageFamily[], problemTypes: {code, nameEs, options[]}[] }
```
New write endpoints (they all create proposals or decisions, audit-logged, human-approved as today):
`POST /api/coord/families/:id/decision` · `POST /api/coord/families/:id/exceptions` · `POST /api/coord/families/:id/detach` (`{groupId}`) · `POST /api/coord/families/merge` (`{from, into}`) · `POST /api/coord/families/:id/confirm-inherited`.

### 5.4 Engine changes (for whoever implements `core/group/`)
- New **invariant 8: one group = one family.** After G4–G7, a group whose members carry more than one signature is split by signature (31 of 201 groups in v11). The split part's ID = `G-` + sha1(strategy | canonicalKey | familyId). The dominant part keeps the old ID, so existing issues and history stay attached.
- A new pure step **F1 "familias"** after grouping computes the signatures, the families and the family proposals (validity / action = majority of real members, else majority). It is deterministic and sorted by (instance count desc, unique count desc, familyId).
- G0 stays. Expose `uniqueClashCount` and keep raw ids for MC writes.

---

## 6. Risks

1. **Over-merge from missing data (highest).** Without orientation, clash point, bbox or a connector graph, the relation is inferred from rule ids and penetration depth. Connections and true crossings (PT09), risers and buried runs (PT07), and unknown slab orientation (PT04 `orient_desc`) can be merged wrongly. *Mitigation:* mandatory spot-check before approval, `validez mixta` and `orientación por confirmar` tags, detach/exception actions, and emitting orientation, slope and the clash point in the payload (needed anyway).
2. **Blast radius of one click.** One approval can now close or assign 500+ clashes, and inheritance carries it into later cycles. *Mitigation:* real clashes are never auto-closed or auto-assigned; inherited decisions stay `pendiente de confirmación`; the mixed-validity guard; versioned decisions with full audit; the > 50 member approval threshold applies per family.
3. **ACC issue mapping.** One family issue means one pushpin, 1,000 description characters and ≤ 1,000 clashes. New instances can't be appended to an existing assigned group (to verify against the API), so family issues fragment over cycles. *Mitigation:* the comment + linked follow-up flow (§4.4), the per-instance fallback, and validating `clashes:assign` behaviour on the pilot project before building.
4. **Signature stability.** Renamed types or systems, or a replaced model, change `familyId` and orphan decisions. *Mitigation:* lineage matching (≥ 70% member overlap), aliases from merges, and a "firma cambió" note.
5. **Level semantics.** The host level ("201") and the work location ("entretecho P1") differ. If the UI isn't explicit, the site will look on the wrong floor. *Mitigation:* `hostLevelLabel`.
6. **Model-set noise hides the value.** In v11, 59% of unique conflicts are already non-real, and another 166 "real" ones are model superposition (≈ 66% together): the two Sitio Vol files, MECHANICAL loaded twice, three superimposed structures. Families make this obvious (PT12/PT13 are 6 decisions), but the model set must be cleaned before the real families can be judged on a representative project.

---

## 7. Next steps (proposed)
1. The engine emits orientation, slope and the clash point, plus per-clash `ruleId` (today it is only on the group).
2. Implement F1 + invariant 8 behind a flag. Re-run on v11 and expect ≈ 245 instances / 33 families (this document is the regression baseline).
3. Add the new rules to `rules/` via `rules-curator`: FP-016, FP-017, DUP-007, and FP-006 by origin file. Re-measure: the families with real members should drop from 28 to about 17 (the 5 PT09 connection/enclosure families and the 5 PT12 superposition families leave the real set, and the PT14 same-model joins close).
4. UI: build the tree with the family row and the approve modal first. Merge, detach and lineage come second.
5. Verify on the pilot project whether MC can add clashes to an existing assigned group (§4.4).
