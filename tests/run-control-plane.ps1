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

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$pipe = '\\.\pipe\fastcua-control-' + [guid]::NewGuid().ToString('N')
$config = Join-Path $temp 'config.json'
$saved = @{}
foreach ($name in 'CUA_BIN','FASTCUA_PIPE','FASTCUA_HTTP_PORT','FASTCUA_CONFIG_PATH','FASTCUA_DISABLE_OVERLAY') {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$daemon = $null

try {
  $env:CUA_BIN = $binaryPath
  $env:FASTCUA_PIPE = $pipe
  $env:FASTCUA_HTTP_PORT = [string]$port
  $env:FASTCUA_CONFIG_PATH = $config
  $env:FASTCUA_DISABLE_OVERLAY = '1'
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
  $base = "http://127.0.0.1:$port"
  $ready = $false
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    try {
      Invoke-RestMethod "$base/api/state" -TimeoutSec 1 | Out-Null
      $ready = $true
      break
    } catch {
      Start-Sleep -Milliseconds 100
    }
  }
  if (-not $ready) { throw 'FastCUA daemon did not become ready.' }

  & $Node (Join-Path $root 'tests\control-plane-integration.mjs') $base $fixturePath
  if ($LASTEXITCODE -ne 0) { throw "control-plane integration failed with exit code $LASTEXITCODE" }
} finally {
  if ($daemon -and -not $daemon.HasExited) {
    try {
      Invoke-RestMethod "http://127.0.0.1:$port/api/action" -Method Post -ContentType 'application/json' -Body '{"action":"shutdown"}' -TimeoutSec 2 | Out-Null
      [void]$daemon.WaitForExit(3000)
    } catch {}
    if (-not $daemon.HasExited) { & taskkill.exe /PID $daemon.Id /T /F | Out-Null }
  }
  foreach ($name in $saved.Keys) {
    [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
  }
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
