@echo off
setlocal enabledelayedexpansion

rem Find any process listening on 127.0.0.1:8787 and kill ONLY that one.
rem /c: makes findstr treat the whole string as a literal substring
rem (without it, spaces become OR separators -- which can match unrelated lines).
set "PORT_PID="
for /f "tokens=5" %%P in ('netstat -ano -p TCP ^| findstr /c:"127.0.0.1:8787" ^| findstr /c:"LISTENING"') do set "PORT_PID=%%P"

if defined PORT_PID (
    rem Refuse to touch the System Idle Process (0) or System (4).
    if not "!PORT_PID!"=="0" if not "!PORT_PID!"=="4" (
        echo Killing stale listener on 127.0.0.1:8787 (PID !PORT_PID!^)
        taskkill /F /PID !PORT_PID! >nul 2>&1
    )
)

start "" chrome http://localhost:8787/?admin=1
python scripts/admin_server.py

endlocal
