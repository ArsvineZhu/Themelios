@echo off
setlocal DisableDelayedExpansion
"%~dp0runtime\bun.exe" --no-install "%~dp0app\launch.mjs" %*
exit /b %errorlevel%
