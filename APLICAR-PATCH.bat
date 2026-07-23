@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0APLICAR-PATCH.ps1"
pause
