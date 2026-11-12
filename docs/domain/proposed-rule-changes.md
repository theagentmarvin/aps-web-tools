# Proposed rule and review-policy changes (engine review 2026-11)

Source: `docs/domain/engine-review-2026-11.md`. Author: BIM coordination specialist. Status: **proposal**. `rules/**` changes need a human merge, per the repository guard.

Every diff below was produced with `diff -u` against the current files and then verified:
- The rules patch applies through `Coordinator.candidateRulesDir()` (the same path as `propose_rule_change`), and the candidate rule set loads.
- `evaluate_ruleset` (eval_scenarios + fixtures) on the rules patch alone gives 24/25. The only regression is EV-05, which the eval patch E1 fixes. With E1 the result is **26/26, 0 unsafe closures, fixture diffAccuracy 1**.
- The review rates were measured with `scripts/review/simulate.ts`. The grouping rows were measured on a scratch copy of `core/` with patch C1 applied.
- Patch C1 type-checks (`tsc --strict`) on the changed files.

## Order of application (mandatory)

1. **Rules patch (R1–R5, M1) together with eval patch E1.** R2/R4 must land *before* the policy change: with the old TOL-008, any lower closure threshold would auto-close pipes through walls of unknown fire rating.
2. **Core patch C1**: review thresholds, the structural-opening trigger, grouping keys and titles, and the MA-013 label.
3. Run `npx tsx scripts/eval.ts`, `npm test` and `npx tsx scripts/review/simulate.ts <empty patch>`. Expect the numbers in the table below.

How to apply. The rules hunks use paths relative to `rules/`; everything else uses paths relative to the repository root.

```
patch -p1 -d rules < rules-2026-11.patch      # R1–R5, M1  (human merge; or paste into propose_rule_change)
patch -p1 < eval-2026-11.patch                # E1
patch -p1 < core-2026-11.patch                # C1
```

## Summary of changes

| Id | File | Change | Why (domain) | Effect on review (v42 fixture) |
|---|---|---|---|---|
| R0 | classification-rules.yaml | `version: 2` | The ruleset hash and version must change with the semantics. | – |
| R1 | classification-rules.yaml | TOL-001 rationale: "Sin penetración (separación de X mm)…" instead of "Contacto sin penetración" | A 40 mm gap is not contact. | None |
| R2 | classification-rules.yaml | TOL-008 requires `fireRating: { exists: true }` | An empty "Resistencia al fuego" means *unknown*, not *non-rated*. Under OGUC Título 4, unit-separation and corridor partitions are often F-60/F-120. Tolerating them is an unsafe closure. | Removes the 3 TOL-008 groups (6 truly real clashes); 0 unsafe |
| R3 | classification-rules.yaml | EST-002 `a` adds `not: { orientation: vertical }` | A vertical gravity stack through a slab is a missing opening (EST-009: medium, owner EST), not "a gravity system that cannot work". Horizontal or unknown orientation keeps EST-002 (critical). EV-01 has no orientation and is unchanged. | Critical groups 24 → 19; 22 clashes go to EST-009 |
| R4 | classification-rules.yaml | New **MA-013**: MEP ≤ 150 mm through a wall with unknown RF → `real`, `model_hygiene`, owner ARQ, `hygiene_issue`, low, 0.75 | One hygiene issue to ARQ ("informar RF de N muros") instead of N tolerated or N real issues. The clashes reclassify to TOL-008 or MA-006 once the parameter is filled in. | +1 hygiene group (auto_ok at 0.75; never a closure) |
| R5 | classification-rules.yaml | New **ANN-007** tag `pasada_estructural`: penetration > 0 and outside tolerance, structure vs MEP or sleeve/opening | Feeds the structural-opening trigger. TOL-003 (inside tolerance) and TOL-001 (no contact) are not tagged. | Enables the C1 trigger |
| M1 | discipline-matrix.yaml | `version: 2`; isFireRated "none" list adds `no, sin, sin rf, s/rf, no rf, f-0`; the type regex no longer reads "sin RF"/"no RF" as rated; header comment fixed to the real order (sizeMm before flags; resolution 8) | Common Chilean ways of writing "no fire rating" were either unrecognized or, worse, matched `\brf\b` as *rated*. | None directly |
| E1 | docs/domain/eval-scenarios.md | EV-05 gets `fireRating: Sin RF`; new EV-26 (unknown RF → MA-013) | EV-05 meant "non-rated" but carried no data saying so. EV-26 locks the unsafe case. | – |
| C1 | core/group/review.ts | `autoAccept` real 0.80→**0.75**, false_positive 0.92→**0.88**, tolerance 0.92→**0.85**; duplicate, floor, bulk and min-count unchanged; new `isStructuralOpening()` | Calibrated to the rule confidences in the YAML (see the review §2). Auto-accepting `real` only creates a proposal. Heuristic closures (FP-002, FP-007/009, TOL-004/005/007/008, AE-003, DUP-004/5/6) stay in review. | 51 → 34 with current rules |
| C1 | core/group/index.ts | Structural-opening trigger (hard-coded); runs and zones key on the **responsible** side; `runMin` 3; zone key = level × owner × crossed discipline and class × severity (not ruleId), and one item per level when the owner owns the fixed side; Spanish zone titles | Methodology "always human": the calculista approves every opening. Groups become meeting items (review §3). | Rules + policy + grouping: **25 / 67 (37%)** |
| C1 | core/group/labels.ts | `MA-013` Spanish name | Resolution 13 stopgap. | Title only |

Measured review load:

| | v42 | v41 |
|---|---|---|
| Today | 51/79 (64.6%) | 51/79 |
| R + M1 only | 44/78 (56%) | – |
| C1 policy only | 34/79 (43%) | – |
| R + M1 + C1 policy | 36/78 (46%) | – |
| **R + M1 + C1 complete** | **25/67 (37%)**: 13 critical, 6 structural openings, 2 life-safety closures, 4 low confidence | **24/68 (35%)** |

Expected on a real project, which has hubs, real system runs and a lower critical share: **20–25%**.

Safety invariants after all changes, checked by simulation and eval:
- 0 real clashes closed (fixture truth and EV-26);
- every critical group reviewed;
- every closure with `seguridad_personas` reviewed;
- every structural opening, whether a closure or a missing opening, reviewed.

## Patch R0–R5 + M1 (rules-2026-11.patch, paths relative to the rules directory)

```diff
--- a/classification-rules.yaml
+++ b/classification-rules.yaml
@@ -131,7 +131,7 @@
 #   {x.category} renders the Spanish label from categoryLabelsEs (fallback:
 #   canonical name). Other fields render their raw (non-normalized) value.
 # =============================================================================
-version: 1
+version: 2
 
 rules:
 
@@ -358,7 +358,7 @@
     when:
       clash: { distanceMm: { gte: 0 }, clearanceViolation: false }
     then: { validity: tolerated, nature: hard, rootCause: not_applicable, responsibleDiscipline: COORD, severity: none, confidence: 0.9, suggestedAction: mark_reviewed,
-            rationale: "Contacto sin penetración ({clash.distanceMm} mm) y sin holgura mínima exigida para {a.discipline}/{b.discipline}." }
+            rationale: "Sin penetración (separación de {clash.distanceMm} mm) y sin infringir la holgura mínima exigida para {a.discipline}/{b.discipline}." }
 
   - id: TOL-002
     name: clearance violation
@@ -412,7 +412,7 @@
     name: small MEP through non-rated partition
     when:
       a: { elementClass: { inSet: MEP_DIST }, sizeMm: { lte: 150 } }
-      b: { elementClass: arch_wall, isFireRated: false }
+      b: { elementClass: arch_wall, isFireRated: false, fireRating: { exists: true } }
     then: { validity: tolerated, nature: hard, rootCause: not_applicable, responsibleDiscipline: COORD, severity: none, confidence: 0.7, suggestedAction: mark_reviewed,
             rationale: "{a.category} de {a.sizeMm} mm atraviesa tabique no resistente al fuego '{b.type}': pasada estándar que se ejecuta en obra." }
 
@@ -490,9 +490,9 @@
             rationale: "{a.category} {a.systemName} ({a.sizeMm} mm) atraviesa el pilar '{b.type}'. Los pilares no admiten pasadas: {a.discipline} debe desviar el trazado." }
 
   - id: EST-002
-    name: gravity drainage vs structure
+    name: gravity drainage vs structure (not vertical stacks)
     when:
-      a: { elementClass: gravity_pipe }
+      a: { elementClass: gravity_pipe, not: { orientation: vertical } }
       b: { elementClass: { inSet: STRUCTURE } }
     then: { validity: real, nature: hard, rootCause: design_coordination, responsibleDiscipline: "$a", secondaryDiscipline: EST, severity: critical, confidence: 0.88, suggestedAction: create_issue,
             rationale: "Tubería gravitacional {a.systemType} Ø{a.sizeMm} mm interfiere {b.category} '{b.type}' ({clash.penetrationMm} mm). La pendiente limita el desvío: resolver con pasada aprobada por calculista o rediseño del trazado." }
@@ -680,6 +680,14 @@
     then: { validity: real, nature: hard, rootCause: missing_opening, responsibleDiscipline: "$a", secondaryDiscipline: ARQ, severity: low, confidence: 0.7, suggestedAction: create_issue,
             rationale: "{a.category} de {a.sizeMm} mm atraviesa tabique '{b.type}': requiere vano con refuerzo de perfilería. ARQ debe incorporarlo." }
 
+  - id: MA-013
+    name: small MEP through wall with unknown fire rating
+    when:
+      a: { elementClass: { inSet: MEP_DIST }, sizeMm: { lte: 150 } }
+      b: { elementClass: arch_wall, isFireRated: false, fireRating: { exists: false } }
+    then: { validity: real, nature: hard, rootCause: model_hygiene, responsibleDiscipline: "$b", secondaryDiscipline: "$a", severity: low, confidence: 0.75, suggestedAction: hygiene_issue,
+            rationale: "{a.category} de {a.sizeMm} mm atraviesa el muro '{b.type}', que no tiene resistencia al fuego informada. ARQ debe informar la RF: si el muro sectoriza (OGUC Título 4) la pasada requiere sello cortafuego certificado; si no, es pasada estándar de obra." }
+
   - id: MA-008
     name: MEP equipment/terminal vs wall
     when:
@@ -832,3 +840,6 @@
   - id: ANN-006
     when: { a: { elementClass: { inSet: STRUCTURE } }, b: { elementClass: { inSet: MEP_ANY } } }
     then: { tags: [requiere_calculista], note: "Toda pasada en estructura requiere aprobación del ingeniero calculista." }
+  - id: ANN-007
+    when: { clash: { penetrationMm: { gt: 0 }, withinTolerance: false }, a: { elementClass: { inSet: STRUCTURE } }, b: { anyOf: [ { elementClass: { inSet: MEP_ANY } }, { isSleeveOrOpening: true } ] } }
+    then: { tags: [pasada_estructural], note: "Pasada o embebido en estructura: cerrarla o aceptarla equivale a aprobar una pasada, lo que solo puede hacer el calculista." }
--- a/discipline-matrix.yaml
+++ b/discipline-matrix.yaml
@@ -16,11 +16,11 @@
 # 3. Ordered lists are FIRST-MATCH-WINS unless stated otherwise.
 # 4. Engine computation order per element:
 #      normalize category (categoryAliases) -> modelDiscipline (fileName)
-#      -> discipline (systemRefinement / category fallback) -> derivedFlags
-#      (in listed order; later flags may reference earlier ones) ->
-#      sizeMm -> elementClass (+ moveRank).
+#      -> discipline (systemRefinement / category fallback) -> sizeMm ->
+#      derivedFlags (in listed order; later flags may reference earlier ones
+#      and sizeMm) -> elementClass (+ moveRank).
 # =============================================================================
-version: 1
+version: 2
 
 # -----------------------------------------------------------------------------
 # Disciplines. `code` is canonical (Chilean practice). `group` drives pair
@@ -352,8 +352,8 @@
     # Chilean resistance classes F-15..F-180 (NCh 935 / OGUC), EI, RF.
     when:
       anyOf:
-        - { fireRating: { exists: true, notMatches: '^(none|ninguno|ninguna|0|-|n/?a)$' } }
-        - { type: { matches: '\bf-? ?(15|30|60|90|120|150|180)\b|\bei ?(30|60|90|120|180)\b|\brf\b|cortafuego|resistente al fuego|fire ?rated' } }
+        - { fireRating: { exists: true, notMatches: '^(none|no|ninguno|ninguna|sin|sin rf|s/ ?rf|no rf|f-?0|0|-|n/?a)$' } }
+        - { type: { matches: '\bf-? ?(15|30|60|90|120|150|180)\b|\bei ?(30|60|90|120|180)\b|(?<!sin |no |s/)\brf\b|cortafuego|resistente al fuego|fire ?rated' } }
         - { family: { matches: 'cortafuego|fire ?rated' } }
   - flag: isPlaceholder
     when:
```

## Patch E1 (eval-2026-11.patch)

```diff
--- a/docs/domain/eval-scenarios.md
+++ b/docs/domain/eval-scenarios.md
@@ -59,9 +59,9 @@
     title: Agua potable Ø25 por tabique no RF
     dist: -0.025
     left:  { documentId: 3, modelFile: lin-san, documentName: P2401-SAN-TorreA.rvt, externalId: s-020, category: Revit Tuberías, family: Tubería PPR, type: PPR PN20, systemClassification: Domestic Cold Water, systemType: APF, systemName: APF 2, level: Piso 2, diameterMm: 25 }
-    right: { documentId: 2, modelFile: lin-arq, documentName: P2401_ARQ_TorreA.rvt, externalId: a-410, category: Revit Muros, family: Muro básico, type: Tabique volcometal 95, level: Piso 2, widthMm: 95 }
+    right: { documentId: 2, modelFile: lin-arq, documentName: P2401_ARQ_TorreA.rvt, externalId: a-410, category: Revit Muros, family: Muro básico, type: Tabique volcometal 95, level: Piso 2, widthMm: 95, fireRating: Sin RF }
     expected: { ruleId: TOL-008, validity: tolerated, responsibleDiscipline: COORD, severity: none, band: NONE }
-    notes: Pasada estándar en tabique; se ejecuta en obra.
+    notes: Pasada estándar en tabique sin RF declarada; se ejecuta en obra. Sin el parámetro RF el caso es EV-26.
 
   - id: EV-06
     title: Conduit Ø20 embutido en losa de 150 mm
@@ -222,6 +222,14 @@
     right: { documentId: 6, modelFile: lin-ele, documentName: P2401-ELE.rvt, externalId: l-1500, category: Revit Bandejas de cables, family: Escalerilla portaconductores, type: Escalerilla 300x100, level: Cubierta, widthMm: 300, heightMm: 100 }
     expected: { ruleId: CLR-002, validity: real, nature: clearance, rootCause: design_coordination, responsibleDiscipline: ELE, secondaryDiscipline: CLI, severity: medium, band: P3 }
     notes: La zona de mantención es un modelo genérico, pero se reconoce por su nombre antes de la regla NI-001.
+
+  - id: EV-26
+    title: Agua potable Ø32 por muro sin RF informada
+    dist: -0.140
+    left:  { documentId: 3, modelFile: lin-san, documentName: P2401-SAN-TorreA.rvt, externalId: s-026, category: Revit Tuberías, family: Tubería PPR, type: PPR PN20, systemClassification: Domestic Cold Water, systemType: APF, systemName: APF 4, level: Piso 5, diameterMm: 32 }
+    right: { documentId: 2, modelFile: lin-arq, documentName: P2401_ARQ_TorreA.rvt, externalId: a-426, category: Revit Muros, family: Muro básico, type: Albañilería e=140, level: Piso 5, widthMm: 140 }
+    expected: { ruleId: MA-013, validity: real, nature: hard, rootCause: model_hygiene, responsibleDiscipline: ARQ, secondaryDiscipline: AP, severity: low }
+    notes: Sin RF informada no se puede cerrar como tabique común; ARQ completa el parámetro y el caso se reclasifica en el ciclo siguiente.
 ```
 
 ## Coverage
```

## Patch C1 (core-2026-11.patch)

```diff
--- a/core/group/review.ts
+++ b/core/group/review.ts
@@ -18,8 +18,18 @@
   bulkClosureMax: number;
 }
 
+/**
+ * Calibration (engine review 2026-11, docs/domain/engine-review-2026-11.md §4):
+ * - real 0.75: auto-accepting "real" never closes anything; it only queues an
+ *   issue draft that a human approves. MM-010 (0.75) is reliable on validity.
+ * - false_positive 0.88 / tolerance 0.85: deterministic geometry/practice rules
+ *   (FP-003/006/010/013/014, TOL-001/003) clear; heuristics (FP-002, FP-007/009,
+ *   TOL-004/005/007/008, AE-003, DUP-004/5/6) stay in review.
+ * - Safety triggers that no threshold can bypass: critical severity, closing
+ *   with seguridad_personas, structural openings (isStructuralOpening).
+ */
 export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
-  autoAccept: { real: 0.8, false_positive: 0.92, duplicate: 0.9, tolerance: 0.92 },
+  autoAccept: { real: 0.75, false_positive: 0.88, duplicate: 0.9, tolerance: 0.85 },
   reviewFloor: 0.55,
   alwaysReview: { severity: ["critical"], minClashCount: 150, unmatched: true, rulesConflict: true },
   bulkClosureMax: 50,
@@ -41,3 +51,13 @@
   if (t !== undefined && confidence >= t) return "alta";
   return confidence >= policy.reviewFloor ? "media" : "baja";
 }
+
+/**
+ * Structural opening or embedment (tag `pasada_estructural`, ANN-007): closing it or
+ * asking for the opening means accepting a penetration in structure, which only the
+ * calculista can approve (methodology "always human"). Not configurable.
+ */
+export function isStructuralOpening(validity: Validity, rootCause: string, tags: ReadonlySet<string>): boolean {
+  const closable = validity === "false_positive" || validity === "tolerated";
+  return tags.has("pasada_estructural") && (closable || rootCause === "missing_opening");
+}
--- a/core/group/index.ts
+++ b/core/group/index.ts
@@ -26,7 +26,7 @@
 import { sha1 } from "../util/sha1";
 import { byFrequency, capitalize, cmpStr, dominant, norm, sanitize, sortedPair } from "../util/text";
 import { classLabel, ruleNameEs } from "./labels";
-import { autoAcceptThreshold, confidenceBand, DEFAULT_REVIEW_POLICY, type ConfidenceBand, type ReviewPolicy } from "./review";
+import { autoAcceptThreshold, confidenceBand, DEFAULT_REVIEW_POLICY, isStructuralOpening, type ConfidenceBand, type ReviewPolicy } from "./review";
 
 export * from "./review";
 export * from "./labels";
@@ -100,6 +100,8 @@
   hubMin?: number;
   /** Max clashes per group for G3–G6 (default 60). */
   maxGroupSize?: number;
+  /** G5: minimum clashes for a system run (default 3); smaller runs fall to zones. */
+  runMin?: number;
   /** G3: merge needs-info requests by family when more than this many elements share it (default 5). */
   needsInfoFamilyMerge?: number;
   /** Grid bay of a clash (e.g. "C-D/4-5"); enables coordinate-based zones. */
@@ -173,11 +175,24 @@
   return undefined;
 }
 
+/**
+ * [own, other]: the side owned by the responsible discipline (else the mover)
+ * and the other side. Runs, zones and their titles follow who must act, not
+ * whoMoves (MA-006 binds the pipe while whoMoves picks the wall; EST-009 makes
+ * EST responsible while the pipe is the mover).
+ */
+function ownSides(c: ClassifiedClash): [ElementFacts, ElementFacts] {
+  const own = responsibleSide(c);
+  if (!own) return moverSideOf(c);
+  return [own, own === c.left ? c.right : c.left];
+}
+
 /** Run G1–G7 over classified clashes. Pure and deterministic. */
 export function groupClashes(rs: CompiledRuleSet, clashes: readonly ClassifiedClash[], options: GroupingOptions = {}): ClashGroup[] {
   const hubMin = options.hubMin ?? 3;
   const max = options.maxGroupSize ?? 60;
   const famMerge = options.needsInfoFamilyMerge ?? 5;
+  const runMin = options.runMin ?? 3;
   const policy = options.reviewPolicy ?? DEFAULT_REVIEW_POLICY;
 
   const all = [...clashes].sort((x, y) => cmpStr(x.key, y.key));
@@ -291,22 +306,28 @@
 
   // G5 — system runs.
   {
-    const runs = bucket(realFree(), (c) => {
-      const [mv, other] = moverSideOf(c);
-      const sys = mv.systemName ?? mv.systemType ?? mv.family ?? "";
-      return ["run", c.classification.responsibleDiscipline, norm(String(sys)), mv.level ?? "", other.elementClass, c.classification.ruleId].join("|");
+    // A run is something the responsible discipline moves; when it owns the fixed side
+    // (EST models openings in its slabs) the level zone below is the meeting item.
+    const runs = bucket(realFree().filter((c) => ownSides(c)[0] !== fixedOf(c)), (c) => {
+      const [own, other] = ownSides(c);
+      const sys = own.systemName ?? own.systemType ?? own.family ?? "";
+      return ["run", c.classification.responsibleDiscipline, norm(String(sys)), own.level ?? "", other.elementClass, c.classification.ruleId].join("|");
     });
-    for (const [k, ms] of sortedBuckets(runs)) if (ms.length >= 2) for (const d of capSplit("run", k, ms, max)) take(d);
+    for (const [k, ms] of sortedBuckets(runs)) if (ms.length >= runMin) for (const d of capSplit("run", k, ms, max)) take(d);
   }
 
   // G6 — zones (grid bay when available, else level + rule).
   {
     const zones = bucket(realFree(), (c) => {
-      const [, other] = moverSideOf(c);
+      const [own, other] = ownSides(c);
       const bay = options.bayOf?.(c);
+      // One agenda line: level (+ bay) × responsible × what it crosses × severity. When the
+      // responsible owns the fixed side (EST models the openings, EST-009), all crossing
+      // disciplines of the level go together: one "plano de pasadas" item per level.
+      const crossed = own === fixedOf(c) ? `fixed:${own.elementClass}` : `${other.discipline}|${other.elementClass}`;
       return bay
-        ? ["zone", lvl(c), bay, c.classification.responsibleDiscipline, other.discipline].join("|")
-        : ["zone", lvl(c), c.classification.responsibleDiscipline, other.discipline, c.classification.ruleId].join("|");
+        ? ["zone", lvl(c), bay, c.classification.responsibleDiscipline, crossed, c.classification.severity].join("|")
+        : ["zone", lvl(c), c.classification.responsibleDiscipline, crossed, c.classification.severity].join("|");
     });
     for (const [k, ms] of sortedBuckets(zones)) if (ms.length >= 2) for (const d of capSplit("zone", k, ms, max)) take(d);
   }
@@ -422,6 +443,7 @@
   const closable = first.validity === "false_positive" || first.validity === "tolerated";
   if (closable && ms.length > policy.bulkClosureMax) reasons.push(`cierre masivo de ${ms.length} interferencias (> ${policy.bulkClosureMax})`);
   if (closable && tags.has("seguridad_personas")) reasons.push("cierre de grupo con seguridad_personas");
+  if (isStructuralOpening(first.validity, rootCause, tags)) reasons.push("pasada en estructura (requiere calculista)");
   for (const r of new Set(cls.flatMap((c) => c.humanReviewReasons))) {
     if (r === "low_confidence" && reasons.some((x) => x.startsWith("confianza "))) continue;
     const es = HUMAN_REASON_ES[r] ?? r;
@@ -554,13 +576,16 @@
       );
     }
     case "run": {
-      const [mv, other] = moverSideOf(first);
-      return `${g.responsibleDiscipline} ${sanitize(mv.systemName ?? mv.systemType ?? mv.family, 30)} vs ${classLabel(other.elementClass).many} — ${level} (${n})`.replace(/\s+/g, " ");
+      const [own, other] = ownSides(first);
+      return `${g.responsibleDiscipline} ${sanitize(own.systemName ?? own.systemType ?? own.family, 30)} vs ${classLabel(other.elementClass).many} — ${level} (${n})`.replace(/\s+/g, " ");
     }
     case "zone": {
-      const [, other] = moverSideOf(first);
+      const sides = ms.map(ownSides);
+      const ownC = commonClass(sides.map((s) => s[0]));
+      const otherC = commonClass(sides.map((s) => s[1]));
+      const otherD = [...new Set(sides.map((s) => s[1].discipline))].sort(cmpStr).join("/");
       const bay = options.bayOf?.(first);
-      return `${capitalize(level)}${bay ? ` eje ${bay}` : ""}: ${n} ${g.responsibleDiscipline} vs ${other.discipline}`;
+      return `${capitalize(level)}${bay ? ` eje ${bay}` : ""}: ${n} interferencias ${g.responsibleDiscipline} — ${ownC ? classLabel(ownC).many : "elementos"} vs ${otherC ? classLabel(otherC).many : "elementos"} de ${otherD}`;
     }
     case "single": {
       const a = sideA(first);
--- a/core/group/labels.ts
+++ b/core/group/labels.ts
@@ -73,6 +73,7 @@
   "MA-006": "Instalación por muro resistente al fuego",
   "MA-007": "Instalación grande por tabique",
   "MA-008": "Equipo o terminal contra muro",
+  "MA-013": "Pasada por muro sin resistencia al fuego informada",
   "MA-009": "Instalación por cubierta",
   "MA-010": "Instalación contra piso no estructural",
   "MA-011": "Instalación contra mobiliario",
```

## Mental re-run of `npx tsx scripts/eval.ts` (25 scenarios)

`scripts/eval.ts` asserts classification fields only (ruleId, validity, nature, rootCause, responsible, secondary, severity, band). It never reads `reviewState`, so **C1 cannot change any scenario**: thresholds, triggers, grouping and titles are all downstream of classification.

| Scenario | Touched by | Outcome |
|---|---|---|
| **EV-05** (Ø25 through "Tabique volcometal 95", no RF field) | R2 + R4 | **Changes** without E1: TOL-008 → MA-013 (real, ARQ). With E1 (`fireRating: Sin RF`) it stays TOL-008. Verified. |
| EV-01 (ALC Ø110 vs beam, no orientation) | R3 | Unchanged: `not: { orientation: vertical }` holds when orientation is missing. Verified. |
| EV-17 (APC riser through slab) | R3 | Unchanged: not a gravity pipe, so EST-009 as before. |
| EV-24 (INC riser vs post-tensioned slab) | R3 | Unchanged: not gravity, so EST-003. A gravity riser against a PT slab now also reaches EST-003 instead of EST-002; both are critical. |
| EV-22 (CLI through "Tabique F-120 doble placa") | M1 | Unchanged: "F-120" still matches, MA-006. |
| EV-06, EV-07, EV-15, EV-18 (structure vs conduit, sleeve, duct) | R5 | Unchanged fields. EV-06 and EV-15 gain the tag `pasada_estructural` (tags are not asserted). EV-18 is inside tolerance, so no tag. |
| EV-02, 03, 04, 08–14, 16, 19–21, 23, 25 | – | Unchanged. |
| EV-26 (new) | R4 | Passes with the candidate. **Fails with the current rules as an unsafe closure** (TOL-008 tolerated), which is the bug this change fixes. |

Measured result: current rules + E1 → 24/26, 1 unsafe; candidate rules + E1 → **26/26, 0 unsafe**.

Tests outside the eval: `tests/engine/grouping.test.ts` asserts hub, hygiene, non-issue and single titles only. No run or zone title is asserted, so C1 is expected to pass. Run `npm test` to confirm, because group ids of runs and zones change with the new keys (decisions carried by group id from an earlier cycle will not match once; the pairKey/clash-level carry-over is unaffected).

## Not mechanical: follow-up changes, specified for the coder

1. **Reappeared detection (P0).** Keep `.coordinator/state/clash-ledger/<modelSetId>.json` with `{clashId → [versions]}` and pairKeys, appended on every ingest. `historyBefore()` reads the ledger instead of cached raw tests. Acceptance: fixture v41 → v42 gives 13 reappeared and `regresion` tags on them.
2. **Compact issue description (P0).** Use plain text, no markdown, a hard cap of 950 characters, and the trim order and section budgets in the review §5. Build drafts for `strategy = hygiene` groups too.
3. **Sleeve correlation (P1).** Clash fact `coveredBySleeve`, computed in `core/pipeline.ts` after enrichment: true when another clash of the test pairs `isSleeveOrOpening` with the same host `externalId` and the sleeve's bbox contains the MEP crossing point in plan. Then add the rule, after FP-010:
   ```yaml
     - id: FP-016
       name: MEP through a modeled sleeve
       when:
         clash: { coveredBySleeve: true }
         a: { elementClass: { inSet: MEP_DIST } }
         b: { elementClass: { inSet: STRUCTURE } }
       then: { validity: false_positive, nature: hard, rootCause: not_applicable, responsibleDiscipline: COORD, secondaryDiscipline: EST, severity: none, confidence: 0.9, suggestedAction: close_not_issue,
               rationale: "{a.category} pasa por la camisa/pasada modelada en {b.category} '{b.type}'. Confirmar que la pasada figura en el plano de pasadas aprobado por el calculista." }
   ```
   Add `coveredBySleeve` to `CLASH_FIELDS`. The rule does not load before then, which is why it is not in the mechanical patch. Expected: 14 false `real` clashes → non-issue. The group stays in review through `pasada_estructural`.
4. **Level normalization (P1).** Map levels by elevation, or with a `levels:` map in the project config (`Level 1` ≡ `Nivel 1`), before grouping and titles.
5. **`nameEs` per rule (resolution 13).** Add an optional rule field in `core/rules/schemas.ts` and the loader. `ruleNameEs()` prefers it; the loader warns when it is missing.
6. **whoMoves tie-break (resolution 6).** Compare cross-section area, then class rank, before width. Render "coordinación define quién desvía" when there is no mover.
7. **Binding for rules without a/b (resolution 12).** Bind a = the mover side, else the side whose discipline sorts first.
8. **MA-007 owner (issue guide "one issue = one owner").** The rationale and action ask ARQ to open and reinforce the partition, so the owner should be `$b` (ARQ) with `$a` as secondary, as in EST-009. It is held back from the mechanical patch because it changes ownership on live projects. Decide in the next rules review.
9. **UX spec.** Replace `CLIMA`/`PCI` and `R-EST-CLIMA-004` with `CLI`/`INC` and real rule ids.
