#requires -Version 5.1
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'FastCUA'),
  [string]$SourcePath = '',
  [string]$NativeHostPath = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = 'https://github.com/Guojiz/FastCUA'
$Version = 'v0.1.2'
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
    Invoke-WebRequest -UseBasicParsing -Uri "$repo/archive/refs/tags/$Version.zip" -OutFile $archive
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
    $releaseBase = "$repo/releases/download/$Version"
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

  $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
  if (-not $desktop) { throw 'Unable to locate the current user desktop.' }
  $consoleShortcut = Join-Path $desktop 'FastCUA Console.url'
  $shortcutContents = "[InternetShortcut]`r`nURL=http://127.0.0.1:8420`r`nIconFile=$env:SystemRoot\System32\shell32.dll`r`nIconIndex=14`r`n"
  [System.IO.File]::WriteAllText($consoleShortcut, $shortcutContents, [System.Text.UTF8Encoding]::new($false))

  $agentPromptPath = Join-Path $desktop 'FastCUA Agent Setup.txt'
  $agentPrompt = @"
Set up FastCUA for this AI agent on Windows. Do not install or switch AI clients.

1. Read the Computer Use skill at:
   $appDir\skills\computer-use\SKILL.md
2. Add a stdio MCP server named sky-computer-use to your own MCP configuration:
   command: $node
   args: ["$appDir\server.mjs"]
3. Start or reconnect the MCP server.
4. Verify it by calling list_windows, then report which MCP configuration file you changed.

Keep FastCUA local. Do not expose its pipe or http://127.0.0.1:8420 beyond this computer.
"@
  [System.IO.File]::WriteAllText($agentPromptPath, $agentPrompt.Trim() + "`r`n", [System.Text.UTF8Encoding]::new($false))

  Write-Host ''
  Write-Host 'FastCUA is ready.' -ForegroundColor Green
  Write-Host "Desktop shortcut created: $consoleShortcut"
  Write-Host "Give this prompt to your MCP-compatible agent: $agentPromptPath"
} finally {
  if (Test-Path $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
}
