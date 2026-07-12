#requires -Version 5.1
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'FastCUA'),
  [string]$SourcePath = '',
  [string]$NativeHostPath = '',
  [switch]$SkipClaudeInstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = 'https://github.com/Guojiz/FastCUA'
$appDir = Join-Path $InstallRoot 'app'
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('fastcua-install-' + [guid]::NewGuid().ToString('N'))

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Require-Command([string]$Name, [string]$WingetId) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw "$Name is required and WinGet is unavailable. Install $Name, then rerun this command."
  }
  Write-Host "Installing $Name..." -ForegroundColor Cyan
  & winget.exe install --id $WingetId --exact --source winget --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -ne 0) { throw "WinGet failed to install $Name (exit $LASTEXITCODE)." }
  Refresh-ProcessPath
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "$Name was installed but is not available in PATH yet. Open a new PowerShell window and rerun." }
  return $command.Source
}

try {
  if ($env:OS -ne 'Windows_NT') { throw 'FastCUA currently supports Windows only.' }
  Refresh-ProcessPath
  $node = Require-Command 'node.exe' 'OpenJS.NodeJS.LTS'
  $claude = if ($SkipClaudeInstall) { (Get-Command claude.exe -ErrorAction SilentlyContinue).Source } else { Require-Command 'claude.exe' 'Anthropic.ClaudeCode' }

  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
  if ($SourcePath) {
    $sourcePathResolved = (Resolve-Path -LiteralPath $SourcePath).Path
    $localSource = Join-Path $tempDir 'FastCUA-local'
    New-Item -ItemType Directory -Path $localSource -Force | Out-Null
    Get-ChildItem -LiteralPath $sourcePathResolved -Force |
      Where-Object Name -NotIn @('.git', 'helper') |
      Copy-Item -Destination $localSource -Recurse -Force
    Remove-Item -LiteralPath (Join-Path $localSource 'native-host\target') -Recurse -Force -ErrorAction SilentlyContinue
    $source = Get-Item $localSource
  } else {
    $archive = Join-Path $tempDir 'FastCUA.zip'
    Write-Host 'Downloading FastCUA...' -ForegroundColor Cyan
    Invoke-WebRequest -UseBasicParsing -Uri "$repo/archive/refs/heads/main.zip" -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $tempDir -Force
    $source = Get-ChildItem $tempDir -Directory | Where-Object Name -Like 'FastCUA-*' | Select-Object -First 1
    if (-not $source) { throw 'Downloaded archive did not contain the FastCUA source directory.' }
  }

  $hostTarget = Join-Path $source.FullName 'native-host\target\release\cua-native-host.exe'
  New-Item -ItemType Directory -Path (Split-Path -Parent $hostTarget) -Force | Out-Null
  if ($NativeHostPath) {
    $resolvedHost = (Resolve-Path -LiteralPath $NativeHostPath).Path
    Copy-Item -LiteralPath $resolvedHost -Destination $hostTarget -Force
  } else {
    $releaseBase = "$repo/releases/latest/download"
    $downloadedHost = Join-Path $tempDir 'cua-native-host.exe'
    $checksums = Join-Path $tempDir 'SHA256SUMS.txt'
    Write-Host 'Downloading the verified native host...' -ForegroundColor Cyan
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/cua-native-host.exe" -OutFile $downloadedHost
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/SHA256SUMS.txt" -OutFile $checksums
    $checksumLine = Get-Content $checksums | Where-Object { $_ -match 'cua-native-host\.exe$' } | Select-Object -First 1
    if (-not $checksumLine) { throw 'Release checksum for cua-native-host.exe is missing.' }
    $expected = ($checksumLine -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $downloadedHost -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw 'Native host checksum verification failed.' }
    Copy-Item -LiteralPath $downloadedHost -Destination $hostTarget -Force
  }

  $savedConfig = $null
  if (Test-Path (Join-Path $appDir 'config.json')) {
    $savedConfig = Get-Content -Raw (Join-Path $appDir 'config.json')
  }
  New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
  if (Test-Path $appDir) { Remove-Item -LiteralPath $appDir -Recurse -Force }
  Move-Item -LiteralPath $source.FullName -Destination $appDir
  if ($savedConfig) { [System.IO.File]::WriteAllText((Join-Path $appDir 'config.json'), $savedConfig, [System.Text.UTF8Encoding]::new($false)) }

  $skillTarget = Join-Path $HOME '.claude\skills\computer-use'
  New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $appDir 'skills\computer-use\SKILL.md') -Destination (Join-Path $skillTarget 'SKILL.md') -Force

  if ($claude) {
    $savedErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    & $claude mcp remove 'sky-computer-use' --scope user *> $null
    $ErrorActionPreference = $savedErrorPreference
    & $claude mcp add --scope user --transport stdio 'sky-computer-use' -- $node (Join-Path $appDir 'server.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Claude Code MCP registration failed.' }
  }

  Write-Host ''
  Write-Host 'FastCUA is ready.' -ForegroundColor Green
  Write-Host 'Open a new PowerShell window, configure your model provider, then run: claude'
  Write-Host 'Inside Claude Code, start with: /computer-use'
} finally {
  if (Test-Path $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
}
