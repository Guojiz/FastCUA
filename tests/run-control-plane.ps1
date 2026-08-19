# SPDX-License-Identifier: MIT

[CmdletBinding()]
param(
  [string]$Node = 'node',
  [string]$Binary = 'native-host\target\release\cua-native-host.exe',
  [string]$Fixture = 'tests\FastCuaFixture.exe'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$binaryPath = (Resolve-Path (Join-Path $root $Binary)).Path
$fixturePath = (Resolve-Path (Join-Path $root $Fixture)).Path
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('fastcua-control-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null

$pipe = '\\.\pipe\fastcua-control-' + [guid]::NewGuid().ToString('N')
$config = Join-Path $temp 'config.json'
$saved = @{}
foreach ($name in 'CUA_BIN','FASTCUA_PIPE','FASTCUA_CONFIG_PATH') {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$daemon = $null

try {
  $env:CUA_BIN = $binaryPath
  $env:FASTCUA_PIPE = $pipe
  $env:FASTCUA_CONFIG_PATH = $config
  $nodePath = (Get-Command $Node -ErrorAction Stop).Source
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $nodePath
  $startInfo.Arguments = '"' + (Join-Path $root 'daemon.mjs') + '"'
  $startInfo.WorkingDirectory = $root
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $daemon = [System.Diagnostics.Process]::new()
  $daemon.StartInfo = $startInfo
  $daemon.Start() | Out-Null
  Start-Sleep -Milliseconds 500

  & $Node (Join-Path $root 'tests\control-plane-integration.mjs') $pipe $fixturePath
  if ($LASTEXITCODE -ne 0) { throw "control-plane integration failed with exit code $LASTEXITCODE" }
} finally {
  if ($daemon -and -not $daemon.HasExited) {
    if (-not $daemon.HasExited) { & taskkill.exe /PID $daemon.Id /T /F | Out-Null }
  }
  foreach ($name in $saved.Keys) {
    [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
  }
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
