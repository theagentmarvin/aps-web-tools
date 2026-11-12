# Qué sigue y flujos

Responsable: especialista IA. Fecha: 2026-11-11 (WS-N). Código: `server/next-steps.ts`, `server/flows/`,
`src/features/flows/`. Agentes: `agent-runtime/agents/coordinador-flujos.md` y `coordinador-chat.md`
(viajan con la app; WS-S).

El uso de la app y del agente se rige por el *Procedimiento Acceso Herramientas IA* de SalfaCorp.

## Para qué sirve

El coordinador no tiene que memorizar comandos. La app sabe en qué punto del ciclo semanal está cada proyecto
y **sugiere el siguiente paso**. Cada sugerencia es de uno de dos tipos:

- **Trabajo del agente** (botón **Ejecutar**): la app corre un *flujo* —un procedimiento de
  `agent-runtime/skills/`— y deja propuestas, preguntas, borradores de incidencia, sugerencias de reglas o un informe.
- **Tu decisión** (botón **Abrir**): la app te lleva a la pantalla donde decides tú (responder preguntas,
  «Enviar a aprobación», aprobar el lote con passkey, aplicarlo, publicar reglas).

Las sugerencias las calcula el servidor **solo con su estado** (versiones en caché, clasificación, propuestas,
preguntas, decisiones, lotes, notas de reunión, verificación de incidencias, higiene, correcciones, informes y
flujos ya corridos). No hay IA en ese cálculo: el mismo estado da siempre los mismos pasos.

Dónde se ven:

- tarjeta **Qué sigue** en la página del proyecto (`/proyectos/:id`), hasta 3 pasos;
- botón **Flujos** en la barra superior: abre un panel con «Qué sigue» del proyecto abierto, el flujo en curso
  (avance en vivo, cancelar) y el historial;
- en el **chat**: si preguntas «¿qué sigue?» (o al empezar una conversación), el agente consulta los pasos y
  los muestra como tarjetas con su botón; también puede iniciar el flujo si se lo pides o lo aceptas;
- el flujo `preparar-ciclo` cierra su resumen con los 3 pasos siguientes (`mcp__coord__get_next_steps`).

## Qué sugiere la app y por qué

Orden por prioridad (menor = más urgente). Umbrales en `server/next-steps.ts` (`THRESHOLDS`).

| Paso | Cuándo aparece | Acción |
|---|---|---|
| Preparar el ciclo de vN | ACC tiene una versión del conjunto de modelos más nueva que la última analizada, o el proyecto no tiene ninguna | flujo `preparar-ciclo` |
| Clasificar vN | La versión está descargada pero sin clasificar | flujo `preparar-ciclo` |
| Aplicar el lote / revisar fallas | Lote aprobado con passkey y sin aplicar, o aplicado parcialmente | abrir `/aprobaciones/:id` |
| Llevar el lote a vN | Lote armado sobre una versión anterior a la última | abrir `/aprobaciones/:id` («Llevar decisiones a vN») |
| Aprobar el lote | Lote listo para revisión | abrir `/aprobaciones/:id` |
| Enviar a aprobación | Hay decisiones aceptadas (grupos o ubicaciones) que todavía no están en un lote | abrir la coordinación |
| Responder preguntas del agente | Hay preguntas abiertas | abrir la coordinación |
| Verificar incidencias | Incidencias que dicen «resuelta» con interferencias vigentes, o P1 estancadas ≥ 2 versiones | abrir la lente Incidencias |
| Pasar el acta | Notas de reunión escritas después del último procesamiento (sin propuesta ni pregunta posterior del agente sobre ese grupo, y sin un flujo `acta` posterior) | flujo `acta` |
| Revisión IA de N ubicaciones | Ubicaciones que el motor marcó para revisión humana y que no tienen propuesta ni pregunta del agente | flujo `triage` |
| Redactar N incidencias P1–P2 | Ubicaciones reales P1–P2 sin borrador de incidencia, sin decisión de grupo con incidencia y sin incidencia en ACC | flujo `redactar-issues` |
| Asignar disciplina a documentos | Documentos sin disciplina (SIN) que afectan ≥ 10 interferencias | abrir Disciplinas |
| Revisar sugerencias de reglas | Sugerencias pendientes o aprobadas sin publicar | abrir Reglas › Sugerencias pendientes |
| Auditar higiene del modelo | ≥ 20 interferencias de elementos duplicados o copiados | flujo `auditar-modelo` |
| Curar reglas | ≥ 5 correcciones sin curar o ≥ 20 interferencias sin regla (DEF-999) en la versión | flujo `curar-reglas` |
| Generar el informe semanal | El ciclo ya tiene lote (o nada pendiente de revisión) y no tiene informe semanal | flujo `informe-semanal` |

Un flujo que terminó bien para la misma versión en las últimas 24 h no se vuelve a sugerir (evita repetir
la revisión si el agente decidió no proponer nada).

## Flujos disponibles

| Flujo | Skill | Qué hace | Qué deja | Tope |
|---|---|---|---|---|
| `preparar-ciclo` | preparar-ciclo | Ingesta y clasificación de la última versión, cambios de alcance, revisión IA de lo que cambió, preguntas, verificación de incidencias | Propuestas, preguntas, ≤ 3 sugerencias de reglas | USD 3 · 30 min |
| `triage` | triage | Revisión IA de las ubicaciones que requieren revisión humana (subagente clash-triager) | Propuestas y preguntas | USD 2 · 20 min |
| `acta` | acta | Notas de reunión → borradores de decisión por grupo; lo ambiguo se pregunta | Borradores y preguntas | USD 1 · 10 min |
| `redactar-issues` | redactar-issues | Borradores de incidencia para reales P1–P2 (subagente issue-writer) | Borradores de incidencia | USD 2 · 20 min |
| `informe-semanal` | informe-semanal | Informe semanal con cifras del servidor y narrativa | Un archivo de informe | USD 1 · 10 min |
| `auditar-modelo` | auditar-modelo | Auditoría de higiene (subagente model-hygiene-auditor) | Hallazgos; sugerencias de disciplina | USD 1 · 10 min |
| `curar-reglas` | curar-reglas | Reglas nuevas, calibraciones, retiros o restauraciones con evidencia (subagente rules-curator) | Sugerencias de reglas | USD 2 · 20 min |

Cómo corre un flujo: el servidor lanza Claude Code sin interfaz (igual que el chat) con el agente
`coordinador-flujos` y el procedimiento de la skill, en la carpeta privada donde materializa `agent-runtime/`
(`%LOCALAPPDATA%\bim-coordinator\agent-runtime\<hash>\`; ver `docs/ai/harness-design.md` §1.1). Un solo flujo por proyecto a la vez. El avance se ve en vivo
(narración en español, sin preámbulos), se puede cancelar, y queda guardado en `<datos>/flows/<runId>.json`
con su registro de eventos. La auditoría registra `flow.started`, `flow.finished` y `flow.cancelled` con quién lo
inició (tú o el chat), sin nombres de personas.

## Qué puede y qué no puede hacer el agente

**Puede** (dentro de la app):

- calcular y mostrar qué sigue;
- iniciar desde el chat un flujo del catálogo cuando lo pides o lo aceptas (máximo 10 por día, configurable en
  `flows.dailyAgentCap`; un flujo por proyecto);
- crear propuestas, preguntas, borradores de incidencia, sugerencias de disciplina y de reglas, e informes.

**Nunca puede** (no tiene herramientas para eso; los tests lo verifican):

- cambiar la app: código, el agente (`agent-runtime/`), las reglas directamente, la configuración ni los hooks
  (las mejoras se piden en VS Code, modo desarrollo);
- hacer lo que firma un humano: aprobar o firmar lotes, publicar o revertir reglas, restaurar o importar datos;
- escribir en ACC: solo `apply_approved_proposals` sobre un lote **aprobado por un humano**, y nunca desde el chat
  ni desde un flujo;
- lanzar flujos desde un subagente o desde otro flujo (sin recursión).

Lo que deja un flujo se decide en la UI como siempre: aceptar propuestas, «Enviar a aprobación», aprobar el lote
con passkey, publicar reglas en Reglas.

## El agente viaja con la app

Los flujos usan el agente `coordinador-flujos` de `agent-runtime/agents/`, que es parte del código de la app: no
hay paso de instalación ni de actualización. Al iniciar (y antes de cada flujo) el servidor lo copia, verificado,
a su carpeta privada. Si faltara, la app responde «Los flujos no están disponibles: … reinicia la app» y nunca usa
otro agente en su lugar.
