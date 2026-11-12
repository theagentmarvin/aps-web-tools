# Cómo contribuir

Guía para personas y agentes (Claude Code u otros) que suben mejoras a este repositorio. **Los agentes deben leerla
antes de hacer commit.**

Recuerda el **Procedimiento Acceso Herramientas IA de SalfaCorp**: los datos de proyecto son confidenciales y no se
copian a otras herramientas de IA.

## Flujo de trabajo con Git

1. **Revisa el remoto.** `git remote -v` debe mostrar `origin` apuntando a este repositorio en GitHub. Si apunta a un
   repo antiguo, a un fork o a una copia, corrígelo antes de seguir.
2. **Parte siempre de `main` actualizado:**
   ```bash
   git checkout main
   git pull --ff-only origin main
   git checkout -b <tipo>/<tema-corto>
   ```
   Tipos: `feature/`, `fix/`, `docs/`, `refactor/`, `chore/`, `mejora/` (pedidos de coordinadores). Nombre en
   minúsculas y con guiones, por ejemplo `mejora/panel-grupo-encabezado-compacto`. Elige el nombre definitivo al crear
   la rama: renombrar después deja ramas duplicadas. Si tienes cambios sin commit, decide qué hacer con ellos antes de
   cambiar de rama.
3. **Una rama por mejora.** Nunca hagas commit ni push directo a `main`, y nunca uses `push --force` sobre ramas
   compartidas.
4. **Antes de hacer commit:**
   - Corre las pruebas: `npm run typecheck`, `npm test` y `npm run check` (higiene del repo). Si cambiaste las
     instrucciones del agente de la app (`agent-runtime/`), corre también `npx tsx scripts/eval-agent.ts --self-test`.
   - Prueba con datos de demostración (`npm run demo` o modo fixtures), nunca con proyectos reales.
   - Revisa `git status` y `git diff`. Agrega sólo los archivos de este cambio.
   - **Nunca subas** credenciales, tokens, contraseñas, `.env`, passkeys, datos de proyectos (la carpeta de datos del
     coordinador, respaldos, exportaciones), datos personales (nombres, correos, teléfonos) ni rutas personales
     (`C:\Users\<nombre>\...`). Tampoco archivos generados o pesados (builds, RVT, IFC, DWG, PDF, Excel, zip).
   - Las **reglas** (`rules/`) no se editan a mano: se proponen y se publican desde la página Reglas de la app (passkey).
5. **Commit** con un mensaje de una línea que diga qué cambió y dónde, por ejemplo
   `triage: encabezado compacto del panel de grupo`.
6. **Push y Pull Request:**
   ```bash
   git push -u origin <tu-rama>
   gh pr create --base main --fill
   ```
   Si no tienes `gh`, abre el PR desde el link que muestra `git push`. Completa la plantilla del PR. Si el cambio toca
   seguridad (aprobaciones, passkeys, escritura en ACC, permisos del agente, datos), dilo en la descripción.
7. **No hagas merge tú.** El dueño del repo revisa y hace el merge. Si piden cambios, haz commit en la misma rama y
   vuelve a hacer push.
8. **Después del push** quédate en tu rama o vuelve a `main`. No vuelvas a ramas que ya se mergearon. Cuando se haga
   el merge:
   ```bash
   git checkout main
   git pull --ff-only origin main
   git branch -d <tu-rama>
   ```
   Si `git branch -d` dice "not fully merged" pero el PR ya está mergeado en GitHub, usa `git branch -D <tu-rama>`.
9. **Para usar la versión nueva**, cierra la app y ábrela de nuevo con `Coordinador BIM.cmd`: si hay commits nuevos
   en `main` te ofrece actualizar (`git pull --ff-only`).

## Qué revisa el CI en cada PR

`.github/workflows/ci.yml` corre en cada PR y en cada push a `main`:

- `npm run typecheck` (UI y servidor) y `npm test` (vitest).
- `npm run check` (`scripts/check-repo.mjs`): marcas de conflicto de merge, rutas personales `C:\Users\<nombre>`,
  correos, secretos con forma conocida y datos que no se versionan (`.coordinator/`, modelos, `.env`).

Si el CI falla, el PR no se mergea hasta corregirlo.

## Pendientes y mejoras

Los pendientes se registran como [issues en GitHub](../../issues), no sólo en la descripción del PR. Si ves algo que
corregir y no es parte de tu cambio, abre un issue.
