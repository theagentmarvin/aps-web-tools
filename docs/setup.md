# Instalación inicial

Guía paso a paso para dejar el Coordinador BIM funcionando contra ACC real en el equipo de un coordinador. Toma unos 30 minutos más lo que demore el administrador de ACC.

> Antes de empezar: el uso de este agente se rige por el *Procedimiento Acceso Herramientas IA* de SalfaCorp. Usa Claude Code solo con la cuenta y el plan aprobados por la empresa.

Para probar sin credenciales, usa la demo del [README](../README.md#demo-en-5-minutos-sin-credenciales) y salta esta guía.

## 0. Requisitos

- Windows 10/11 con **Windows Hello** configurado (PIN, huella o rostro). Se usa para firmar las aprobaciones.
- Node.js 22 o superior y git.
- Claude Code instalado y con sesión iniciada en la cuenta corporativa.
- Navegador Chrome o Edge actualizado.
- Una cuenta Autodesk con acceso al proyecto en ACC y permisos en las carpetas de los modelos (ver: Model Set Read; para cerrar o asignar interferencias: Model Set Edit).
- Acceso a la consola de APS (`https://aps.autodesk.com/myapps`) o alguien que cree la app por ti.

```bash
git clone <url-del-repo> coordinador-bim
cd coordinador-bim
npm install
```

## 1. Crear la app en APS

Una app por equipo de coordinación es suficiente. La crea quien tenga acceso a la consola APS de SalfaCorp.

1. En `https://aps.autodesk.com/myapps` → **Create application**.
2. Tipo: **Traditional Web App** (permite el secreto del cliente junto con PKCE; es el tipo recomendado).
3. **Callback URLs** — registra exactamente estas dos (deben coincidir carácter por carácter):
   - `http://localhost:8765/callback` — inicio de sesión del agente y del servidor (CLI y botón de la UI).
   - `http://localhost:3000/auth/callback` — inicio de sesión del visor en el navegador.
4. **Acceso a APIs**: habilita las APIs de Autodesk Construction Cloud / BIM 360 (Model Coordination, Issues), Data Management y Model Derivative (los nombres exactos dependen de la consola).
5. **Scopes**: no se configuran en la app; los pide la aplicación al iniciar sesión:
   - Agente y servidor: `data:read data:write data:create user-profile:read` (este último identifica quién revisa y aprueba).
   - Navegador: `data:read viewables:read` (solo lectura, para el visor 3D).
6. Copia el **Client ID** y el **Client Secret**. El secreto se trata como contraseña: no lo pegues en chats, correos ni en el repo.

## 2. Registrar la app en ACC (administrador de la cuenta)

Sin este paso, **toda** llamada a ACC responde **403**.

Pide a un **Account Admin de ACC** que agregue el Client ID en **Account Admin → Custom Integrations** (Integraciones personalizadas), con acceso a Document Management y Model Coordination para los proyectos del piloto. Envíale solo el Client ID, nunca el secreto.

## 3. Crear `.env.local`

```bash
cp .env.example .env.local
```

Edita `.env.local` (está ignorado por git; nunca lo subas):

```bash
# Obligatorias
VITE_APS_CLIENT_ID=<client id>
APS_CLIENT_SECRET=<client secret>                       # sin prefijo VITE_: nunca llega al navegador
VITE_APS_CALLBACK_URL=http://localhost:3000/auth/callback

# Necesaria para usar datos reales en la UI (sin ella, `npm run dev` muestra datos de ejemplo)
VITE_COORD_API=http

# Opcionales
# APS_CALLBACK_PORT=8765        # si cambias el puerto, registra http://localhost:<puerto>/callback en la app APS
# APS_BROWSER_SCOPE=data:read viewables:read
```

`.env.example` todavía trae `VITE_APS_HUB_ID` / `VITE_APS_PROJECT_ID`: no se usan, puedes borrarlas.

## 4. El agente de la app (sin instalación)

El agente de coordinación (chat y flujos) **viaja con la aplicación** en `agent-runtime/`: no hay que instalarlo
ni actualizarlo aparte. Al iniciar, el servidor lo copia a una carpeta privada
(`%LOCALAPPDATA%\bim-coordinator\agent-runtime\`, fuera de tus datos y de los respaldos) y desde ahí lo lanza.
Cuando actualizas la app, el agente se actualiza con ella.

La configuración usa valores por defecto (`server/templates/coordinator.config.json`). Para ajustes personales
crea `coordinator.config.local.json` (ignorado por git); solo puede bajar el nivel de autonomía, nunca subirlo.

## 5. Iniciar sesión en Autodesk (agente)

```bash
npm run coordinator -- login
```

Se abre el navegador en la página de Autodesk; acepta. La terminal muestra "Sesión iniciada". El token se guarda fuera del repo y se renueva solo (el de refresco dura 15 días; después hay que volver a iniciar sesión).

Comprueba:

```bash
npm run coordinator -- status
```

## 6. Registrar tu passkey (una vez por equipo)

La passkey es lo que prueba que **una persona** aprobó un lote. Sin ella no puedes aprobar en modo real.

1. En tu terminal (no en Claude Code):
   ```bash
   npm run coordinator -- passkey-enroll
   ```
   Muestra un código de 10 caracteres, válido 10 minutos y de un solo uso.
2. Levanta la UI si no está corriendo: `npm run dev`.
3. Abre `http://localhost:3000/ajustes/passkey`, ingresa el código y confirma con **Windows Hello**.

Para agregar otra passkey (otro equipo o llave física) entra a la misma página: te pedirá confirmar primero con una passkey ya registrada.

## 7. Abrir la aplicación

**Doble clic en `Coordinador BIM.cmd`** (en la carpeta del repo). El lanzador:

1. comprueba que Node.js 22+ esté instalado (si no, te dice dónde descargarlo);
2. si la carpeta es un clon de git sin cambios locales y hay una versión nueva de la app, pregunta
   **«¿Actualizar ahora? (S/N)»** (`git pull --ff-only`; si falla, sigue con la versión actual);
3. ejecuta `npm install` solo si falta `node_modules` o cambió `package-lock.json`;
4. si la app ya está corriendo, solo abre el navegador; si no, inicia el servidor (lo mismo que `npm run dev`, puerto 3000), espera a que responda y abre `http://localhost:3000`.

La ventana muestra un estado corto y el registro queda en `%LOCALAPPDATA%\CoordinadorBIM\server.log`. **Cierra esa ventana para detener el servidor.** No requiere permisos de administrador.

Para tener un acceso directo en el Escritorio (una vez):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
```

Alternativa en terminal: `npm run dev`.

Abre **`http://localhost:3000`** — exactamente `localhost`, **no** `127.0.0.1`: los navegadores no aceptan passkeys sobre una dirección IP, y el servidor rechaza orígenes distintos.

1. **Iniciar sesión con Autodesk** (para el visor 3D).
2. **Proyectos** → tu hub → tu proyecto → verás los conjuntos de modelos.
3. La tarjeta **Qué sigue** te propone el siguiente paso (p. ej. «Preparar el ciclo» → **Ejecutar**), y el
   **chat** del espacio de coordinación responde preguntas y puede lanzar los flujos. Ambos usan el agente de la
   app; Claude Code debe estar instalado y con sesión iniciada (`claude` → `/login`, una vez).

Listo. El flujo semanal está en el [README](../README.md#flujo-diario-proyecto-real).

## 8. Mejorar la app o el agente (VS Code, modo desarrollo)

VS Code (o `claude` en la carpeta del repo) es el **agente de desarrollo**: le pides mejoras de la app o del
agente de la app («que el chat explique X», «agrega un filtro por nivel»), las implementa, corre los tests y te
resume los cambios en español; hace commit cuando estás de acuerdo. Comando: `/mejorar` (o lenguaje natural).
Trabaja con **datos de prueba**: no puede leer tus datos reales, respaldos ni secretos, ni escribir en ACC.

**Activarlo (una vez, en tu propia terminal, no dentro de Claude Code):**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\activate-dev-harness.ps1
```

Respalda la configuración anterior (`CLAUDE.md`, `.mcp.json`, `.claude\`) en
`%LOCALAPPDATA%\bim-coordinator\backups\harness-<fecha>\`, copia `dev-harness\` a su lugar y muestra qué cambió
(confírmalo con `git add -A CLAUDE.md .mcp.json .claude` y `git commit`). Luego reabre Claude Code y acepta el
servidor MCP `coord` del proyecto. Para que el agente de desarrollo lea ACC real en **solo lectura**:
`$env:COORD_DEV_LIVE = "1"; claude`.

Después de una mejora: **reinicia la app con `Coordinador BIM.cmd`**.

## 9. Dónde viven tus datos y cómo respaldarlos

Las decisiones, propuestas, lotes, auditoría, ledgers, chat y caché del coordinador **no** viven en el
repositorio: borrar o volver a clonar el repo no los afecta (git nunca los respaldó).

| Qué | Dónde (Windows) | macOS / Linux |
|---|---|---|
| Datos | `%LOCALAPPDATA%\bim-coordinator\data` | `$XDG_DATA_HOME` o `~/.local/share/bim-coordinator/data` |
| Respaldos locales | `%LOCALAPPDATA%\bim-coordinator\backups` | `…/bim-coordinator/backups` |
| Secretos (clave de aprobación, passkeys, token APS) | `%APPDATA%\bim-coordinator` (DPAPI, no se mueven ni se respaldan) | `~/.config/bim-coordinator` |

`COORDINATOR_HOME` sigue mandando (demo, evaluaciones). En **modo fixtures** sin `COORDINATOR_HOME` se
sigue usando `<repo>/.coordinator`. Única fuente de verdad del código: `server/store/home.ts`.

**Migración automática (primer inicio).** Si la carpeta nueva está vacía y `<repo>/.coordinator` tiene datos,
al iniciar `npm run dev` (o el servidor MCP) se **copia** —nunca se mueve— a la carpeta nueva, se verifica
(cantidad de archivos y sha256 de cada uno) y se activa. En la carpeta antigua queda `MIGRATED.txt` con la
ruta nueva y en la nueva `migration.json`. No copia secretos (`secret/`, `auth/`), bloqueos ni temporales.
Si la verificación falla, se sigue usando la carpeta antigua y **Ajustes → Datos y respaldos** muestra el
aviso; se reintenta al reiniciar. Si ambas carpetas tienen datos, se usa la nueva y se avisa (sin fusionar).
Puedes borrar la carpeta antigua cuando confirmes que la UI muestra tus decisiones.

**Respaldo diario.** Mientras la aplicación corre, una vez al día (al iniciar y luego se revisa cada hora) se
crea `backups\coordinator-AAAA-MM-DD.zip` (copia consistente bajo el bloqueo del store, verificada), y se
conservan los últimos 14 (configurable). **Respaldar ahora** crea uno adicional. En **Ajustes → Datos y
respaldos** puedes indicar una **carpeta externa** (p. ej. una carpeta de OneDrive/SharePoint corporativa
sincronizada, aprobada según el *Procedimiento Acceso Herramientas IA*) donde se copia cada respaldo.
Cada respaldo queda en la auditoría (sin rutas ni datos personales).

**Exportar / restaurar** (solo humanos, desde la UI; el agente no tiene herramientas para esto):
- **Exportar** descarga un `.zip` con todos los datos (sin secretos). Trátalo como dato confidencial del proyecto.
- **Restaurar…**: eliges un `.zip` de respaldo; se valida sin cambiar nada (rutas seguras, solo tipos de
  datos, sha256 contra el manifiesto, JSON válido). Luego confirmas con tu **passkey**; antes de reemplazar se
  crea `coordinator-…-pre-restore.zip` con el estado actual. Reinicia `npm run dev` después de restaurar.
  Una exportación de un solo proyecto no se puede restaurar como respaldo completo.

## Solución de problemas

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| **403** en cualquier llamada a ACC (proyectos vacíos, "forbidden") | El Client ID no está en **Custom Integrations** de la cuenta ACC, o tu usuario no tiene permisos en la carpeta de modelos | Pide al Account Admin que lo agregue (paso 2). Revisa tus permisos en Docs: ver para leer, editar para cerrar o asignar. |
| Autodesk muestra "redirect_uri mismatch" o similar | La callback registrada no coincide | Registra exactamente `http://localhost:8765/callback` y `http://localhost:3000/auth/callback` (sin `/` final, `localhost` y no `127.0.0.1`). |
| El agente dice que **no hay sesión APS** | No iniciaste sesión, o el token expiró (15 días) | `npm run coordinator -- login --force`. Si persiste, inicia sesión también desde la UI web y vuelve a abrir Claude Code. |
| La UI muestra proyectos "Torre B" que no existen | La UI está usando datos de ejemplo | Agrega `VITE_COORD_API=http` a `.env.local` y reinicia `npm run dev`. |
| **Passkey**: "La operación no está permitida" o no aparece Windows Hello | Abriste la UI por `127.0.0.1` o por otro puerto | Usa `http://localhost:3000`. |
| **Passkey**: "código inválido o expirado" al registrar | El código dura 10 min y sirve una vez | Genera otro con `npm run coordinator -- passkey-enroll`. |
| **Passkey**: `passkey-enroll` se niega a correr | Lo ejecutaste dentro de Claude Code o sin terminal interactiva | Ejecútalo en una terminal normal (PowerShell, Git Bash). |
| **Passkey**: la aprobación se rechaza tras editar el lote | La firma cubre el contenido exacto; cualquier exclusión o edición la invalida | Vuelve a pulsar **Aprobar**: se pide una nueva firma. |
| **Versión desactualizada**: banner "Hay una versión más reciente del conjunto", o la aprobación/aplicación se rechaza por versión | Se publicó una versión nueva del conjunto de modelos después del análisis | Ejecuta el flujo **Preparar el ciclo** (Qué sigue o el chat); revisa y aprueba sobre la versión nueva. Las aprobaciones no se pueden aplicar sobre una versión vieja. |
| "Pre-chequeo requerido" al aprobar | El pre-chequeo con ACC tiene más de 10 minutos | **Comprobar con ACC** en el lote y vuelve a aprobar. |
| **Puerto 3000 en uso**: Vite arranca en 3001 u otro | Otro proceso usa el 3000 | Cierra ese proceso (`netstat -ano \| findstr :3000` y luego `taskkill /PID <pid> /F`). No uses otro puerto: la callback del navegador y la passkey están ligadas a `localhost:3000`. |
| **Puerto 8765 en uso** al iniciar sesión | Otro proceso usa el puerto de la callback | Libéralo, o define `APS_CALLBACK_PORT` en `.env.local` y registra la nueva callback en la app APS. |
| VS Code no muestra las herramientas `mcp__coord__*` | No se activó el modo desarrollo o no aprobaste el servidor MCP | Corre una vez `scripts\activate-dev-harness.ps1` (sección 8); al abrir `claude`, acepta el servidor `coord` del proyecto. |
| **Flujos**: «Los flujos no están disponibles» | La app no encontró su agente (`agent-runtime/`) o no pudo copiarlo a su carpeta privada | Reinicia la app con `Coordinador BIM.cmd`; si persiste, revisa que la carpeta del repo esté completa (`git status`). |
| `Coordinador BIM.cmd` dice que el servidor no respondió | Otro programa usa el puerto 3000, o falló `npm install` | Revisa `%LOCALAPPDATA%\CoordinadorBIM\server.log`; libera el puerto 3000 y vuelve a abrirlo. |
| Un hook bloquea algo ("guardia desarrollo" o "guardia coordinador") | Es intencional: datos reales, respaldos, secretos o escritura en ACC | Haz tú la acción fuera del agente si corresponde. El agente de desarrollo trabaja con fixtures. |

Si algo no calza, `npm run coordinator -- status` y la página **Ajustes** de la UI muestran el estado de sesión, el modo de datos y el nivel de autonomía.
