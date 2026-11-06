# Eval scenarios: clash classification

A set of 25 clashes with the classification a senior BIM coordinator would give. It is used for:

1. **Engine unit tests** (`core/classify`, `core/score`). The deterministic outputs must match **exactly**: `ruleId`, `validity`, `nature`, `rootCause`, `responsibleDiscipline`, `secondaryDiscipline`, `severity` and `band`. A field missing from `expected` is not asserted.
2. **Agent (LLM) evaluation.** The agent gets the input; its judgment is compared with the expected result. Its Spanish rationale should also cover what `notes` says.

Rule versions: `rules/classification-rules.yaml` v1, `rules/discipline-matrix.yaml` v1, `rules/priority-scoring.yaml` v1. If a rule changes, update the expected values in the same commit.

All 25 were verified against a throwaway prototype of the engine built from the three YAML files (scratch, not committed). `band: NONE` means the score was zeroed by OVR-001 (non-issue).

## Format

- `dist` is in **metres**, as in the MC clash resource (negative = penetration).
- `left` / `right` are raw properties from Model Properties or the viewer, **before** normalization. Categories deliberately keep the `Revit ` prefix and mix Spanish and English, to exercise normalization.
- `modelFile` is the document lineage (same file across viewables and versions). `documentId` is the clash-resource document id.
- `orientation` is optional (geometry-derived). Without it the engine falls back to the generic rule.
- `groupCount` (default 1) and `daysToInstall` (default: no schedule) are optional.
- Fixtures should parse the YAML block verbatim. `notes` is Spanish because it is what the agent's rationale should say.

## Scenarios

```yaml
scenarios:

  - id: EV-01
    title: Alcantarillado Ø110 atraviesa viga
    dist: -0.060
    left:  { documentId: 3, modelFile: lin-san, documentName: P2401-SAN-TorreA.rvt, externalId: s-001, category: Revit Tuberías, family: Tubería PVC, type: PVC Sanitario, level: Piso 3, systemClassification: Sanitario, systemType: ALC Aguas Servidas, systemName: ALC 3, diameterMm: 110 }
    right: { documentId: 1, modelFile: lin-est, documentName: P2401-SLF-ZZ-ZZ-M3-S-0001.rvt, externalId: e-101, category: Revit Structural Framing, family: Viga HA Rectangular, type: V 25x60, level: Piso 3, widthMm: 250, heightMm: 600 }
    expected: { ruleId: EST-002, validity: real, nature: hard, rootCause: design_coordination, responsibleDiscipline: ALC, secondaryDiscipline: EST, severity: critical, band: P1 }
    notes: La gravedad no se desvía libremente; pasada en viga solo con calculista. Es el caso del ejemplo de priority-scoring.yaml (67 → piso 75).

  - id: EV-02
    title: Aislación contra su propia tubería
    dist: -0.025
    left:  { documentId: 4, modelFile: lin-cli, documentName: P2401-CLI.rvt, externalId: c-201, category: Revit Aislamientos de tuberías, family: Aislamiento de tubería, type: Elastomérico 25 mm, systemClassification: Hydronic Supply, systemName: AGUA HELADA IMP 1, level: Piso 5, insulationThicknessMm: 25 }
    right: { documentId: 4, modelFile: lin-cli, documentName: P2401-CLI.rvt, externalId: c-202, category: Revit Pipes, family: Tubería acero, type: Acero SCH40, systemClassification: Hydronic Supply, systemName: AGUA HELADA IMP 1, level: Piso 5, diameterMm: 80 }
    expected: { ruleId: FP-001, validity: false_positive, nature: hard, rootCause: not_applicable, responsibleDiscipline: COORD, severity: none, band: NONE }
    notes: Excluir aislación vs anfitrión en la configuración de la prueba.

  - id: EV-03
    title: Luminaria embutida en cielo
    dist: -0.070
    left:  { documentId: 6, modelFile: lin-ele, documentName: P2401-ELE.rvt, externalId: l-301, category: Revit Luminarias, family: Panel LED 60x60, type: 40W, level: Piso 2 }
    right: { documentId: 2, modelFile: lin-arq, documentName: P2401_ARQ_TorreA.rvt, externalId: a-401, category: Revit Techos, family: Cielo modular, type: Cielo americano 60x60, level: Piso 2, thicknessMm: 15 }
    expected: { ruleId: FP-008, validity: false_positive, responsibleDiscipline: COORD, severity: none, band: NONE }
    notes: '"Techos" en Revit es-ES = cielos. Solo verificar coherencia con el plano de cielo.'

  - id: EV-04
    title: Ducto de inyección 600x400 contra viga
    dist: -0.250
    left:  { documentId: 4, modelFile: lin-cli, documentName: P2401-CLI.rvt, externalId: c-210, category: Revit Ducts, family: Ducto rectangular, type: Galvanizado, systemClassification: Supply Air, systemType: Inyección, systemName: INY-UMA-2, level: Piso 4, widthMm: 600, heightMm: 400 }
    right: { documentId: 1, modelFile: lin-est, documentName: P2401-SLF-ZZ-ZZ-M3-S-0001.rvt, externalId: e-110, category: Revit Armazón estructural, family: Viga HA Rectangular, type: V 30x70, level: Piso 4, widthMm: 300, heightMm: 700 }
    expected: { ruleId: EST-004, validity: real, nature: hard, rootCause: design_coordination, responsibleDiscipline: CLI, secondaryDiscipline: EST, severity: critical, band: P1 }
    notes: Pasada de 600 mm en viga de 700 mm no es viable. Revisar trazado o altura de entretecho.

  - id: EV-05
    title: Agua potable Ø25 por tabique no RF
    dist: -0.025
    left:  { documentId: 3, modelFile: lin-san, documentName: P2401-SAN-TorreA.rvt, externalId: s-020, category: Revit Tuberías, family: Tubería PPR, type: PPR PN20, systemClassification: Domestic Cold Water, systemType: APF, systemName: APF 2, level: Piso 2, diameterMm: 25 }
    right: { documentId: 2, modelFile: lin-arq, documentName: P2401_ARQ_TorreA.rvt, externalId: a-410, category: Revit Muros, family: Muro básico, type: Tabique volcometal 95, level: Piso 2, widthMm: 95 }
    expected: { ruleId: TOL-008, validity: tolerated, responsibleDiscipline: COORD, severity: none, band: NONE }
    notes: Pasada estándar en tabique; se ejecuta en obra.

  - id: EV-06
    title: Conduit Ø20 embutido en losa de 150 mm
    dist: -0.020
    left:  { documentId: 6, modelFile: lin-ele, documentName: P2401-ELE.rvt, externalId: l-330, category: Revit Conduits, family: Tubo conduit, type: PVC conduit, level: Piso 6, diameterMm: 20 }
    right: { documentId: 1, modelFile: lin-est, documentName: P2401-SLF-ZZ-ZZ-M3-S-0001.rvt, externalId: e-130, category: Revit Floors, family: Suelo, type: Losa HA e=15, level: Piso 6, thicknessMm: 150 }
    expected: { ruleId: TOL-005, validity: tolerated, responsibleDiscipline: COORD, secondaryDiscipline: EST, severity: none, band: NONE }
    notes: Práctica chilena de canalización embutida; 20 ≤ 150/3.

  - id: EV-07
    title: Conduit Ø63 embutido en losa de 150 mm
    dist: -0.063
    left:  { documentId: 6, modelFile: lin-ele, documentName: P2401-ELE.rvt, externalId: l-331, category: Revit Tubos, family: Tubo conduit, type: PVC conduit, level: Piso 6, diameterMm: 63 }
    right: { documentId: 1, modelFile: lin-est, documentName: P2401-SLF-ZZ-ZZ-M3-S-0001.rvt, externalId: e-130, category: Revit Suelos, family: Suelo, type: Losa HA e=15, level: Piso 6, thicknessMm: 150 }
    expected: { ruleId: TOL-006, validity: real, nature: hard, rootCause: routing_conflict, responsibleDiscipline: ELE, secondaryDiscipline: EST, severity: medium, band: P3 }
    notes: 63 > 50 (1/3 del espesor). Redistribuir o pedir aprobación al calculista.

  - id: EV-08
    title: Mismo elemento en dos archivos
    dist: -0.300
    left:  { documentId: 2, modelFile: lin-arq, documentName: P2401_ARQ_TorreA.rvt, externalId: dup-777, category: Revit Walls, family: Muro básico, type: Tabique 120, level: Piso 1, widthMm: 120 }
    right: { documentId: 9, modelFile: lin-arq-copia, documentName: P2401_ARQ_TorreA_copia.rvt, externalId: dup-777, category: Revit Walls, family: Muro básico, type: Tabique 120, level: Piso 1, widthMm: 120 }
    expected: { ruleId: DUP-001, validity: false_positive, nature: duplicate, rootCause: duplicate_model, responsibleDiscipline: COORD, severity: none, band: NONE }
    notes: Corregir el model set (archivo copiado), no el diseño. Una sola incidencia de higiene.

  - id: EV-09
    title: ARQ remodela muro estructural
    dist: -0.200
    left:  { documentId: 2, modelFile: lin-arq, documentName: P2401_ARQ_TorreA.rvt, externalId: a-500, category: Revit Muros, family: Muro básico, type: Muro HA 20, level: Piso 3, widthMm: 200 }
    right: { documentId: 1, modelFile: lin-est, documentName: P2401-SLF-ZZ-ZZ-M3-S-0001.rvt, externalId: e-500, category: Revit Muros, family: Muro básico, type: M HA e=20, level: Piso 3, widthMm: 200 }
    expected: { ruleId: DUP-005, validity: false_positive, nature: duplicate, rootCause: duplicate_model, responsibleDiscipline: ARQ, secondaryDiscipline: EST, severity: none, band: NONE }
    notes: ARQ debe vincular EST y modelar solo revestimientos. Se agrupan todos los muros en una sola incidencia de higiene.

  - id: EV-10
    title: Rociador obstruido por ducto
    dist: -0.040
    left:  { documentId: 7, modelFile: lin-inc, documentName: P2401-INC.rvt, externalId: i-600, category: Revit Rociadores, family: Rociador colgante, type: K5.6 68°C, systemClassification: Fire Protection Wet, systemName: RCI-P3, level: Piso 3 }
    right: { documentId: 4, modelFile: lin-cli, documentName: P2401-CLI.rvt, externalId: c-600, category: Revit Conductos, family: Ducto rectangular, type: Galvanizado, systemClassification: Return Air, systemName: RET-UMA-3, level: Piso 3, widthMm: 800, heightMm: 300 }
    expected: { ruleId: INC-001, validity: real, nature: hard, rootCause: design_coordination, responsibleDiscipline: INC, secondaryDiscipline: CLI, severity: high, band: P2 }
    notes: Mover el rociador o agregar uno bajo el ducto (NFPA 13). Seguridad de las personas, piso de prioridad 70.

  - id: EV-11
    title: Alcantarillado contra agua potable
    dist: -0.045
    left:  { documentId: 3, modelFile: lin-san, documentName: P2401-SAN-TorreA.rvt, externalId: s-700, category: Revit Tuberías, family: Tubería PVC, type: PVC Sanitario, systemClassification: Sanitary, systemType: ALC, systemName: ALC 4, level: Subterráneo -1, diameterMm: 110 }
    right: { documentId: 3, modelFile: lin-san, documentName: P2401-SAN-TorreA.rvt, externalId: s-701, category: Revit Tuberías, family: Tubería PPR, type: PPR PN20, systemClassification: Domestic Cold Water, systemType: APF, systemName: APF MATRIZ, level: Subterráneo -1, diameterMm: 50 }
    expected: { ruleId: MM-002, validity: real, nature: hard, rootCause: routing_conflict, responsibleDiscipline: AP, secondaryDiscipline: ALC, severity: high, band: P2 }
    notes: Mismo archivo SAN, pero el motor afina la disciplina por sistema (AP vs ALC). Mueve AP.

  - id: EV-12
    title: Escalerilla contra ducto grande
    dist: -0.080
    left:  { documentId: 6, modelFile: lin-ele, documentName: P2401-ELE.rvt, externalId: l-800, category: Revit Bandejas de cables, family: Escalerilla portaconductores, type: Escalerilla 300x100, level: Piso 2, widthMm: 300, heightMm: 100 }
    right: { documentId: 4, modelFile: lin-cli, documentName: P2401-CLI.rvt, externalId: c-800, category: Revit Ducts, family: Ducto rectangular, type: Galvanizado, systemClassification: Exhaust Air, systemName: EXT-BAÑOS, level: Piso 2, widthMm: 500, heightMm: 300 }
    expected: { ruleId: MM-010, validity: real, nature: hard, rootCause: routing_conflict, responsibleDiscipline: ELE, secondaryDiscipline: CLI, severity: medium, band: P3 }
    notes: Jerarquía de desplazamiento ducto grande (80) > escalerilla (65), así que mueve ELE.

  - id: EV-13
    title: Tubería de clima atraviesa pilar
    dist: -0.080
    left:  { documentId: 4, modelFile: lin-cli, documentName: P2401-CLI.rvt, externalId: c-900, category: Revit Pipes, family: Tubería cobre, type: Cobre tipo L, systemClassification: Other, systemType: Refrigerante VRF, systemName: VRF-L, level: Piso 7, diameterMm: 22 }
    right: { documentId: 1, modelFile: lin-est, documentName: P2401-SLF-ZZ-ZZ-M3-S-0001.rvt, externalId: e-900, category: Revit Pilares estructurales, family: Pilar HA, type: P 50x50, level: Piso 7, widthMm: 500, heightMm: 500 }
    expected: { ruleId: EST-001, validity: real, nature: hard, rootCause: routing_conflict, responsibleDiscipline: CLI, secondaryDiscipline: EST, severity: critical, band: P1 }
    notes: Nada atraviesa pilares, aunque sea Ø22.

  - id: EV-14
    title: Modelo genérico sin función declarada
    dist: -0.120
    left:  { documentId: 4, modelFile: lin-cli, documentName: P2401-CLI.rvt, externalId: c-950, category: Revit Modelos genéricos, family: Caja metálica, type: Tipo 1, level: Cubierta }
    right: { documentId: 6, modelFile: lin-ele, documentName: P2401-ELE.rvt, externalId: l-950, category: Revit Cable Tray, family: Escalerilla portaconductores, type: Escalerilla 200x100, level: Cubierta, widthMm: 200, heightMm: 100 }
    expected: { ruleId: NI-001, validity: needs_info, nature: hard, rootCause: lod_mismatch, responsibleDiscipline: CLI, severity: low, band: P3 }
    notes: Pedir recategorizar. No se emite incidencia de diseño todavía.

  - id: EV-15
    title: Pasada modelada contra losa
    dist: -0.150
    left:  { documentId: 3, modelFile: lin-san, documentName: P2401-SAN-TorreA.rvt, externalId: s-960, category: Revit Modelos genéricos, family: Pasada circular, type: Ø150, level: Piso 4, diameterMm: 150 }
    right: { documentId: 1, modelFile: lin-est, documentName: P2401-SLF-ZZ-ZZ-M3-S-0001.rvt, externalId: e-960, category: Revit Floors, family: Suelo, type: Losa HA e=18, level: Piso 4, thicknessMm: 180 }
    expected: { ruleId: FP-010, validity: false_positive, responsibleDiscipline: COORD, severity: none, band: NONE }
    notes: La pasada existe como elemento; el choque la confirma. Si el hueco cortara la losa no habría choque.

  - id: EV-16
    title: Ducto bajo cota de cielo
    dist: -0.080
    left:  { documentId: 4, modelFile: lin-cli, documentName: P2401-CLI.rvt, externalId: c-970, category: Revit Ducts, family: Ducto rectangular, type: Galvanizado, systemClassification: Supply Air, systemName: INY-FC-12, level: Piso 8, widthMm: 350, heightMm: 250, orientation: horizontal }
    right: { documentId: 2, modelFile: lin-arq, documentName: P2401_ARQ_TorreA.rvt, externalId: a-970, category: Revit Ceilings, family: Cielo continuo, type: Cielo yeso cartón 12.5, level: Piso 8, thicknessMm: 12.5 }
    expected: { ruleId: MA-005, validity: real, nature: hard, rootCause: routing_conflict, responsibleDiscipline: CLI, secondaryDiscipline: ARQ, severity: medium, band: P3 }
    notes: Subir en el entretecho; si no hay altura, ARQ decide bajar el cielo o hacer cajón.

  - id: EV-17
    title: Montante vertical sin pasada en losa
    dist: -0.075
    left:  { documentId: 3, modelFile: lin-san, documentName: P2401-SAN-TorreA.rvt, externalId: s-980, category: Revit Tuberías, family: Tubería PPR, type: PPR PN20, systemClassification: Domestic Hot Water, systemType: APC, systemName: APC MONTANTE 2, level: Piso 9, diameterMm: 75, orientation: vertical }
    right: { documentId: 1, modelFile: lin-est, documentName: P2401-SLF-ZZ-ZZ-M3-S-0001.rvt, externalId: e-980, category: Revit Floors, family: Suelo, type: Losa HA e=15, level: Piso 9, thicknessMm: 150 }
    expected: { ruleId: EST-009, validity: real, nature: hard, rootCause: missing_opening, responsibleDiscipline: EST, secondaryDiscipline: AP, severity: medium, band: P3 }
    notes: Falta la pasada en el modelo EST. El AP confirma medida y EST modela.

  - id: EV-18
    title: Roce de 4 mm entre ducto y viga
    dist: -0.004
    left:  { documentId: 4, modelFile: lin-cli, documentName: P2401-CLI.rvt, externalId: c-990, category: Revit Ducts, family: Ducto rectangular, type: Galvanizado, systemClassification: Supply Air, systemName: INY-3, level: Piso 3, widthMm: 300, heightMm: 200 }
    right: { documentId: 1, modelFile: lin-est, documentName: P2401-SLF-ZZ-ZZ-M3-S-0001.rvt, externalId: e-990, category: Revit Structural Framing, family: Viga HA Rectangular, type: V 25x50, level: Piso 3, widthMm: 250, heightMm: 500 }
    expected: { ruleId: TOL-003, validity: tolerated, responsibleDiscipline: COORD, severity: none, band: NONE }
    notes: Dentro de la tolerancia de 5 mm entre MEP y estructura.

  - id: EV-19
    title: Puerta no coincide con vano estructural
    dist: -0.150
    left:  { documentId: 2, modelFile: lin-arq, documentName: P2401_ARQ_TorreA.rvt, externalId: a-1000, category: Revit Puertas, family: Puerta simple, type: P1 90x210, level: Piso 1 }
    right: { documentId: 1, modelFile: lin-est, documentName: P2401-SLF-ZZ-ZZ-M3-S-0001.rvt, externalId: e-1000, category: Revit Walls, family: Muro básico, type: M HA e=20, level: Piso 1, widthMm: 200 }
    expected: { ruleId: AE-001, validity: real, nature: hard, rootCause: design_coordination, responsibleDiscipline: ARQ, secondaryDiscipline: EST, severity: high, band: P2 }
    notes: Coordinar el vano. En Chile el muro HA es sismorresistente; mover un vano requiere calculista.

  - id: EV-20
    title: Viga bajo cielo
    dist: -0.120
    left:  { documentId: 1, modelFile: lin-est, documentName: P2401-SLF-ZZ-ZZ-M3-S-0001.rvt, externalId: e-1010, category: Revit Structural Framing, family: Viga HA Rectangular, type: V 25x80, level: Piso 1, widthMm: 250, heightMm: 800 }
    right: { documentId: 2, modelFile: lin-arq, documentName: P2401_ARQ_TorreA.rvt, externalId: a-1010, category: Revit Techos, family: Cielo continuo, type: Cielo yeso cartón 12.5, level: Piso 1, thicknessMm: 12.5 }
    expected: { ruleId: AE-002, validity: real, nature: hard, rootCause: design_coordination, responsibleDiscipline: ARQ, secondaryDiscipline: EST, severity: high, band: P2 }
    notes: ARQ baja el cielo o hace cajón. Piso 1 = zona de acceso (zona 0.6).

  - id: EV-21
    title: Gas contra conduit eléctrico (10 mm)
    dist: -0.010
    left:  { documentId: 8, modelFile: lin-gas, documentName: P2401-GAS.rvt, externalId: g-1100, category: Revit Pipes, family: Tubería cobre, type: Cobre tipo L, systemClassification: Other, systemType: Gas natural, systemName: GN-1, level: Piso 2, diameterMm: 28 }
    right: { documentId: 6, modelFile: lin-ele, documentName: P2401-ELE.rvt, externalId: l-1100, category: Revit Conduits, family: Tubo conduit, type: EMT, level: Piso 2, diameterMm: 25 }
    expected: { ruleId: MM-003, validity: real, nature: hard, rootCause: routing_conflict, responsibleDiscipline: ELE, secondaryDiscipline: GAS, severity: high, band: P2 }
    notes: Gas con electricidad nunca se tolera, ni con 10 mm ni con conduit chico. La tolerancia GAS-ELE va antes que la de conduit.

  - id: EV-22
    title: Ducto grande por tabique F-120
    dist: -0.400
    left:  { documentId: 4, modelFile: lin-cli, documentName: P2401-CLI.rvt, externalId: c-1200, category: Revit Ducts, family: Ducto rectangular, type: Galvanizado, systemClassification: Exhaust Air, systemType: Extracción, systemName: EXT-COCINA, level: Piso 1, widthMm: 400, heightMm: 300 }
    right: { documentId: 2, modelFile: lin-arq, documentName: P2401_ARQ_TorreA.rvt, externalId: a-1200, category: Revit Muros, family: Muro básico, type: Tabique F-120 doble placa, level: Piso 1, widthMm: 150 }
    expected: { ruleId: MA-006, validity: real, nature: hard, rootCause: missing_opening, responsibleDiscipline: CLI, secondaryDiscipline: ARQ, severity: medium, band: P2 }
    notes: Requiere compuerta cortafuego o sello certificado F-120. Debe salir la etiqueta penetracion_mayor (400 mm). Severidad media, pero queda en P2 por tamaño, penetración y piso de acceso.

  - id: EV-23
    title: Sin regla específica (estanque contra muro cortina)
    dist: -0.090
    left:  { documentId: 2, modelFile: lin-arq, documentName: P2401_ARQ_TorreA.rvt, externalId: a-1300, category: Revit Equipos especializados, family: Estanque acumulación, type: 5 m3, level: Cubierta }
    right: { documentId: 10, modelFile: lin-fac, documentName: P2401-FAC-MuroCortina.rvt, externalId: f-1300, category: Revit Paneles de muro cortina, family: Panel de sistema, type: Vidrio DVH, level: Cubierta }
    expected: { ruleId: DEF-999, validity: real, rootCause: design_coordination, responsibleDiscipline: ARQ, severity: medium, band: P3 }
    notes: Va a revisión humana (confianza 0.4). El agente debe decir que no hay regla y proponer una.

  - id: EV-24
    title: Tubería por losa postensada
    dist: -0.110
    left:  { documentId: 7, modelFile: lin-inc, documentName: P2401-INC.rvt, externalId: i-1400, category: Revit Tuberías, family: Tubería acero, type: Acero ranurado, systemClassification: Fire Protection Wet, systemName: RH-MONTANTE, level: Subterráneo -2, diameterMm: 100, orientation: vertical }
    right: { documentId: 1, modelFile: lin-est, documentName: P2401-SLF-ZZ-ZZ-M3-S-0001.rvt, externalId: e-1400, category: Revit Floors, family: Suelo, type: Losa postensada e=20, level: Subterráneo -2, thicknessMm: 200 }
    expected: { ruleId: EST-003, validity: real, nature: hard, rootCause: missing_opening, responsibleDiscipline: INC, secondaryDiscipline: EST, severity: critical, band: P1 }
    notes: La postensada se impone a la regla general de pasada vertical (EST-009). Hay que coordinar con el trazado de cables antes de hormigonar.

  - id: EV-25
    title: Escalerilla invade zona de mantención de UMA
    dist: -0.200
    left:  { documentId: 4, modelFile: lin-cli, documentName: P2401-CLI.rvt, externalId: c-1500, category: Revit Modelos genéricos, family: Zona de mantención UMA, type: Frente 1200, level: Cubierta }
    right: { documentId: 6, modelFile: lin-ele, documentName: P2401-ELE.rvt, externalId: l-1500, category: Revit Bandejas de cables, family: Escalerilla portaconductores, type: Escalerilla 300x100, level: Cubierta, widthMm: 300, heightMm: 100 }
    expected: { ruleId: CLR-002, validity: real, nature: clearance, rootCause: design_coordination, responsibleDiscipline: ELE, secondaryDiscipline: CLI, severity: medium, band: P3 }
    notes: La zona de mantención es un modelo genérico, pero se reconoce por su nombre antes de la regla NI-001.
```

## Coverage

| Rule family | Scenarios |
|---|---|
| Duplicates (DUP) | EV-08, EV-09 |
| False positives (FP) | EV-02, EV-03, EV-15 |
| Tolerances and accepted practice (TOL) | EV-05, EV-06, EV-07, EV-18 |
| Clearance (CLR) | EV-25 |
| Needs info (NI) | EV-14 |
| Life safety (INC) | EV-10 |
| MEP vs structure (EST) | EV-01, EV-04, EV-13, EV-17, EV-24 |
| Architecture vs structure (AE) | EV-19, EV-20 |
| MEP vs architecture (MA) | EV-16, EV-22 |
| MEP vs MEP (MM) | EV-11, EV-12, EV-21 |
| No specific rule (DEF) | EV-23 |

Not covered here, and still needing unit tests: HYG-*, FP-003/004/005/006/007/009/011–015, SEI-001, TOL-001/002/004/009, NI-002, ELV-001, EST-005/006/007/008/010/011, AE-003–006, MA-001–004/007–012, MM-001/004–009, all annotations, and who-moves ties.

## Agent rubric (LLM)

Per scenario, 0 to 4 points:

- **Correct validity (2 points).** Confusing `real` with `false_positive` in either direction scores 0 for the whole scenario.
- **Correct responsible discipline (1 point).**
- **Severity within one level of the expected value (1 point).**

Also checked, without points:

- the rationale is in Spanish and names the cause;
- for EV-23, the agent asks for human review;
- for EV-08 and EV-09, the agent proposes one hygiene issue, not one per clash.

Pass mark: 85 of 100, with no false negatives on `critical` scenarios.
