@echo off
cd /d "%~dp0"

echo [Agent Teams] Starte App...

REM Check if dist/ exists and is recent enough
if not exist "dist\index.html" (
  echo [Agent Teams] Erstelle Production-Build...
  call node_modules\.bin\vite.cmd build
  if errorlevel 1 (
    echo FEHLER: Build fehlgeschlagen!
    pause
    exit /b 1
  )
)

REM Start Electron detached in production mode. The temporary batch window can
REM close immediately; Codex and Claude subprocesses are hidden separately.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
exit /b 0
