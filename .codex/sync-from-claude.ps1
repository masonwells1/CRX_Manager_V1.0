param(
  [switch]$Check,
  [switch]$IncludeHooks
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$mode = if ($Check) { "--check" } else { "--write" }

& node (Join-Path $repoRoot "scripts\sync-agent-workflows.mjs") $mode
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if ($IncludeHooks) {
  Write-Host "Codex hooks reference .claude/hooks directly; no hook copies are created."
}
