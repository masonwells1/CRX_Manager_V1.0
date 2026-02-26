@echo off
REM ============================================================
REM  Sync Claude Code memory files from repo backup
REM  Run this ONCE on a new computer after cloning the repo
REM  Or anytime you want to refresh memory files from the repo
REM ============================================================

echo.
echo === Claude Code Memory Sync ===
echo.

REM Find the repo directory (where this script lives)
set "REPO_DIR=%~dp0.."
set "SOURCE=%REPO_DIR%\docs\claude-memory"

REM Claude Code memory directory (adjust if your Windows username differs)
set "DEST=%USERPROFILE%\.claude\projects\C--\memory"

echo Source: %SOURCE%
echo Destination: %DEST%
echo.

REM Create destination if it doesn't exist
if not exist "%DEST%" (
    echo Creating memory directory...
    mkdir "%DEST%"
)

REM Copy files
echo Copying memory files...
copy /Y "%SOURCE%\MEMORY.md" "%DEST%\MEMORY.md"
copy /Y "%SOURCE%\lessons.md" "%DEST%\lessons.md"
copy /Y "%SOURCE%\doc-rules.md" "%DEST%\doc-rules.md"
copy /Y "%SOURCE%\setup-guide.md" "%DEST%\setup-guide.md"
copy /Y "%SOURCE%\project-details.md" "%DEST%\project-details.md"

echo.
echo Done! Memory files synced.
echo.
echo NOTE: The memory directory path assumes your project maps to "C--"
echo If Claude Code uses a different path, check %USERPROFILE%\.claude\projects\
echo and copy files to the correct "memory" subfolder.
echo.
pause
