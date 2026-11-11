# Coordinador BIM - lanzador (lo llama "Coordinador BIM.cmd").
#
#  1. Verifica que Node.js (22 o superior) este instalado.
#  2. Si es un clon de git limpio y hay una versión nueva, pregunta si actualizar (git pull --ff-only).
#     Ejecuta "npm install" solo si falta node_modules o cambio package-lock.json (marca con hash).
#  3. Si el servidor ya responde en http://localhost:3000, solo abre el navegador.
#  4. Si no, lo inicia (igual que "npm run dev", puerto 3000), espera a que responda y abre el navegador.
#     El servidor vive mientras esta ventana este abierta: cerrarla lo detiene.
#
# Compatible con Windows PowerShell 5.1, sin permisos de administrador, rutas con espacios.
# No modifica .claude/, .mcp.json ni coordinator.config*.json.

$ErrorActionPreference = "Stop"
$Url = "http://localhost:3000"
$Probe = "$Url/api/coord/csrf"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root
$Host.UI.RawUI.WindowTitle = "Coordinador BIM"

function Say([string]$msg, [string]$color = "Gray") { Write-Host $msg -ForegroundColor $color }

function Stop-WithMessage([string]$msg) {
  Say ""
  Say $msg "Red"
  Say ""
  Read-Host "Presiona Enter para cerrar"
  exit 1
}

function Test-Server {
  try {
    $req = [System.Net.HttpWebRequest]::Create($Probe)
    $req.Proxy = $null
    $req.Timeout = 2000
    $res = $req.GetResponse()
    $ok = [int]$res.StatusCode -eq 200
    $res.Close()
    return $ok
  } catch {
    return $false
  }
}

Say "Coordinador BIM" "Cyan"
Say "Carpeta: $Root"

# 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  Stop-WithMessage "No encontramos Node.js en este equipo. Instala la versión LTS (22 o superior) desde https://nodejs.org (no requiere administrador si eliges 'solo para mí'), cierra esta ventana y vuelve a abrir 'Coordinador BIM'."
}
$major = 0
try { $major = [int](& node -p "process.versions.node.split('.')[0]") } catch { $major = 0 }
if ($major -lt 22) {
  Stop-WithMessage "Tu Node.js es antiguo (versión $major). Instala la versión LTS 22 o superior desde https://nodejs.org y vuelve a abrir 'Coordinador BIM'."
}

# 3a. Already running? Just open the browser.
if (Test-Server) {
  Say "El Coordinador BIM ya está en ejecución. Abriendo $Url ..." "Green"
  Start-Process $Url
  Start-Sleep -Seconds 2
  exit 0
}

# 2a. Optional app update: only when this is a git clone with a clean working tree whose upstream has new
#     commits; asks first and only fast-forwards (git pull --ff-only). Any error: skipped, the app starts as is.
#     The in-app agent (agent-runtime/) ships with the app, so this also updates the agent.
function Update-App {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return }
  if (-not (Test-Path -LiteralPath (Join-Path $Root ".git"))) { return }
  try {
    $dirty = & git -C $Root status --porcelain 2>$null
    if ($LASTEXITCODE -ne 0 -or $dirty) { return }
    & git -C $Root fetch --quiet 2>$null
    if ($LASTEXITCODE -ne 0) { return }
    $behind = [int](& git -C $Root rev-list --count "HEAD..@{u}" 2>$null)
    if ($LASTEXITCODE -ne 0 -or $behind -le 0) { return }
    $a = Read-Host "Hay una versión nueva de la aplicación ($behind cambios). ¿Actualizar ahora? (S/N)"
    if ($a -notmatch '^(s|si|sí|y|yes)$') { return }
    & git -C $Root pull --ff-only --quiet
    if ($LASTEXITCODE -eq 0) { Say "Aplicación actualizada." "Green" } else { Say "No se pudo actualizar (se sigue con la versión actual)." "Yellow" }
  } catch {
    return
  }
}
Update-App

# 2. Dependencies (only when node_modules is missing or package-lock.json changed)
$lock = Join-Path $Root "package-lock.json"
$modules = Join-Path $Root "node_modules"
$marker = Join-Path $modules ".coord-lock-hash"
$lockHash = ""
if (Test-Path -LiteralPath $lock) { $lockHash = (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash }
$installed = ""
if (Test-Path -LiteralPath $marker) { $installed = (Get-Content -LiteralPath $marker -Raw).Trim() }
if (-not (Test-Path -LiteralPath $modules) -or $installed -ne $lockHash) {
  Say "Instalando dependencias (npm install). La primera vez puede tardar unos minutos..." "Yellow"
  & npm.cmd install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage "Falló 'npm install' (código $LASTEXITCODE). Revisa tu conexión a internet o el proxy de la empresa y vuelve a intentar."
  }
  if ($lockHash) { Set-Content -LiteralPath $marker -Value $lockHash -Encoding ASCII }
}

# 3b. Start the server (same as "npm run dev"), logs out of the repository.
$logDir = Join-Path $env:LOCALAPPDATA "CoordinadorBIM"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "server.log"
$errLog = Join-Path $logDir "server.err.log"
Say "Iniciando el servidor en $Url ..." "Yellow"
$proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/d /c npm.cmd run dev" -WorkingDirectory $Root -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError $errLog

function Show-LogTail {
  foreach ($f in @($errLog, $log)) {
    if (Test-Path -LiteralPath $f) {
      $tail = Get-Content -LiteralPath $f -Tail 20 -ErrorAction SilentlyContinue
      if ($tail) { Say "--- $f ---"; $tail | ForEach-Object { Say $_ } }
    }
  }
}

$deadline = (Get-Date).AddSeconds(180)
$up = $false
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { break }
  if (Test-Server) { $up = $true; break }
  Start-Sleep -Milliseconds 1000
}
if (-not $up) {
  Show-LogTail
  if (-not $proc.HasExited) { try { & taskkill.exe /PID $proc.Id /T /F | Out-Null } catch { } }
  Stop-WithMessage "El servidor no respondió en $Url. Si otra aplicación usa el puerto 3000, ciérrala y vuelve a intentar. Registro: $log"
}

Start-Process $Url
Say ""
Say "Coordinador BIM en ejecución: $Url" "Green"
Say "Registro del servidor: $log"
Say ""
Say "Cierra esta ventana para detener el servidor." "Cyan"
$proc.WaitForExit()
Say ""
Say "El servidor se detuvo." "Yellow"
Show-LogTail
Read-Host "Presiona Enter para cerrar"
