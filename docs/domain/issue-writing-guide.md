# Issue writing guide

How to write a coordination issue (*incidencia de coordinación*) that gets fixed on the first read. Issues are written **in Spanish** and **per group**, not per clash. The engine fills the structured fields. The agent writes the description. A coordinator approves before anything reaches ACC.

What a good issue looks like:
- It says **what** is wrong, **where** exactly, **why** it matters, **what** is requested and **who** does it **by when**.
- A modeler can open it, click the viewpoint, and know what to move without asking anyone.
- It contains no blame, no essay, and no "please review".

---

## 1. Title

Pattern (≤ 100 characters; ACC truncates long titles in lists):

```
[{band}][{DISC_RESP}×{DISC_OTRA}] {nivel} · {ubicación} · {qué} {verbo} {qué}
```

Rules:
- Band and discipline pair first, so the issue list sorts and scans well.
- Location: level plus grid bay (`Eje C-D/4-5`). If there is no grid, use the room or zone name. If there is neither, use the level only.
- Use concrete nouns: *ducto INY-UMA-2 600x400*, *viga V 30x70*, *tubería ALC Ø110*. Never "elemento", never a Revit ElementId in the title.
- Verbs: *atraviesa*, *interfiere*, *invade*, *queda bajo*, *obstruye*, *duplica*.
- For groups, count in the title: "… atraviesa 14 vigas".

Good:
- `[P1][CLI×EST] Piso 4 · Eje B-E/2-3 · Ducto INY-UMA-2 600x400 atraviesa 14 vigas`
- `[P2][INC×CLI] Piso 3 · Pasillo central · 6 rociadores obstruidos por ducto RET-UMA-3`

Bad:
- `Interferencia 41299469560661` (no information)
- `Revisar ductos piso 4` (no problem stated, no owner)
- `Error grave de CLI en todo el edificio!!!` (blame, no location)

## 2. Description template

```markdown
**Problema**
{1–2 sentences: what clashes with what, size, penetration. Plain facts.}

**Ubicación**
{Nivel} · {Eje/bay o recinto} · Cota aprox. {z} m (if known)
Elementos: {lista corta: categoría, tipo, sistema, Ø/medidas, archivo}

**Por qué importa**
{1 sentence: consequence if built as modeled — structural, life safety, slope,
 clear height, rework. Cite a norm only as reference ("criterio NFPA 13"),
 never as a compliance verdict.}

**Acción solicitada**
{Imperative, specific, owned by the responsible discipline. Offer 1–3 options
 in order of preference when the solution is not obvious.}
1. …
2. …

**Responsable:** {DISC} ({empresa/persona if configured})
**Aprueba / consultar:** {secondary discipline, e.g. "EST (calculista)"}
**Fecha compromiso:** {dd-mm-aaaa} ({banda}, {regla de plazo})

**Referencias**
Grupo {G-…} · {N} interferencias · Reglas {ruleIds} · Prueba MC {testId}, versión de conjunto {n}
Modelos: {archivo vX publicado dd-mm}, {archivo vY publicado dd-mm}
```

Style rules:
- Spanish, impersonal and direct. Address the discipline, not the person ("CLI debe…", or simply "Bajar el ducto…").
- Units: mm for sizes and penetrations, m for elevations (*cotas*). Use `Ø` for diameters and `ancho x alto` for rectangular sections.
- Clash IDs and keys go **only** in "Referencias".
- Never write "aprobado" about structural openings. Write "sujeto a aprobación del calculista".
- One issue = one responsible party. If two disciplines must act, create two issues and link them.
- Maximum about 180 words in the description. If you need more, the group is wrong.

## 3. Responsible party

- `responsibleDiscipline` comes from the classification. Map it to an ACC assignee through `.coordinator/project.yaml`:
  ```yaml
  assignees:
    CLI:  { type: company, name: "Clima Ingeniería Ltda." }
    EST:  { type: company, name: "Oficina de Cálculo X" }
    ARQ:  { type: role,    name: "Arquitectura" }
    COORD:{ type: user,    email: coordinador.bim@salfacorp.com }
  ```
- `COORD` issues (escalations) are assigned to the coordinator and appear on the meeting agenda.
- Put `secondaryDiscipline` in the description and in watchers. It is never the assignee.

## 4. Due-date logic (deterministic)

Inputs:
- `publishDate`: the day the issue is approved;
- `band`;
- `project.meetingWeekday` (default Wednesday);
- `project.holidays` (Chilean national holidays plus project closures);
- the classification.

```
bd(n) = add n business days (Mon–Fri, skipping holidays)
target = { P1: 3, P2: 7, P3: 14, P4: 30 }[band]

due = bd(publishDate, target)

# approval loop: structural openings need the calculista
if secondaryDiscipline == EST and rootCause in [missing_opening, design_coordination]
   and severity != critical:
     due = bd(due, 5)

if validity == needs_info:            due = bd(publishDate, 5)
if suggestedAction == hygiene_issue:  due = next model publication cut-off ≥ bd(publishDate, 3)

# snap to the meeting cycle so the result is reviewed in a meeting
# (hygiene issues are exempt: they snap to the publication cut-off instead)
if suggestedAction != hygiene_issue:
    due = last business day BEFORE the first meeting date ≥ due
due = max(due, bd(publishDate, 2))      # never less than 2 business days
```

Record the rule used (e.g. "P1 · 3 días hábiles, ajustado a reunión del 18-11") in the description, so nobody argues about the date.

## 5. Viewpoint and attachments

- **Placement:** pin the issue on the hub element (or on the worst member for runs and zones), linked to the model document so it opens in ACC with the element selected.
- **Viewpoint:** a 3D view, section box around the group's bounding box plus 1 m, both clashing elements isolated or highlighted, the rest of the model ghosted, and the camera looking along the run. For slabs and beams, look from below.
- **Attachment (optional):** a screenshot of the same view with markers, named `G-xxxxxxxxxx_{nivel}.png`.
- **Custom fields (if the ACC project defines them):** Prioridad (P1–P4), Disciplina responsable, ID de grupo, Regla.
- **ACC fields:**
  - issue type and subtype: *Coordinación / Interferencia*;
  - status: *Borrador* (draft) until approved, then *Abierta* (open);
  - root cause: map ours to the project's ACC root-cause list in `project.yaml` (e.g. `missing_opening` → "Coordinación de pasadas").

## 6. Lifecycle language

| Event | Comment added to the issue |
|---|---|
| Re-test: group shrank | "Ciclo {n}: quedan {k} de {N} interferencias. Pendientes en {niveles}." |
| Re-test: all gone | "Ciclo {n}: no se detectan interferencias del grupo. Se propone cerrar; validar en reunión." |
| Regression | "Ciclo {n}: reaparecen {k} interferencias ya resueltas. Se sube prioridad." |
| Element deleted | "Ciclo {n}: el elemento {tipo} fue eliminado del modelo. Confirmar que la eliminación es intencional." |

---

## 7. Examples

Assumptions for the dates: issues approved and published on Thursday 12-11-2026, the day after a Wednesday meeting. Models are published on Mondays (cut-off D-2).

### Example 1. P1, hub mover (EST-004)

**Title:** `[P1][CLI×EST] Piso 4 · Eje B-E/2-3 · Ducto INY-UMA-2 600x400 atraviesa 14 vigas`

```markdown
**Problema**
El ducto de inyección INY-UMA-2 (600x400 mm) atraviesa 14 vigas entre los ejes
B y E. En 13 de ellas la penetración supera 300 mm: el ducto está modelado a la
altura de las vigas.

**Ubicación**
Piso 4 · Eje B-E/2-3 · Pasillo central
Elementos: Ducto rectangular galvanizado, sistema INY-UMA-2 (P2401-CLI.rvt) /
Vigas HA V 30x70 (P2401-SLF-ZZ-ZZ-M3-S-0001.rvt)

**Por qué importa**
Una pasada de 600 mm en vigas de 700 mm no es viable estructuralmente.
Bloquea el montaje de clima en todo el pasillo.

**Acción solicitada**
1. Verificar el nivel de referencia y el offset del ducto: el patrón sugiere un
   error de cota.
2. Si la cota es correcta, bajar el tramo bajo las vigas (altura libre de
   entretecho disponible ≈ 450 mm) o dividir en dos ductos de 600x200.
3. Si no hay solución, escalar a reunión con ARQ (altura de cielo).

**Responsable:** CLI (Clima Ingeniería Ltda.)
**Aprueba / consultar:** EST (calculista), ARQ (si cambia el cielo)
**Fecha compromiso:** 17-11-2026 (P1 · 3 días hábiles, ajustado a reunión del 18-11)

**Referencias**
Grupo G-3f9a0c21be · 14 interferencias · Regla EST-004 · Prueba MC 8812, conjunto v37
Modelos: P2401-CLI.rvt v52 (04-11), P2401-SLF-ZZ-ZZ-M3-S-0001.rvt v31 (03-11)
```

### Example 2. P1, single clash (EST-002)

**Title:** `[P1][ALC×EST] Piso 3 · Eje C/4 · Tubería ALC Ø110 atraviesa viga V 25x60`

```markdown
**Problema**
La tubería gravitacional ALC 3 (PVC Ø110) atraviesa la viga V 25x60 con
60 mm de penetración.

**Ubicación**
Piso 3 · Eje C/4-5 · Baño departamento tipo B
Elementos: Tubería PVC Sanitario, sistema ALC 3 (P2401-SAN-TorreA.rvt) /
Viga HA V 25x60 (P2401-SLF-ZZ-ZZ-M3-S-0001.rvt)

**Por qué importa**
La pendiente limita el desvío; una pasada en viga requiere aprobación del calculista.

**Acción solicitada**
1. Evaluar cambio de trazado hacia el shaft del eje D manteniendo pendiente ≥ 1 %.
2. Si no es posible, enviar solicitud de pasada Ø150 a EST indicando posición
   en la viga (preferir tercio central de la luz). Sujeto a aprobación del calculista.

**Responsable:** ALC (especialista sanitario)
**Aprueba / consultar:** EST (calculista)
**Fecha compromiso:** 17-11-2026 (P1 · 3 días hábiles, ajustado a reunión del 18-11)

**Referencias**
Grupo G-71c2d9e044 · 1 interferencia · Regla EST-002 · Prueba MC 8812, conjunto v37
```

### Example 3. P2, run (INC-001)

**Title:** `[P2][INC×CLI] Piso 3 · Pasillo eje 2-6 · 6 rociadores obstruidos por ducto RET-UMA-3`

```markdown
**Problema**
Seis rociadores colgantes del ramal RCI-P3 quedan sobre o contra el ducto de
retorno RET-UMA-3 (800x300 mm).

**Ubicación**
Piso 3 · Pasillo central, ejes 2 a 6
Elementos: Rociadores K5.6 (P2401-INC.rvt) / Ducto RET-UMA-3 (P2401-CLI.rvt)

**Por qué importa**
El ducto obstruye la descarga: zona sin cobertura de rociadores (criterio NFPA 13
para obstrucciones mayores a 1,2 m de ancho requiere rociadores bajo el ducto).

**Acción solicitada**
1. Reubicar rociadores fuera de la proyección del ducto o agregar rociadores
   bajo el ducto en los tramos afectados.
2. Verificar con CLI si el ducto puede desplazarse 300 mm hacia el eje A.

**Responsable:** INC
**Aprueba / consultar:** CLI
**Fecha compromiso:** 24-11-2026 (P2 · 7 días hábiles, ajustado a reunión del 25-11)

**Referencias**
Grupo G-a04be771d3 · 6 interferencias · Regla INC-001 · Prueba MC 8812, conjunto v37
```

### Example 4. P3, missing openings (EST-009), owner is EST

**Title:** `[P3][EST×AP] Pisos 2-9 · Shaft eje D/3 · Faltan 8 pasadas de montantes APC en losas`

```markdown
**Problema**
El montante de agua caliente APC MONTANTE 2 (PPR Ø75) cruza 8 losas sin pasada
modelada en el modelo estructural.

**Ubicación**
Pisos 2 a 9 · Shaft sanitario eje D/3
Elementos: Tubería PPR Ø75 (P2401-SAN-TorreA.rvt) / Losas HA e=15 (EST)

**Por qué importa**
Sin la pasada en el modelo, no queda en planos de moldaje y se perfora después
del hormigonado.

**Acción solicitada**
1. AP confirma diámetro de pasada (Ø110 con camisa) y ubicación dentro del shaft.
2. EST modela las 8 pasadas en las losas (hueco que corte la losa) y las
   incorpora al plano de pasadas.

**Responsable:** EST
**Aprueba / consultar:** AP
**Fecha compromiso:** 01-12-2026 (P3 · 14 días hábiles, ajustado a reunión del 02-12)

**Referencias**
Grupo G-5d1e8b0f92 · 8 interferencias · Regla EST-009 · Prueba MC 8812, conjunto v37
```

### Example 5. Model hygiene (DUP-005)

**Title:** `[P3][ARQ] Higiene · P2401_ARQ_TorreA.rvt remodela 184 muros estructurales de EST`

```markdown
**Problema**
El modelo de arquitectura contiene 184 muros tipo "Muro HA 20" que duplican los
muros estructurales del modelo EST (superposición ≥ 80 % del espesor).

**Ubicación**
Pisos 1 a 10 (detalle por nivel en adjunto)
Archivo: P2401_ARQ_TorreA.rvt v44

**Por qué importa**
Genera 1.130 interferencias falsas que ocultan problemas reales y duplica
cubicaciones de hormigón.

**Acción solicitada**
1. Eliminar los muros HA del modelo ARQ y vincular el modelo EST.
2. Modelar solo revestimientos (estuco, cerámica) como muros delgados adosados.
3. Publicar antes del corte del 23-11 para la próxima corrida.

**Responsable:** ARQ
**Aprueba / consultar:** EST
**Fecha compromiso:** 23-11-2026 (higiene · próximo corte de publicación)

**Referencias**
Grupo G-0c77e4a1f5 · 1.130 interferencias cerradas como duplicado · Regla DUP-005
```
