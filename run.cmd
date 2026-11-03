@echo off
setlocal
cd /d "%~dp0"
deno task start %*
