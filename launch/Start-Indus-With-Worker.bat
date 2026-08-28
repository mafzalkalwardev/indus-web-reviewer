@echo off
setlocal EnableExtensions
title Indus Web Reviewer + Worker
cd /d "%~dp0.."

REM 1) Start the app (API + dashboard)
call "%~dp0Start-Indus-Web-Reviewer.bat"
if errorlevel 1 exit /b 1

echo Waiting for Control API...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ok=$false; for($i=0;$i -lt 60;$i++){ try { $r=Invoke-RestMethod 'http://127.0.0.1:3847/api/health' -TimeoutSec 2; if($r.ok){ $ok=$true; break } } catch {}; Start-Sleep -Seconds 1 }; if(-not $ok){ exit 1 }"
if errorlevel 1 (
  echo [WARN] API not ready — open dashboard and press Start worker manually.
  exit /b 0
)

echo Enabling live target + starting wait worker...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Invoke-RestMethod -Method POST 'http://127.0.0.1:3847/api/worker/target' -ContentType 'application/json' -Body '{\"enabled\":true,\"practiceMode\":false,\"refreshSeconds\":75}' | Out-Null; Invoke-RestMethod -Method POST 'http://127.0.0.1:3847/api/worker/start' -ContentType 'application/json' -Body '{}' | ConvertTo-Json -Compress } catch { Write-Host $_.Exception.Message; exit 1 }"

echo.
echo Done. Use the dashboard Realtime work panel to watch progress.
exit /b 0
