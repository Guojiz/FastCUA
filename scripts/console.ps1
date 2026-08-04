#requires -Version 5.1
# SPDX-License-Identifier: MIT
#
# Open the FastCUA control center as a standalone window.
#
# Uses Microsoft Edge in --app mode (a normal desktop window with its own
# taskbar entry, no tabs/address bar) pointing at the local daemon HTTP UI.
# Falls back to the default browser when Edge is not installed.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/console.ps1 [-Port 8420]

[CmdletBinding()]
param(
  [int]$Port = 8420
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$url = "http://127.0.0.1:$Port/"

# Edge --app mode: standalone window, own profile dir so it never collides
# with the user's normal Edge session (cookies, extensions, sign-in).
$edgeCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
)
$edge = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edge) {
  $profileDir = Join-Path $env:LOCALAPPDATA 'FastCUA\console-profile'
  $edgeArgs = @(
    "--app=$url",
    "--user-data-dir=$profileDir",
    '--no-first-run',
    '--window-size=1180,860'
  )
  Start-Process -FilePath $edge -ArgumentList $edgeArgs | Out-Null
} else {
  # No Edge: open in whatever default browser the user has.
  Start-Process $url | Out-Null
}
