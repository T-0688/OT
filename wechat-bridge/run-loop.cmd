@echo off
cd /d "%~dp0"
:loop
node bridge.mjs run
timeout /t 5 /nobreak >nul
goto loop
