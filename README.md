# Coordinador BIM — agente de coordinación de interferencias (SalfaCorp)

**Aplicación web local** (`http://localhost:3000`) con un **agente de coordinación integrado** (chat y flujos, Claude Code sin interfaz lanzado por la app) para revisar y aprobar su trabajo. El repositorio, abierto en VS Code, es además el **modo desarrollo**: ahí le pides a Claude mejoras de la app o del agente. Lee las pruebas de interferencias de **ACC Model Coordination**, las agrupa, clasifica y prioriza, y redacta incidencias como **propuestas**. Una persona las revisa y las aprueba; recién entonces se escriben en ACC.

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
Agente de la app (chat / flujos) ──propuestas──▶ carpeta de datos (local)
                                         │
Tú, en la UI web:  revisar (/coordinacion) ─▶ enviar a aprobación ─▶ aprobar con passkey (Windows Hello)
                                                                       │
                                         simulación (dry run) ─▶ "APLICAR" ─▶ el servidor escribe en ACC
```

Sin una aprobación firmada con tu passkey (verificación de usuario: PIN o biometría), el servidor rechaza cualquier escritura en ACC. La aprobación queda ligada al contenido exacto del lote: si algo cambia después de aprobar, la aprobación deja de valer.

---

## Demo en 5 minutos (sin credenciales)

Usa el proyecto sintético `tests/fixtures/` ("Edificio Demo Las Condes", pruebas v41 y v42, ~300 interferencias). No hay red ni ACC; las "escrituras" se registran en un archivo local y nunca se envían.

Requisitos: Node.js 22+ y Claude Code instalados (con sesión iniciada para el chat y los flujos). Sin credenciales de Autodesk.

```bash
npm install
npm run demo            # UI web en modo fixtures → http://localhost:3000
                        # si el puerto 3000 está ocupado: npm run demo -- --port 3005
```

En la página del proyecto, la tarjeta **Qué sigue** propone «Preparar el ciclo» → **Ejecutar** (o pídeselo al
**chat**). El agente de la app ingiere la prueba, clasifica, revisa los grupos dudosos y deja propuestas y
preguntas. Luego en el navegador:

1. Abre `http://localhost:3000` → **Proyectos** → Edificio Demo Las Condes → **Abrir coordinación**.
2. Revisa con el teclado (`j`/`k`, `a`, `x`, `1`–`4`; ver [Atajos](#atajos-principales)).
3. `Ctrl+Enter` envía tus decisiones a **Aprobaciones**.
4. En el lote, la aprobación es una **"Aprobación de demostración"** (sin passkey; solo existe en modo fixtures).

---

## Flujo diario (proyecto real)

Primera instalación: [`docs/setup.md`](docs/setup.md). Después, cada semana:

1. **Abre la app**: doble clic en `Coordinador BIM.cmd` (o `npm run dev`) y abre `http://localhost:3000` (no `127.0.0.1`: la passkey no funciona con IP). Inicia sesión con Autodesk.
2. **Prepara el ciclo**: en el proyecto, **Qué sigue → Preparar el ciclo → Ejecutar** (o pídelo en el chat). El agente de la app hace ingesta → reglas → higiene → diferencias con la versión anterior → revisión IA de lo que cambió, y deja propuestas y **preguntas para ti**.
3. **Revisa en `/coordinacion/<proyecto>/<conjunto>`** con el teclado. La vista 3D enfoca cada grupo: lado **A en azul**, lado **B en naranja**, resto en rayos X. Cada corrección pide un **código de motivo** (una tecla); eso alimenta el aprendizaje.
4. **Envía a aprobación** (`Ctrl+Enter`) → **`/aprobaciones`** → abre el lote:
   - **Comprobar con ACC** (pre-chequeo; obligatorio, < 10 min de antigüedad). Los conflictos quedan excluidos.
   - Revisa las pestañas **Cambios** e **Incidencias** (lo que verá quien recibe la incidencia).
   - **Aprobar** → escribe `APLICAR` si hay incidencias o ≥ 50 cambios → **Windows Hello**.
   - Revisa la **simulación** (las solicitudes exactas a ACC) → **Aplicar**.
5. **Informe**: flujo **Informe semanal** para la reunión.

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

## Flujos del agente de la app

Se ejecutan desde **Qué sigue** / **Flujos** o pidiéndolos en el chat ([detalle](docs/domain/next-steps-and-flows.md)):

| Flujo | Para qué | Deja |
|---|---|---|
| Preparar el ciclo | Ingesta, reglas, higiene, diferencias de ciclo, revisión IA de lo que cambió, preguntas | Propuestas, preguntas |
| Triage | Revisión IA de lo que el motor marcó para revisión humana | Propuestas, preguntas |
| Acta | Notas de reunión → borradores de decisión | Borradores, preguntas |
| Redactar incidencias | Borradores en español para reales P1–P2 | Borradores de incidencia |
| Informe semanal | Informe con narrativa para la reunión (`xlsx` aún no disponible) | Un informe |
| Auditar modelo | Higiene: duplicados, copias, elementos sin nivel o sistema | Hallazgos |
| Curar reglas | Correcciones → reglas nuevas, calibraciones, retiros | Sugerencias de reglas |

En el chat puedes preguntar en lenguaje natural ("¿qué hay de nuevo en el nivel 3?"). Toda cifra sale de una herramienta, no de la memoria del modelo. El agente de la app nunca cambia la app.

---

## Cómo mejorar el agente

1. **Corrige en la UI con motivo.** Cada corrección (prioridad, validez, responsable, agrupación) guarda el valor de la IA, el tuyo y el código de motivo (R01–R13, R99). Si marcas "Sugerir una regla para casos similares", queda para el curador.
2. **Flujo Curar reglas** revisa las correcciones acumuladas y propone cambios a las reglas, evaluados contra los escenarios y tu historial (puertas: 0 cierres inseguros, 0 falsos negativos críticos). Aparecen en **Reglas › Sugerencias**, donde tú los apruebas y **publicas con passkey**.
3. **Notas del proyecto.** Convenciones acordadas (p. ej. "las pasadas en losa de SAN están modeladas como camisas") van a `projects/<projectId>/notes.md` en tu carpeta de datos; los flujos las leen. Son locales a tu equipo.
4. **Mejorar la app o el agente en sí** (instrucciones, nuevas pantallas, nuevos flujos): abre el repo en VS Code y pídeselo a Claude (`/mejorar`). Ver [modo desarrollo](docs/setup.md#8-mejorar-la-app-o-el-agente-vs-code-modo-desarrollo).
5. **Subir el cambio:** cada mejora va en su propia rama y se sube como **Pull Request** a `main`; el dueño del repo
   revisa y hace el merge. Reglas completas (para personas y para Claude): [CONTRIBUTING.md](CONTRIBUTING.md).

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
agent-runtime/          Agente de la app (chat y flujos): CLAUDE.md, agents/, skills/, hooks/, settings.json.
                        Viaja con la app; el servidor lo copia a %LOCALAPPDATA%\bim-coordinator\agent-runtime\ al iniciar
dev-harness/            Modo desarrollo (VS Code): CLAUDE.md, .claude/ (guardas mínimas, /mejorar), .mcp.json;
                        se activa una vez con scripts/activate-dev-harness.ps1 → CLAUDE.md, .claude/, .mcp.json
coordinator.config.json Configuración del equipo (autonomía, umbrales); .local.json para ajustes personales
core/                   Motor puro: ingesta, clasificación, agrupación, prioridad, diferencias (sin red)
server/
  aps/                  OAuth APS, Model Coordination, Model Properties (Index), Issues
  mcp/                  Servidor MCP: las herramientas del agente (27)
  api/                  API HTTP de la UI (/api/coord/*)
  approval/             Único módulo que escribe en ACC (verifica aprobación, dry run, idempotencia)
  store/ secure/        Almacén local .coordinator/ y claves fuera del repo
  source/               Fuente de datos: ACC real o fixtures
  templates/            Valores por defecto de coordinator.config.json
  agent-runtime.ts      Copia verificada del agente de la app a su carpeta privada
  chat/ flows/          Chat y flujos (lanzan claude -p con el agente de la app)
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

### Modo desarrollo (VS Code)

Abrir el repo en VS Code (o `claude` en la carpeta) es el **agente de desarrollo**: implementa mejoras de la app
o del agente de la app, corre typecheck y tests y hace commit cuando estás de acuerdo (`/mejorar`). Se activa una
vez, en tu terminal: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\activate-dev-harness.ps1`.
Trabaja con fixtures; no lee datos reales, respaldos ni secretos y nunca aplica en ACC. Las invariantes de
seguridad de la app las vigilan los tests. Diseño: [`docs/ai/harness-design.md`](docs/ai/harness-design.md).
Código e identificadores en inglés; UI y respuestas del agente en español.

---

## English summary

**BIM Coordinator** is a local web app with an embedded coordination agent (chat + flows: headless Claude Code launched by the server from `agent-runtime/`) for SalfaCorp BIM coordinators; the repo opened in VS Code is a separate developer agent (`dev-harness/`). The agent ingests ACC Model Coordination clash tests, groups, de-duplicates, classifies (deterministic YAML rules plus LLM review of uncertain groups) and prioritizes clashes, and drafts ACC issues as **proposals**. It never writes to ACC: a human reviews proposals in the web UI (`/coordinacion/...`, keyboard-first), sends them to a batch, approves it with a passkey (Windows Hello, user-verified WebAuthn), checks a dry run and only then does the server apply the batch to ACC. Corrections with reason codes feed the "Curar reglas" flow, which proposes evaluated rule changes that a human publishes with a passkey.

- Demo without credentials: `npm install`, `npm run demo`, then run the "Preparar el ciclo" flow from "Qué sigue" or the chat.
- First install: `docs/setup.md`. Pilot checklist: `docs/pilot-checklist.md`.
- Status: pilot. Validated on synthetic fixtures only. Rules still need calibration with real data, and several ACC API details are unverified on a live tenant. Run a read-only shadow week before applying anything.
- Usage must follow SalfaCorp's *AI Tools Access Procedure*. Secrets are never committed. ACC data stays local in `.coordinator/`.
