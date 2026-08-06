param(
  [Parameter(Mandatory = $true)]
  [string]$Destination,
  [string]$Source = '',
  [switch]$ParentCleanupGuaranteed,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$backupTool = Join-Path $repoRoot 'scripts\backup-factory-state.mjs'

if (-not (Test-Path -LiteralPath $backupTool)) {
  throw "Factory backup tool is missing: $backupTool"
}
if ($ParentCleanupGuaranteed.IsPresent -eq $SelfTest.IsPresent) {
  throw 'Choose exactly one cleanup owner: -ParentCleanupGuaranteed or -SelfTest.'
}

Push-Location $repoRoot
$primaryError = $null
$cleanupError = $null
try {
  if ($Source) {
    & node $backupTool --stage $Destination --source $Source
  } else {
    & node $backupTool --stage $Destination
  }
  $stageExit = $LASTEXITCODE
  if ($stageExit -notin @(0, 4, 5)) {
    throw "Factory state staging failed (exit $LASTEXITCODE)."
  }
  if ($SelfTest) {
    & node $backupTool --verify $Destination
    $verifyExit = $LASTEXITCODE
    if ($verifyExit -ne $stageExit) {
      throw "Factory state self-test replay status changed (stage=$stageExit verify=$verifyExit)."
    }
  }
} catch {
  $primaryError = $_
} finally {
  if ($SelfTest -and (Test-Path -LiteralPath $Destination)) {
    try {
      & node $backupTool --cleanup-snapshot-temp $Destination
      if ($LASTEXITCODE -ne 0) { throw "Factory state self-test cleanup failed (exit $LASTEXITCODE)." }
    } catch {
      $cleanupError = $_
    }
  }
  Pop-Location
}
if ($primaryError) {
  if ($cleanupError) { Write-Warning "Factory state self-test cleanup also failed: $($cleanupError.Exception.Message)" }
  throw $primaryError
}
if ($cleanupError) { throw $cleanupError }
exit $stageExit
