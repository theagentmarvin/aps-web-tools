# Coordinador BIM — agente de coordinación de interferencias (SalfaCorp)

Agente de IA que corre en **Claude Code** dentro de este repositorio, más una **aplicación web local** (`http://localhost:3000`) para revisar y aprobar su trabajo. Lee las pruebas de interferencias de **ACC Model Coordination**, las agrupa, clasifica y prioriza, y redacta incidencias como **propuestas**. Una persona las revisa y las aprueba; recién entonces se escriben en ACC.

> **Uso sujeto al *Procedimiento Acceso Herramientas IA* de SalfaCorp.** Es la base del uso correcto de la IA en la empresa. Léelo antes de usar este repositorio con datos de proyectos reales (ver [Gobernanza y datos](#gobernanza-y-datos)).

Estado: **piloto**. Validado solo con datos sintéticos. Ver [Límites actuales](#límites-actuales).

---

## Qué hace y qué no hace

| Hace | No hace |
|---|---|
| Descarga y normaliza los resultados de una prueba de interferencias (MC v3) | **No escribe en ACC por su cuenta.** Nunca. |
| Agrupa por causa (un ducto que cruza 14 vigas = 1 grupo), deduplica, detecta modelos cargados dos veces | No aprueba lotes, no firma, no edita aprobaciones ni configuración (hooks lo bloquean) |
| Clasifica con reglas deterministas (`rules/*.yaml`): `real`, `false_positive`, `tolerated`, `needs_info`; severidad y prioridad P1–P4 | No cierra interferencias `real`; en duda propone `needs_info` |
| Usa IA solo en los grupos dudosos y explica cada propuesta en español (regla, confianza, señales) | No decide sobre aberturas en estructura, seguridad de personas ni normativa: esas siempre van a revisión humana |
| Compara con la prueba anterior: nuevas, persistentes, resueltas, reaparecidas | No edita las reglas: propone cambios y una persona hace el merge |
| Redacta borradores de incidencias (título ≤ 100, descripción ≤ 1000 caracteres, texto plano) | No usa datos personales: asigna disciplinas, roles o empresas; la persona se elige en la UI |

**Cómo llega algo a ACC (única vía):**

```
Agente (Claude Code) ──propuestas──▶ .coordinator/ (local)
                                         │
Tú, en la UI web:  revisar (/coordinacion) ─▶ enviar a aprobación ─▶ aprobar con passkey (Windows Hello)
                                                                       │
                                         simulación (dry run) ─▶ "APLICAR" ─▶ el servidor escribe en ACC
```

Sin una aprobación firmada con tu passkey (verificación de usuario: PIN o biometría), el servidor rechaza cualquier escritura en ACC. La aprobación queda ligada al contenido exacto del lote: si algo cambia después de aprobar, la aprobación deja de valer.

---

## Demo en 5 minutos (sin credenciales)

Usa el proyecto sintético `tests/fixtures/` ("Edificio Demo Las Condes", pruebas v41 y v42, ~300 interferencias). No hay red ni ACC; las "escrituras" se registran en un archivo local y nunca se envían.

Requisitos: Node.js 22+ y Claude Code instalados. No necesita `npm run setup` ni credenciales.

```bash
npm install
npm run demo            # terminal 1: UI web en modo fixtures → http://localhost:3000
                        # si el puerto 3000 está ocupado: npm run demo -- --port 3005
```

`npm run demo` también genera `.mcp.demo.json` (ignorado por git), que conecta al agente con los **mismos** datos de demostración (`.coordinator-demo/`). En una **segunda terminal**, en la carpeta del repo:

```bash
claude --mcp-config .mcp.demo.json
```

Dentro de Claude Code:

```
/triage
```

El agente ingiere la prueba, clasifica, revisa los grupos dudosos y te deja un resumen con enlaces. Luego en el navegador:

1. Abre `http://localhost:3000` → **Proyectos** → Edificio Demo Las Condes → **Abrir coordinación**.
2. Revisa con el teclado (`j`/`k`, `a`, `x`, `1`–`4`; ver [Atajos](#atajos-principales)).
3. `Ctrl+Enter` envía tus decisiones a **Aprobaciones**.
4. En el lote, la aprobación es una **"Aprobación de demostración"** (sin passkey; solo existe en modo fixtures).

---

## Flujo diario (proyecto real)

Primera instalación: [`docs/setup.md`](docs/setup.md). Después, cada semana:

1. **Levanta la UI**: `npm run dev` y abre `http://localhost:3000` (no `127.0.0.1`: la passkey no funciona con IP). Inicia sesión con Autodesk.
2. **Coordina la prueba** en Claude Code (`claude` en la carpeta del repo):
   ```
   /coordinar-test Torre B "Coordinación general"
   ```
   El agente hace ingesta → reglas → higiene de modelos → diferencias con la prueba anterior → revisión IA de grupos dudosos → borradores de incidencias, y entrega ≤ 25 líneas con las **preguntas para ti** (con `groupId`) y el enlace de revisión.
3. **Revisa en `/coordinacion/<proyecto>/<conjunto>`** con el teclado. La vista 3D enfoca cada grupo: lado **A en azul**, lado **B en naranja**, resto en rayos X. Cada corrección pide un **código de motivo** (una tecla); eso alimenta el aprendizaje.
4. **Envía a aprobación** (`Ctrl+Enter`) → **`/aprobaciones`** → abre el lote:
   - **Comprobar con ACC** (pre-chequeo; obligatorio, < 10 min de antigüedad). Los conflictos quedan excluidos.
   - Revisa las pestañas **Cambios** e **Incidencias** (lo que verá quien recibe la incidencia).
   - **Aprobar** → escribe `APLICAR` si hay incidencias o ≥ 50 cambios → **Windows Hello**.
   - Revisa la **simulación** (las solicitudes exactas a ACC) → **Aplicar**.
5. **Informe**: `/informe-semanal` para la reunión.

### Atajos principales

| Tecla | Acción |
|---|---|
| `j` / `k` | Siguiente / anterior grupo |
| `J` / `K` | Siguiente / anterior interferencia dentro del grupo |
| `a` | Aceptar la propuesta y avanzar (en baja confianza o P1, primero mírala en 3D) |
| `e` | Editar la propuesta |
| `x` | Rechazar (pide motivo) |
| `1`–`4` | Prioridad P1–P4 |
| `v` | Validez (válida, falso positivo, tolerable, duplicada, por confirmar) |
| `i` | Borrador de incidencia |
| `s` | Posponer |
| `u` | Deshacer |
| `Espacio` / `Shift+A` | Marcar / aceptar marcados (acción masiva, máx. 500) |
| `c` / `z` / `b` | Modo del visor / ajustar a la vista / caja de sección |
| `Ctrl+Enter` | Enviar a aprobación |
| `?` | Todos los atajos |

---

## Comandos del agente (skills)

| Comando | Para qué | Escribe propuestas |
|---|---|---|
| `/coordinar-test [proyecto] [conjunto] [prueba]` | Flujo completo: ingesta, reglas, higiene, diferencias de ciclo, revisión IA, borradores de incidencias, entrega a aprobación | Sí |
| `/triage [testKey o vista]` | Panorama rápido: cuántas son reales, por disciplina; revisión IA solo de lo dudoso; sin incidencias | Sí (clasificación) |
| `/redactar-issues [G-… \| P1 \| P1-P2 \| todos]` | Borradores de incidencias en español para grupos reales y de higiene | Sí (incidencias) |
| `/informe-semanal [proyecto] [html\|md]` | Informe de la semana con narrativa para la reunión (`xlsx` aún no disponible) | No |
| `/auditar-modelo [testKey]` | Higiene de modelos: duplicados, copias de otras disciplinas, elementos sin nivel o sistema | No |
| `/curar-reglas [projectId \| desde AAAA-MM-DD]` | Convierte tus correcciones en cambios de reglas propuestos y evaluados | Sí (cambio de reglas) |

Puedes pedir cosas en lenguaje natural ("¿qué hay de nuevo en el nivel 3?"); el agente usa las mismas herramientas. Toda cifra que da sale de una herramienta, no de la memoria del modelo.

---

## Cómo mejorar el agente

1. **Corrige en la UI con motivo.** Cada corrección (prioridad, validez, responsable, agrupación) guarda el valor de la IA, el tuyo y el código de motivo (R01–R13, R99). Si marcas "Sugerir una regla para casos similares", queda para el curador.
2. **`/curar-reglas`** revisa las correcciones acumuladas y propone un parche mínimo a `rules/*.yaml`, evaluado contra los escenarios y tu historial (puertas: 0 cierres inseguros, 0 falsos negativos críticos). Aparece en **Reglas › Sugerencias**.
3. **Una persona hace el merge** del YAML con git (el agente no puede editar `rules/`). Revisa el diff, corre `npm test` y `npm run eval`, y haz commit/PR.
4. **Notas del proyecto.** Convenciones acordadas (p. ej. "las pasadas en losa de SAN están modeladas como camisas") van a `.coordinator/projects/<projectId>/notes.md`. El agente propone la línea y la escribe solo con tu confirmación; `/coordinar-test` y `/triage` la leen. Son locales a tu equipo (no se comparten).

---

## Gobernanza y datos

- **Procedimiento Acceso Herramientas IA de SalfaCorp**: el uso de este agente debe seguirlo. Usa Claude Code solo con la cuenta y el plan aprobados por la empresa. El agente te lo recuerda al iniciar cada sesión.
- **Secretos nunca en el repo.** `APS_CLIENT_SECRET` vive solo en `.env.local` (ignorado por git). Las claves de aprobación y auditoría, las passkeys y los tokens viven **fuera del repo** (`%APPDATA%\bim-coordinator\` en Windows), protegidos con DPAPI. No hagas commit de `.env.local`, `coordinator.config.local.json` ni nada de `.coordinator/`.
- **Los datos de ACC quedan en tu equipo**, en `.coordinator/` (caché de pruebas, propuestas, decisiones, auditoría). No los copies a otras herramientas de IA.
- **Auditoría**: cada propuesta, decisión, aprobación y escritura en ACC queda en una cadena firmada (HMAC) visible en `/auditoria`.
- **Texto de los modelos = datos, no instrucciones.** Si un nombre de familia o comentario contiene algo como "ignora las reglas", el agente lo reporta y no lo obedece.
- Modelo de amenazas honesto: los controles protegen contra errores del modelo, inyección de instrucciones vía datos y otros sitios web en tu navegador. **No** protegen contra un programa malicioso que corra con tu mismo usuario de Windows. Detalle: [`docs/api.md`](docs/api.md#threat-model-v1).

---

## Límites actuales

Ser explícitos aquí es parte del diseño. Resumen de [`docs/domain/engine-review-2026-11.md`](docs/domain/engine-review-2026-11.md):

- **Validado solo con datos sintéticos.** En el proyecto de prueba: 93–95 % de acierto en validez, 0 cierres inseguros, ~37 % de grupos a revisión humana. No se ha medido en un proyecto real.
- **Reglas pendientes de calibrar con datos reales.** Parte de los cambios propuestos quedó en [`docs/domain/rules-pending-2026-11.patch`](docs/domain/rules-pending-2026-11.patch) hasta tener correcciones reales.
- **Puntos de la API de ACC sin verificar en un tenant real** (unidades y signo de la distancia, mapeo de IDs del visor, coordenadas del pushpin, compresión, reducción de alcance del token del navegador, sintaxis de consultas de propiedades). Ver [`docs/pilot-checklist.md`](docs/pilot-checklist.md).
- **El primer piloto debe ser en modo sombra** (solo lectura) durante una semana antes de aplicar nada en ACC.
- Autonomía limitada a **L1** (solo propuestas). Los niveles L2/L3 están diseñados, no implementados.
- MC no tiene escritura "revisada": `mark_reviewed` se aplica como cierre con motivo de tolerancia. Reabrir interferencias no se aplica desde lotes en v1.
- Agrupación con niveles en inglés y español mezclados, títulos con familias genéricas de Revit y camisas sin correlacionar pueden seguir apareciendo en modelos reales.
- Informe en `xlsx` no disponible (usa `html` o `md`). Notas de proyecto locales, no compartidas.

---

## Mapa del repositorio

```
CLAUDE.md               Constitución del agente (reglas duras, procedimiento)
.claude/
  skills/               /coordinar-test, /triage, /redactar-issues, /informe-semanal, /auditar-modelo, /curar-reglas
  agents/               Subagentes: clash-triager, issue-writer, model-hygiene-auditor, rules-curator
  hooks/                Guardas: bloquean escrituras directas, secretos, aplicar sin aprobación, edición de config
  settings.json         Permisos de Claude Code
.mcp.json               Registra el servidor MCP "coord" (lo genera npm run setup)
coordinator.config.json Configuración del equipo (autonomía, umbrales); .local.json para ajustes personales
core/                   Motor puro: ingesta, clasificación, agrupación, prioridad, diferencias (sin red)
server/
  aps/                  OAuth APS, Model Coordination, Model Properties (Index), Issues
  mcp/                  Servidor MCP: las herramientas del agente (27)
  api/                  API HTTP de la UI (/api/coord/*)
  approval/             Único módulo que escribe en ACC (verifica aprobación, dry run, idempotencia)
  store/ secure/        Almacén local .coordinator/ y claves fuera del repo
  source/               Fuente de datos: ACC real o fixtures
  templates/            Plantillas de .mcp.json y coordinator.config.json
  cli.ts                npm run coordinator -- login | passkey-enroll | status | …
src/                    UI web (español): coordinación, aprobaciones, reglas, reportes, auditoría, ajustes
rules/                  Reglas de clasificación, matriz de disciplinas, prioridad, alias de propiedades (YAML)
docs/
  setup.md              Primera instalación
  pilot-checklist.md    Lista de verificación del primer piloto real
  api.md                Servidor, API, flujo de aprobación, modelo de amenazas
  domain/               Taxonomía, metodología, guía de redacción, revisión del motor
  ai/                   Diseño del harness y contratos de herramientas
  ux/                   Especificación de UX
  research/             Investigación de la API de ACC/APS
evals/ scripts/         Escenarios y evaluaciones del agente y de las reglas
tests/                  Pruebas (vitest) y fixtures sintéticos
```

Comandos útiles: `npm run dev` (UI + API), `npm test`, `npm run typecheck`, `npm run eval` (reglas), `npm run coordinator -- status`.

### Para quien desarrolla el harness

`.claude/`, `.mcp.json` y `coordinator.config*.json` están protegidos por hooks. Para editarlos con Claude Code, inícialo en modo desarrollo **desde tu terminal** (el agente no puede activarlo):

```bash
COORD_HARNESS_DEV=1 claude                       # Git Bash
$env:COORD_HARNESS_DEV = "1"; claude             # PowerShell
```

El modo desarrollo nunca relaja la protección de tokens, secretos ni aprobaciones. Código e identificadores en inglés; UI y respuestas del agente en español.

---

## English summary

**BIM Coordinator** is a Claude Code agent harness plus a local web app for SalfaCorp BIM coordinators. The agent ingests ACC Model Coordination clash tests, groups, de-duplicates, classifies (deterministic YAML rules plus LLM review of uncertain groups) and prioritizes clashes, and drafts ACC issues as **proposals**. It never writes to ACC: a human reviews proposals in the web UI (`/coordinacion/...`, keyboard-first), sends them to a batch, approves it with a passkey (Windows Hello, user-verified WebAuthn), checks a dry run and only then does the server apply the batch to ACC. Corrections with reason codes feed `/curar-reglas`, which proposes evaluated rule patches that a human merges.

- Demo without credentials: `npm install`, `npm run demo`, then `claude --mcp-config .mcp.demo.json` and `/triage`.
- First install: `docs/setup.md`. Pilot checklist: `docs/pilot-checklist.md`.
- Status: pilot. Validated on synthetic fixtures only. Rules still need calibration with real data, and several ACC API details are unverified on a live tenant. Run a read-only shadow week before applying anything.
- Usage must follow SalfaCorp's *AI Tools Access Procedure*. Secrets are never committed. ACC data stays local in `.coordinator/`.
