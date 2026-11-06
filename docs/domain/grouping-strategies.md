# Grouping strategies

Goal: collapse thousands of clashes into **actionable groups**. A group is one decision, owned by one discipline, and (if real) written up as one issue.

A typical 20-storey residential tower in construction documents produces 8,000–25,000 raw MC clashes. After this pipeline expect roughly:
- 85–95% removed as duplicate, false positive or tolerated;
- 150–600 groups;
- of those, 30–100 needing a real decision per cycle.

Implementation target: `core/group/`. Pure, deterministic functions. **Same input gives the same groups, the same group IDs and the same order.**

---

## 0. Invariants (every strategy must respect them)

1. **One group = one `validity`.** Never mix real with non-issues.
2. **One group = one `responsibleDiscipline`.**
3. Group severity = the maximum member severity. Group priority is computed per `priority-scoring.yaml` (worst member plus `groupCount`).
4. **Max group size: 60 clashes.** Larger groups are split by level, then by `modelFile` pair, then by chunks ordered by clash key.
5. Each clash belongs to **exactly one** group. Strategies run in order and only consume unassigned clashes.
6. Group ID = `G-` + first 10 hex chars of `sha1(strategy + "|" + canonicalKey)`. Because the ID is key-based, the same group keeps its ID across cycles even when membership changes. The UI and issues rely on that.
7. Deterministic tie-breaking everywhere: sort by key fields as normalized strings, then by clash identity key `sortedPair(externalIdL, externalIdR)`.

## Pipeline

```
raw clashes
  └─ G0 dedupe ──► unique clashes ──► classify (rules) ──► score
        └─ G1 non-issue batches   (false_positive / tolerated)
        └─ G2 hygiene batches     (suggestedAction = hygiene_issue)
        └─ G3 needs-info batches  (validity = needs_info)
        └─ G4 hub elements        (real)
        └─ G5 system runs         (real)
        └─ G6 zones               (real)
        └─ G7 singletons          (real)
```

### G0. Deduplicate (before classification)

Several clash tests or views, and several viewables, can report the same physical conflict.

```
key(c) = sortedPair(L.externalId ?? `${L.modelFile}:${L.dbId}`,
                    R.externalId ?? `${R.modelFile}:${R.dbId}`)
for each key:
  keep the clash with the most negative dist (worst penetration)
  record all source clash ids (mcClashIds[]) and test ids for traceability
```

Clashes where both sides have the same `externalId` are **not** merged away. They are evidence for DUP-001 and DUP-002 and go on to classification.

### G1. Non-issue batches

Group all `false_positive` and `tolerated` clashes by:

```
canonicalKey = ruleId | validity | sortedPair(L.discipline, R.discipline)
               | sortedPair(L.modelFile, R.modelFile)
```

Output: one bulk proposal per group ("Cerrar 412 interferencias: aislación contra su propia tubería — CLI"), plus 3 to 5 sample members for spot-checking (Step 6 of the methodology). Sample = the members with the largest penetration plus one random member with a fixed seed derived from the group ID, so the sample is deterministic.

The 60-clash cap does **not** apply to G1. A bulk closure is one decision however large. But the mandatory human approval for more than 50 members applies.

### G2. Hygiene batches

```
canonicalKey = ruleId | responsibleDiscipline | responsible side modelFile
```

One hygiene issue per file and rule. Example: "ARQ remodela muros estructurales en P2401_ARQ_TorreA.rvt (184 elementos)". The 60-clash cap does not apply. The issue lists element counts per level.

### G3. Needs-info batches

```
canonicalKey = ruleId | responsibleDiscipline | the needs_info element (externalId)
```

One request per unknown element, whatever it clashes with. Then merge requests by `ruleId | responsibleDiscipline | family` when more than 5 elements share the family. Example: "¿Qué representa la familia 'Caja metálica' (23 instancias, CLI)?"

### G4. Hub elements (element-centric, the most valuable strategy)

One element against many is the most common real pattern: a duct at the wrong offset crossing 14 beams, a beam cutting 9 pipes. Fix the element and every clash goes.

```
input: real clashes, unassigned
build an undirected multigraph: node = element (externalId), edge = clash

for each element e compute:
  degMover(e) = # clashes where e is the mover (per whoMoves)
  degFixed(e) = # clashes where e is NOT the mover, grouped by the
                counterpart's responsibleDiscipline

repeat:
  candidates = elements with degMover(e) >= HUB_MIN (3)
  if none: break
  pick e* = argmax by (degMover desc, sizeMm desc, externalId asc)
  group = all unassigned clashes where e* is the mover
  canonicalKey = "hub-mover" | e*.externalId
  assign; recompute degrees

then a second pass for fixed hubs:
  for each element f with, for one responsible discipline d,
      count(unassigned clashes with f as non-mover and responsible = d) >= HUB_MIN:
    group them; canonicalKey = "hub-fixed" | f.externalId | d
    (example: "Viga V-12 (eje C/4-5, Piso 3): 9 tuberías de AP la atraviesan")
```

Why mover first: a mover hub has one obvious action ("bajar el ducto INY-UMA-2 150 mm") and one owner. Fixed hubs are second because the actions differ per crossing element.

Signal worth surfacing: if a mover hub has more than 10 members, or `penetracion_mayor` (> 300 mm) on most members, add the tag `posible_error_de_cota`. That pattern almost always means a wrong reference level or offset, not a design conflict.

### G5. System runs

What remains is mostly individual segments of the same run (pipe, fitting, pipe, fitting) clashing with the same kind of thing.

```
input: real clashes, unassigned
moverSide = mover ?? (side with lower moveRank) ?? left
canonicalKey = "run" | responsibleDiscipline
             | moverSide.systemName ?? moverSide.systemType ?? moverSide.family
             | moverSide.level
             | counterpart.elementClass
             | ruleId
group if size >= 2
```

If MEP connectivity is available (connector graph), replace `systemName + level` with connected-component ID within the system. This is more precise, but optional in v1.

### G6. Zones

```
input: real clashes, unassigned
needs: clash point (x, y, z) + grids
bay = (nearest grid line ≤ x, next grid line) × (nearest grid line ≤ y, next)
      named like "C-D / 4-5"
canonicalKey = "zone" | level | bay | responsibleDiscipline | counterpart.discipline
fallback without coordinates:
canonicalKey = "zone" | level | responsibleDiscipline | counterpart.discipline | ruleId
group if size >= 2
```

Zones are what the meeting reads ("Piso 3, eje C-D/4-5: 7 interferencias CLI contra EST"). They are also what site teams install by.

### G7. Singletons

Everything left: one clash per group, `canonicalKey = "single" | clashKey`.

## Group record

```ts
interface ClashGroup {
  id: string;                 // G-xxxxxxxxxx (stable)
  strategy: 'nonissue'|'hygiene'|'needsinfo'|'hub-mover'|'hub-fixed'|'run'|'zone'|'single';
  canonicalKey: string;
  title: string;              // Spanish, generated (see below)
  validity; nature; rootCause; responsibleDiscipline; secondaryDiscipline?;
  severity;                   // max of members
  priorityScore; band;        // per priority-scoring.yaml (group mode)
  ruleIds: string[];          // distinct, sorted by count desc
  memberKeys: string[];       // clash identity keys
  mcClashIds: number[];       // for status updates in MC
  levels: string[];           // distinct, sorted
  hubElement?: { externalId; category; family; type; systemName; level };
  sample: string[];           // for G1 spot-check
  tags: string[];
  humanReview: boolean;       // OR of members
  stats: { count; maxPenetrationMm; disciplines: string[] };
}
```

Generated title patterns (Spanish):

| Strategy | Pattern | Example |
|---|---|---|
| nonissue | `{N} × {rule name ES} ({disciplinas})` | "412 × Aislación contra su propia tubería (CLI)" |
| hygiene | `Higiene: {rule name ES} en {archivo}` | "Higiene: ARQ remodela muros estructurales en P2401_ARQ_TorreA.rvt" |
| hub-mover | `{categoría} {sistema} {tamaño} vs {N} {clase contraparte} — {nivel}` | "Ducto INY-UMA-2 600x400 vs 14 vigas — Piso 4" |
| hub-fixed | `{categoría} {tipo} atravesada por {N} {clase} de {disc}` | "Viga V 30x70 atravesada por 9 tuberías de AP — Piso 3" |
| run | `{disc} {sistema} vs {clase contraparte} — {nivel} ({N})` | "ALC ALC 4 vs losas — Subterráneo -1 (6)" |
| zone | `{nivel} eje {bay}: {N} {disc} vs {disc}` | "Piso 3 eje C-D/4-5: 7 CLI vs EST" |
| single | `{cat A} vs {cat B} — {nivel}` | "Tubería vs pilar — Piso 7" |

## Worked example

Input: 1,240 clashes from view "EST + MEP", tower Piso 1–10, after G0 dedupe (1,402 raw).

| Step | Result |
|---|---|
| G1 | 610 FP/TOL → 9 bulk groups: TOL-005 embedded conduit (288, ELE×EST); FP-003 connected components (141); TOL-003 within tolerance (96); FP-010 sleeves (55); … |
| G2 | 0 |
| G3 | 31 needs-info → 4 requests (generic "Caja metálica" × 23, CLI; …) |
| G4 | 599 real. Mover hubs: duct INY-UMA-2 crossing 14 beams on Piso 4 (EST-004, tagged `posible_error_de_cota`: 13 of 14 penetrate > 300 mm); 11 more hubs with 3–9 members → 82 clashes in 12 groups. Fixed hubs: beam V-12 crossed by 9 AP pipes → 41 clashes in 6 groups. |
| G5 | 476 left → 58 run groups (e.g. "ALC ALC 4 vs losas — Subterráneo -1 (6)") covering 401. |
| G6 | 75 left → 11 zone groups covering 52. |
| G7 | 23 singletons. |

Total: 9 + 4 + 18 + 58 + 11 + 23 = **123 groups**, of which **110 real** for review. The P1 queue for the meeting typically holds 8–15 of them.

## Anti-patterns

- Grouping only by level or test name. That gives big buckets nobody can act on.
- Groups that need two disciplines to act. Split them, and link them through `secondaryDiscipline`.
- Re-grouping from scratch each cycle with new IDs. Issues lose their history.
- Hiding `critical` members inside a large low-priority group. Group severity is the max, so this can't happen if invariant 3 holds. Test it.
