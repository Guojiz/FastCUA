#requires -Version 5.1
# SPDX-License-Identifier: MIT

[CmdletBinding()]
param(
  [ValidateSet('Install', 'Update', 'Check', 'Doctor')]
  [string]$Action = 'Install',
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'FastCUA'),
  [string]$SourcePath = '',
  [string]$NativeHostPath = '',
  [string]$Version = '',
  [string]$Repository = 'Guojiz/FastCUA',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$localManager = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'scripts\manage.ps1' } else { '' }
if ($localManager -and (Test-Path -LiteralPath $localManager)) {
  & $localManager @PSBoundParameters
  exit $LASTEXITCODE
}

$managerUrl = if ($env:FASTCUA_MANAGER_URL) {
  $env:FASTCUA_MANAGER_URL
} else {
  'https://raw.githubusercontent.com/Guojiz/FastCUA/main/scripts/manage.ps1'
}
$response = Invoke-WebRequest -UseBasicParsing -Uri $managerUrl -TimeoutSec 30
$manager = [scriptblock]::Create([string]$response.Content)
& $manager @PSBoundParameters
