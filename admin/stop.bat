@echo off
setlocal enabledelayedexpansion
set found=0
for /l %%p in (8899,1,8903) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p" ^| findstr "LISTENING"') do (
    taskkill /pid %%a /f >nul 2>nul
    set found=1
  )
)
if "!found!"=="1" (echo [ok] Admin server stopped.) else (echo [--] No admin server on 8899-8903)
ping -n 2 127.0.0.1 >nul 2>&1
exit /b 0
