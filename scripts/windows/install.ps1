#Requires -Version 5.0
<#
  Registers a "Share with Thawdrop" entry in the Windows Explorer right-click
  menu for any file, pointing at the packaged Thawdrop.exe.

  Usage (after `npm run desktop:build` produced an NSIS installer under
  apps\desktop\src-tauri\target\release\bundle\nsis\, and you've run it):

    powershell -ExecutionPolicy Bypass -File .\install.ps1 -ExePath "C:\Program Files\Thawdrop\Thawdrop.exe"
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$ExePath
)

if (-not (Test-Path $ExePath)) {
  Write-Error "Thawdrop executable not found at: $ExePath"
  exit 1
}

$shellKey = 'HKCU:\Software\Classes\*\shell\ThawdropShare'
$commandKey = "$shellKey\command"

New-Item -Path $shellKey -Force | Out-Null
Set-ItemProperty -Path $shellKey -Name '(default)' -Value 'Share with Thawdrop'
Set-ItemProperty -Path $shellKey -Name 'Icon' -Value "`"$ExePath`",0"

New-Item -Path $commandKey -Force | Out-Null
Set-ItemProperty -Path $commandKey -Name '(default)' -Value "`"$ExePath`" --share `"%1`""

Write-Host "Installed. Right-click any file in Explorer and look for 'Share with Thawdrop'."
Write-Host "To remove: Remove-Item -Recurse 'HKCU:\Software\Classes\*\shell\ThawdropShare'"
