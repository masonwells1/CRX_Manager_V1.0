# Windows Hello helper for Mason's owner approval (Mason, 2026-09-29).
#
# Three modes, each printing ONE line of JSON on stdout:
#   Create     make Mason's approval key (Windows Hello prompt). The private half
#              lives in the PC's security chip and cannot be copied out.
#   PublicKey  read the public half of that key. No prompt.
#   Sign       show Mason what he is approving (the "summary" lines of the payload
#              file), then, only if he clicks Yes, ask Windows Hello to sign the
#              payload file's exact bytes. Every signature needs his PIN or finger.
#
# The summary shown here comes from the signed payload itself, and the verifier
# (owner-approval-lib.mjs) recomputes it from the payload's own fields, so what
# Mason reads is what he signs. Keep this file ASCII (a UTF-8 dash once broke a
# PowerShell script on this machine silently).

param(
  [Parameter(Mandatory = $true)][ValidateSet('Create', 'PublicKey', 'Sign')][string]$Mode,
  [string]$PayloadFile
)

$ErrorActionPreference = 'Stop'
$KeyName = 'CRX-Owner-Migration-Approval'
$KnownPurposes = @('crx-owner-migration-approval-v1', 'crx-owner-approval-selftest-v1')

function Write-Result($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type -AssemblyName System.Windows.Forms
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  function Wait-WinRt($op, [Type]$type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }
  [Windows.Security.Credentials.KeyCredentialManager, Windows.Security.Credentials, ContentType = WindowsRuntime] | Out-Null
  [Windows.Security.Credentials.KeyCredentialRetrievalResult, Windows.Security.Credentials, ContentType = WindowsRuntime] | Out-Null
  [Windows.Security.Credentials.KeyCredentialOperationResult, Windows.Security.Credentials, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.IBuffer, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

  $manager = [Windows.Security.Credentials.KeyCredentialManager]
  $retrieval = [Windows.Security.Credentials.KeyCredentialRetrievalResult]
  # Windows PowerShell 5.1 cannot pass a returned WinRT buffer to another WinRT
  # method (it arrives as a bare __ComObject; measured 2026-09-30). Calling through
  # .NET reflection casts it at the CLR level instead, which works.
  $bufferExt = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]
  $toArray = $bufferExt.GetMethod('ToArray', [Type[]]@([Windows.Storage.Streams.IBuffer]))
  $asBuffer = $bufferExt.GetMethod('AsBuffer', [Type[]]@([byte[]]))
  $credentialType = [Windows.Security.Credentials.KeyCredential]
  function ConvertTo-Base64FromBuffer($buffer) { [Convert]::ToBase64String([byte[]]$toArray.Invoke($null, @($buffer))) }
  function Get-PublicKeyBase64($credential) {
    ConvertTo-Base64FromBuffer ($credentialType.GetMethod('RetrievePublicKey', [Type[]]@()).Invoke($credential, $null))
  }

  function Show-Question([string]$title, [string]$text, [bool]$yesNo) {
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.StartPosition = 'CenterScreen'
    $owner.Size = New-Object System.Drawing.Size(1, 1)
    $owner.Show()
    $owner.Activate()
    if ($yesNo) {
      $answer = [System.Windows.Forms.MessageBox]::Show($owner, $text, $title,
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
      $owner.Close()
      return ($answer -eq [System.Windows.Forms.DialogResult]::Yes)
    }
    $answer = [System.Windows.Forms.MessageBox]::Show($owner, $text, $title,
      [System.Windows.Forms.MessageBoxButtons]::OKCancel,
      [System.Windows.Forms.MessageBoxIcon]::Information)
    $owner.Close()
    return ($answer -eq [System.Windows.Forms.DialogResult]::OK)
  }

  if (-not (Wait-WinRt ($manager::IsSupportedAsync()) ([bool]))) {
    Write-Result @{ ok = $false; status = 'HelloNotSupported' }
    exit 2
  }

  if ($Mode -eq 'PublicKey') {
    $open = Wait-WinRt ($manager::OpenAsync($KeyName)) $retrieval
    if ("$($open.Status)" -ne 'Success') {
      Write-Result @{ ok = $false; status = "$($open.Status)" }
      exit 2
    }
    Write-Result @{ ok = $true; publicKey = (Get-PublicKeyBase64 $open.Credential) }
    exit 0
  }

  if ($Mode -eq 'Create') {
    $go = Show-Question 'CRX Manager: set up your approval key' ("CRX Manager is creating your personal approval key.`r`n`r`n" +
      "From now on, a database change that deletes data, overwrites data or changes who can access what " +
      "can only be installed after you approve it with your Windows Hello PIN or fingerprint.`r`n`r`n" +
      "Click OK, then confirm with Windows Hello.") $false
    if (-not $go) {
      Write-Result @{ ok = $false; status = 'Declined' }
      exit 3
    }
    $created = Wait-WinRt ($manager::RequestCreateAsync($KeyName,
        [Windows.Security.Credentials.KeyCredentialCreationOption]::FailIfExists)) $retrieval
    if ("$($created.Status)" -ne 'Success') {
      Write-Result @{ ok = $false; status = "$($created.Status)" }
      exit 2
    }
    Write-Result @{ ok = $true; publicKey = (Get-PublicKeyBase64 $created.Credential) }
    exit 0
  }

  # Sign
  if (-not $PayloadFile -or -not (Test-Path -LiteralPath $PayloadFile)) {
    Write-Result @{ ok = $false; status = 'NoPayloadFile' }
    exit 2
  }
  $bytes = [System.IO.File]::ReadAllBytes($PayloadFile)
  $payload = [System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  if ($KnownPurposes -notcontains "$($payload.purpose)") {
    Write-Result @{ ok = $false; status = 'UnknownPurpose' }
    exit 2
  }
  $lines = @($payload.summary | ForEach-Object { "$_" })
  if ($lines.Count -eq 0) {
    Write-Result @{ ok = $false; status = 'NoSummary' }
    exit 2
  }
  $text = ($lines -join "`r`n") + "`r`n`r`nApprove? Click Yes, then confirm with your Windows Hello PIN or fingerprint. Click No to refuse."
  if (-not (Show-Question 'CRX Manager: approve a database change?' $text $true)) {
    Write-Result @{ ok = $false; status = 'Declined' }
    exit 3
  }
  $open = Wait-WinRt ($manager::OpenAsync($KeyName)) $retrieval
  if ("$($open.Status)" -ne 'Success') {
    Write-Result @{ ok = $false; status = "$($open.Status)" }
    exit 2
  }
  $data = $asBuffer.Invoke($null, @(,$bytes))
  $signOp = $credentialType.GetMethod('RequestSignAsync').Invoke($open.Credential, @($data))
  $signed = Wait-WinRt $signOp ([Windows.Security.Credentials.KeyCredentialOperationResult])
  if ("$($signed.Status)" -ne 'Success') {
    Write-Result @{ ok = $false; status = "$($signed.Status)" }
    exit 2
  }
  $signatureBuffer = [Windows.Security.Credentials.KeyCredentialOperationResult].GetProperty('Result').GetValue($signed)
  Write-Result @{ ok = $true; signature = (ConvertTo-Base64FromBuffer $signatureBuffer) }
  exit 0
}
catch {
  Write-Result @{ ok = $false; status = 'Error'; message = "$($_.Exception.Message)" }
  exit 2
}
