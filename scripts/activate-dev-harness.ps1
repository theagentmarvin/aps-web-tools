# Activa el harness de DESARROLLO (dev-harness/) en la raíz del repositorio. Lo ejecuta una persona, una vez,
# en su propia terminal (no dentro de Claude Code):
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\activate-dev-harness.ps1
#
# Qué hace:
#   1. se niega a correr si CLAUDECODE está definido (el agente no puede activar ni cambiar sus propias guardas);
#   2. respalda CLAUDE.md, .mcp.json y .claude\ actuales en %LOCALAPPDATA%\bim-coordinator\backups\harness-<fecha>\;
#   3. reemplaza CLAUDE.md, .mcp.json, .claude\settings.json, .claude\hooks\ y .claude\skills\ por los de
#      dev-harness\ y quita .claude\agents\ (los agentes de coordinación viven ahora en agent-runtime\, dentro de
#      la app). .claude\settings.local.json (personal) se conserva;
#   4. muestra qué cambió y cómo confirmarlo en git.
# El agente de la app (chat y flujos) NO depende de esto: viaja con la app en agent-runtime\.
param([switch]$Yes)
$ErrorActionPreference = "Stop"

if (Test-Path Env:CLAUDECODE) {
  Write-Host "Este script no se ejecuta desde Claude Code (CLAUDECODE está definido). Ábrelo en tu propia terminal." -ForegroundColor Red
  exit 2
}

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "dev-harness"
if (-not (Test-Path (Join-Path $src "CLAUDE.md"))) {
  Write-Host "No se encontró dev-harness\CLAUDE.md en $root." -ForegroundColor Red
  exit 1
}

$local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmss")
$backup = Join-Path $local "bim-coordinator\backups\harness-$stamp"

Write-Host "Activar el harness de desarrollo en: $root"
Write-Host "  Respaldo de la versión actual:    $backup"
Write-Host "  Se reemplazan: CLAUDE.md, .mcp.json, .claude\settings.json, .claude\hooks\, .claude\skills\; se quita .claude\agents\"
if (-not $Yes) {
  $a = Read-Host "¿Continuar? (S/N)"
  if ($a -notmatch '^(s|si|sí|y|yes)$') { Write-Host "Cancelado; no se cambió nada."; exit 0 }
}

New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach ($rel in @("CLAUDE.md", ".mcp.json", ".claude")) {
  $p = Join-Path $root $rel
  if (Test-Path $p) { Copy-Item -Recurse -Force -LiteralPath $p -Destination (Join-Path $backup $rel) }
}

$claude = Join-Path $root ".claude"
New-Item -ItemType Directory -Force -Path $claude | Out-Null
foreach ($rel in @("agents", "hooks", "skills", "settings.json")) {
  $p = Join-Path $claude $rel
  if (Test-Path $p) { Remove-Item -Recurse -Force -LiteralPath $p }
}
Copy-Item -Force -LiteralPath (Join-Path $src "CLAUDE.md") -Destination (Join-Path $root "CLAUDE.md")
Copy-Item -Force -LiteralPath (Join-Path $src ".mcp.json") -Destination (Join-Path $root ".mcp.json")
Copy-Item -Force -LiteralPath (Join-Path $src ".claude\settings.json") -Destination (Join-Path $claude "settings.json")
Copy-Item -Recurse -Force -LiteralPath (Join-Path $src ".claude\hooks") -Destination (Join-Path $claude "hooks")
Copy-Item -Recurse -Force -LiteralPath (Join-Path $src ".claude\skills") -Destination (Join-Path $claude "skills")

Write-Host ""
Write-Host "Listo. Cambios en el repositorio:" -ForegroundColor Green
Push-Location $root
try { git status --short -- CLAUDE.md .mcp.json .claude } catch { }
Pop-Location
Write-Host ""
Write-Host "Siguiente:"
Write-Host "  1. Revisa los cambios y confírmalos:  git add -A CLAUDE.md .mcp.json .claude ; git commit -m `"Activate dev harness`""
Write-Host "  2. Cierra y vuelve a abrir Claude Code en VS Code (acepta el servidor MCP 'coord' del proyecto)."
Write-Host "  3. Pide mejoras con /mejorar o en lenguaje natural."
Write-Host "Para volver atrás: copia el contenido de $backup a la raíz del repositorio."
