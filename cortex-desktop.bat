@echo off
rem --- Cortex Desktop: خادم محلي + نافذة تطبيق مستقلة (بلا شريط متصفح) ---
setlocal
cd /d %~dp0
start "Cortex Server" /min node server.js
timeout /t 2 /nobreak >nul

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "EDGE2=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "CHROME2=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if exist "%EDGE%" (
  start "" "%EDGE%" --app=http://127.0.0.1:3737 --window-size=1400,900
) else if exist "%EDGE2%" (
  start "" "%EDGE2%" --app=http://127.0.0.1:3737 --window-size=1400,900
) else if exist "%CHROME%" (
  start "" "%CHROME%" --app=http://127.0.0.1:3737 --window-size=1400,900
) else if exist "%CHROME2%" (
  start "" "%CHROME2%" --app=http://127.0.0.1:3737 --window-size=1400,900
) else (
  start "" http://127.0.0.1:3737
)
endlocal
