# Crea un acceso directo "Coordinador BIM" en el Escritorio que abre "Coordinador BIM.cmd".
# Uso (una vez, sin administrador):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Target = Join-Path $Root "Coordinador BIM.cmd"
if (-not (Test-Path -LiteralPath $Target)) { throw "No se encontró $Target" }
$Desktop = [Environment]::GetFolderPath("Desktop")
$Link = Join-Path $Desktop "Coordinador BIM.lnk"
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($Link)
$Shortcut.TargetPath = $Target
$Shortcut.WorkingDirectory = $Root
$Shortcut.Description = "Coordinador BIM (SalfaCorp): inicia el servidor local y abre la app"
$Shortcut.Save()
Write-Host "Acceso directo creado: $Link" -ForegroundColor Green
