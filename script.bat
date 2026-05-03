@echo off
for /f "tokens=5" %%P in ('netstat -ano ^| findstr "127.0.0.1:8787 .*LISTENING"') do taskkill /F /PID %%P >nul 2>&1
start "" chrome http://localhost:8787/?admin=1
python scripts/admin_server.py
