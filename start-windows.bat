@echo off
rem Launch the graphhog dashboard (Windows)
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo node not found - please install Node.js ^(^>= 16^) first
  pause
  exit /b 1
)

node graphhog.mjs %*
pause
