#requires -Version 5.1
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding(SupportsShouldProcess)]
param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'FastCUA'))

$ErrorActionPreference = 'Stop'
$claude = Get-Command claude.exe -ErrorAction SilentlyContinue
if ($claude) {
  $savedErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  & $claude.Source mcp remove 'sky-computer-use' --scope user *> $null
  $ErrorActionPreference = $savedErrorPreference
}

$skill = Join-Path $HOME '.claude\skills\computer-use'
if ((Test-Path $skill) -and $PSCmdlet.ShouldProcess($skill, 'Remove FastCUA skill')) {
  Remove-Item -LiteralPath $skill -Recurse -Force
}
if ((Test-Path $InstallRoot) -and $PSCmdlet.ShouldProcess($InstallRoot, 'Remove FastCUA application files')) {
  Remove-Item -LiteralPath $InstallRoot -Recurse -Force
}
Write-Host 'FastCUA was removed. Claude Code itself was left installed.' -ForegroundColor Green
