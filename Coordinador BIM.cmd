@echo off
rem Coordinador BIM - doble clic para abrir la app (inicia el servidor si hace falta).
rem Cierra la ventana para detener el servidor. Detalles: scripts\launcher.ps1 y docs\setup.md.
setlocal
title Coordinador BIM
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher.ps1"
endlocal
