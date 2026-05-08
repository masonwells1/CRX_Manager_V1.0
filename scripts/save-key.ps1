# Reads current clipboard contents and saves to backups/.svc.tmp.
# Usage: copy the service_role JWT from the Supabase dashboard, then run:
#   powershell -File scripts\save-key.ps1
$clip = Get-Clipboard -Raw
if ($null -eq $clip -or $clip.Length -lt 100) {
    Write-Host "ERROR: clipboard is empty or too short ($($clip.Length) chars)." -ForegroundColor Red
    Write-Host "Did you click 'Copy' on the dashboard before running this script?"
    exit 1
}
$trimmed = $clip.Trim()
if (-not $trimmed.StartsWith("eyJ")) {
    Write-Host "ERROR: clipboard doesn't start with 'eyJ' (a JWT prefix)." -ForegroundColor Red
    Write-Host "First 20 chars seen: $($trimmed.Substring(0, [Math]::Min(20, $trimmed.Length)))"
    exit 1
}
$out = Join-Path $PSScriptRoot "..\backups\.svc.tmp"
[IO.File]::WriteAllText($out, $trimmed, [Text.Encoding]::ASCII)
Write-Host "OK: saved $($trimmed.Length) chars to $out" -ForegroundColor Green
