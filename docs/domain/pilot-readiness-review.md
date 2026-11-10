# Pilot readiness review — weekly cycle end to end (M1–M4)

Reviewer: BIM coordination specialist (senior coordinator, SalfaCorp). Date: 2026-11-10.
Scope: a full fixtures cycle in a temporary home (`ingest 41` → `classify --propose` → 3 family decisions + 6 group decisions → v41 Incidencias → `ingest 42` → Qué cambió / Incidencias / Reunión / reminders / a test batch, never applied), on a separate server (:3017) checked in headless Chrome. On the real project (T-3bde5861, v11): GET only of triage, issue-checks, agenda, reminders and families. No code was changed and the user's store was not touched.

## Verdict: **ready for a pilot after fixes**

The daily work is sound: the six verdicts are right, the reminders contain no names, and the hard safety rails hold. Four fixes are needed before the first real cycle (issues 1–4 below):
- a family decision silently carries a closure onto new or reappeared clashes, including one with a `seguridad_personas` review reason;
- inheritance from ACC never fires on real data;
- the agenda cap hides the stuck issue;
- the approver's name is written into ACC.

Issue 5 (wrong counts in titles) should go in the same release, because it costs trust in the meeting.

## What works (checked, not assumed)

- **No `real` is closed.** A family close or `mark_reviewed` with validity `real` is refused (`400 "Una familia 'real' no se cierra"`). Clashes already closed in ACC are not in the test batch (the 3 MINIMAL_OVERLAP ids were excluded).
- **F2 verdicts:** 6 of 6 match the known outcomes: #101 avance 4/5, #102 dice_resuelta, #103 resuelta, #104 displaced, #105 stale INC model, #106 stuck for 2 cycles, P1, overdue. Contradictions sort first, and the evidence is a short template I could paste into an email.
- **Decision memory is conservative where it matters:**
  - postponements are not inherited;
  - a human "accept" is dropped when the group gains clashes;
  - a family member whose clashes changed becomes `inherited_pending`;
  - ACC-assigned groups are inherited as `assigned` (fixtures).
- **Reminders:** one per discipline, contradictions → overdue → avance, issue numbers, no names. ELE gets #102 "marcadas resueltas, pero el modelo aún muestra la interferencia". I would send that sentence as is.
- **Agenda:** deterministic, grouped by responsible discipline, and P1 sorts before P2 and P3. The print view and the "Nota de reunión" panel were usable on the first try.
- **X6 (live):** S3 and S4 added to the set are reported as `document_added`, and their clashes appear as new (not as regressions).

## Ranked issues

**1. HIGH: a family decision closes new and reappeared clashes without a human seeing them (safety invariant 4).**
- *Where:* `inheritanceFor` (family branch) and `POST /batches` family close items.
- *Example:* family F-3660e1dd25 (TOL-003) was approved as *close* in v41. The v42 batch item I-71a0d922d5 closes 17 clashes, including:
  - 9 from G-fa155adb0e (`change: reappeared`, reviewReasons **"cierre de grupo con seguridad_personas"**);
  - 2 reappeared clashes of G-f32742de4e.

  The item says `viewedInViewer: true` and `lowConfidence: false`, but both were carried from v41. Both groups show as "decided" in the tree. The same path gives G-bfdccf2af5 (an entirely new clash, "seguridad de las personas") the state `inherited`, not `inherited_pending`.
- *Fix:*
  - inheritance per clash, not per group: any new or reappeared clash in a family instance makes it `inherited_pending`;
  - never inherit a closure onto a group that has `humanReview` reasons on this version;
  - recompute `viewedInViewer` for each version;
  - add a test for "family close + reappeared + seguridad_personas → not in batch".

**2. HIGH: ACC decisions are not inherited on real data.**
- *Where:* `inheritanceFor` step 1 requires *every raw clash id* to be in the ACC index.
- *Example (live v11):* all 7 groups ACC already knows show `needs_review` with no ↺ icon:
  - 2 assigned groups (issues #1 and #2) and 5 closed as VALID_INTERFACE;
  - in each, the group has 3× raw copies (a linked model published again), e.g. G-1088e8365a with 24 raw / 8 unique, of which ACC holds 8;
  - G-c129f6b286 (closed in ACC) is on the ALC agenda as "P1 sin decidir".

  In fixtures (no linked copies) the same step works, which is why tests pass.
- *Fix:* match on the unique-clash key (the dedupe used for `uniqueClashCount`), not on raw ids. For a `real` group closed in ACC (D8 against invariant 1), do not hide it and do not re-propose it every week: show it once as "Cerrada en ACC (interfaz válida) · motor dice real — confirmar", and remember the answer.

**3. HIGH: the agenda cap hides the most important follow-up.**
- *Where:* `GET /tests/:id/agenda`. The order is regresion → p1_pendiente → incidencia → nuevo → confirmar, with a cap of 15.
- *Example (v42):* CLI has 19 `p1_pendiente` items. #106 (P1, overdue, no progress for 2 cycles) is item 22 and #103 (to confirm) is item 25, so both fall under "+10 más". In the meeting I start with commitments that were not met.
- *Fix:*
  - order the agenda: incidencia (dice_resuelta / stuck / overdue) → regresion → P1 → nuevo → confirmar;
  - incidencias never count towards the cap;
  - show the ACC number (`displayId`) on agenda items: the payload has no `#106`, and every issue is called by number in the meeting.

**4. HIGH: the approver's name is written into ACC (invariant 6).**
- *Where:* `coordinator-ui.ts:2205`, the close body `description: "… Decisión de familia v1 (${dec.decidedBy})."`, which `planRequests` POSTs to `clashes:close`.
- *Fix:* remove `decidedBy` from the description and keep it in the audit log only. Reword the description as "Cerrada: tolerancia aceptada (TOL-003). Decisión de coordinación v1." (today it reads "Cerrar o marcar revisado con el motivo …").

**5. MEDIUM-HIGH: group titles show the wrong count.**
- *Where:* group titles built before the signature split (invariant 8).
- *Example:* G-9ff7543f88 "Nivel -1: 5 ductos CLI vs 5 vigas de EST (5 interf.)" holds 1 clash. 31 of 156 groups have this in v41 and 13 of 245 on the live project.
- *Fix:* rebuild the title after the split, or drop the count from the title.

**6. MEDIUM: "No verificable" hides two different findings.**
- **#104:** an element of the resolved set clashes again (the problem moved), and the EST model is stale. This is a meeting topic, but it gets a grey chip, does not appear in the agenda or in any reminder, and does not name the group where the element clashes now.
- **#105:** its clashes disappeared because CLI changed, while INC (the responsible discipline) did not publish. In practice either side may fix it.
- *Fix:*
  - add the chips "Se desplazó" (with a link to the new group) and "Modelo sin actualizar";
  - add `no_verificable` to the agenda as `confirmar`;
  - reword #105 as "Se resolvió por cambio en CLI; INC no publicó — confirmar que esa era la solución".

**7. MEDIUM: families are too fine for the meeting.**
- *Example:*
  - 83 families for 156 groups in v41, 43 of them with a single member;
  - "Ductos CLI invaden el fondo de vigas" is split into about 25 families by beam section (V200x500…V350x800) and system (inyección/retorno/extracción).
- *Fix:* add an agenda roll-up "tema" = problemType + pair (+ level), with families as sub-rows. The agenda line would read "Ductos CLI vs vigas EST — 19 familias, 30 ubicaciones, niveles -1 a 3".

**8. MEDIUM: hygiene items are shown as regressions.**
- *Example:* COORD "Modelos superpuestos: PRJ-EST-MOD-001.rvt + PRJ-EST-MOD-001.rvt" is listed as `regresion`. G-ca813ff23b (32 clashes) is "Reapareció" because 1 clash came back.
- *Fix:* add a separate agenda kind `higiene`, placed at the end. In the lens, mark an item "Reapareció" only for `real` items, or when the reappeared clashes are ≥ 20 % of the item.

**9. MEDIUM: the reminders are not ready to send.**
- No project name. An HVAC subcontractor works on several projects; use "Edificio Demo Las Condes — Recordatorio CLI".
- They cite "v42", which subcontractors don't know. Use the run date as dd-mm-aaaa, the same format the UI already uses.
- No deadline: "antes de la próxima corrida" should be "antes del <fecha próxima reunión>".
- Empty lines such as "0 marcadas resueltas" stay in the text.
- No INC or EST reminder for #104 and #105 (see 6).

**10. MEDIUM: meeting notes invite personal data.**
- The note placeholder asks "Qué se acordó, **quién** y para cuándo".
- A note containing "Juan Pérez … juan.perez@contratista.cl" was saved with no warning (fixtures).
- *Fix:* change the placeholder to "qué disciplina/empresa". Warn on emails and person-like names, as `draft_issue` already does for agent text.

**11. LOW-MEDIUM: wording and status leaks.**
- Raw ACC statuses: `ACC la marca "closed"` and `Estado ACC: in_review`. Translate them to Cerrada / En revisión.
- #103 shows "Resuelta 2/2 **vencida**". Do not show "vencida" on a resuelta.
- Grammar: "1 resueltas", "1 interferencias", "ubicación(es)".
- English Revit families in titles: "ELE Ladder Cable Tray vs ductos — Nivel -1 (6)".
- Titles with ids: "Ducto vs viga — Nivel 2 · id 340308".

**12. LOW-MEDIUM: first-cycle wording.**
- In v41, every issue says "Sigue abierta … sin cambios a favor" and "Modelo X: sin dato". This should say "Primera verificación (sin ciclo anterior)".
- `changeSummary.baseReason` is `previous` in the UI payload, while the CLI reports `first_cycle` for the same run.

**13. LOW: lens badges mix units.**
- Qué cambió 72 and Todo 263 count interferencias, Incidencias 6 counts issues, and Reunión 43 counts temas, all next to "41 grupos · 48 ubicaciones".
- *Fix:* one unit on the badges (ubicaciones), or a unit word on each.

**14. LOW (M5): the gate accepts 1 resuelta per cycle.**
- `issueGate` is `ready` with 2 cycles of 1 accepted resuelta each.
- *Fix:* also require at least 10 decided resuelta verdicts in total.

**15. LOW (domain): responsibility for missing slab penetrations.**
- "Tuberías … cruzan sin pasada losas" puts EST as responsible; the agenda section is EST with 6 such items.
- At SalfaCorp the MEP specialty requests the pasada and the calculista validates it. Make the responsible discipline the pipe's (ALC/AP/ALL), with EST secondary, unless the project convention says otherwise.

## Terms a SalfaCorp coordinator would change

| Today | Proposed | Why |
|---|---|---|
| grupo (= familia) / ubicación (= group) / tema / familia F-xxxx | **tema** (meeting) · **ubicación** (location) · drop "grupo" in the lenses | four words for two concepts |
| Distancia −56 mm | **Penetración 56 mm** | what we say on site |
| Bajar penetración + 25 mm verificando altura de cielo | **Bajar el ducto ~81 mm (verificar altura de cielo)** | give the number, not the formula |
| Válida / Tolerable / tolerado | **Real** · **Tolerada** | one word each, matching ACC/engine |
| No verificable | **Se desplazó** · **Modelo sin actualizar** · **Fuera de alcance** | each one is a different action |
| Dice resuelta ✕ | **Cerrada en ACC, sigue en modelo** | the subcontractor reads the reminder |
| Modelos superpuestos: X.rvt + X.rvt | **Modelo X publicado dos veces (vistas {3D} y Coordinación)** | the BIM manager knows what to fix |
| Sin asignar (SIN) for PRJ-SAN-MOD-001 | assign SAN by file name at setup | otherwise a "SIN" section appears in the agenda |
| coordinación v42 | **Coordinación del 04-11-2026** | contractors don't know version numbers |

## Watch in the first 2 real cycles

1. **ACC inheritance on linked models:** after fix 2, every group in `accSync.assignedGroups/closedGroups` must show ↺ and must be absent from "P1 sin decidir". Count the misses.
2. **Batch review:** before approving, open every family close item and check `change` per group. A reappeared or new clash in a close item is a bug report, not an approval.
3. **Verdict acceptance:** log every resuelta / dice_resuelta you reject and its V-code. V01 (moved) and V02 (stale model) show whether 6 is needed. Do not count cycles with fewer than 5 resuelta towards M5.
4. **Agenda length and time:** time the meeting by section. If CLI goes over 15 temas again, the roll-up (7) is needed before cycle 3.
5. **needs_review load:** v41 had 120 of 156 groups and live v11 has 158 of 245, including 18 needs_info "Elemento sin categoría: Sitio Vol.ifc". The second cycle should halve the pending count. If not, decision memory is not paying off; check how many human accepts were dropped for "group gained clashes" and consider partial inheritance ("18 de 22 ya decididas").
6. **Personal data:** grep notes, ACC descriptions and reminders for names and emails after each cycle, until issues 4 and 10 are fixed. Confirm O-7 (Procedimiento Acceso Herramientas IA) before any ACC comment text reaches the agent.
7. **Agent questions (X3):** not exercised. The fixtures run had no agent, so `questions` stayed at 0. In cycle 1, check that `?` rows become stale when their clashes change.
