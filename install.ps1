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
$Version = 'v0.1.7'
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
Install FastCUA into this AI agent on Windows. By default, configure this agent's own active Skill system and MCP configuration. Do not install into or switch to another AI client unless the user explicitly names that client.

A successful FastCUA setup requires BOTH the Skill and the MCP server. Partial installation is a failure.

1. Install the complete FastCUA Skill folder into this agent's own active Skill directory or Skill registry:
   source: $appDir\skills\computer-use
   skill name: computer-use
   Do not merely read SKILL.md from the source directory. Do not create a forwarding, wrapper, summary, or shortened SKILL.md that points back to the source. Copy or register the complete folder without rewriting its contents, then reload or reindex Skills.
   If this client uses a filesystem Skill directory, recursively compare the installed relative file list and SHA-256 hashes with the source folder. If it uses a native Skill registry, verify that the active registration resolves to the complete source folder and includes all neighboring resources.
2. Add a stdio MCP server named sky-computer-use to this agent's own MCP configuration:
   command: $node
   args: ["$appDir\server.mjs"]
3. Start or reconnect the MCP server and reload the installed Skill if required by this client.
4. Verify BOTH parts:
   - confirm that the active computer-use Skill resolves to the complete installed folder, not a forwarding stub, and is discoverable by this agent;
   - call list_windows through sky-computer-use and confirm that it returns actual Windows window data.
5. Report the exact Skill destination or registration you changed and the exact MCP configuration file you changed.

Reading the source Skill file alone is not installation. A forwarding or shortened SKILL.md is not installation. Adding only MCP is not installation. Installing only the Skill is not installation. Do not report success until the full Skill and MCP checks both pass.

If this AI client cannot install or register local Skills, cannot add a custom stdio MCP server, or cannot verify both parts, stop and report the incompatibility. Do not substitute PowerShell, SendKeys, pyautogui, shell scripts, browser automation, or another desktop-control mechanism.

Keep FastCUA local. Do not expose its pipe or http://127.0.0.1:8420 beyond this computer.
"@
  [System.IO.File]::WriteAllText($agentPromptPath, $agentPrompt.Trim() + "`r`n", [System.Text.UTF8Encoding]::new($false))

  Write-Host ''
  Write-Host 'FastCUA runtime is ready.' -ForegroundColor Green
  Write-Host "Desktop shortcut created: $consoleShortcut"
  Write-Host "Give this mandatory Skill + MCP installation prompt to the agent that will use FastCUA: $agentPromptPath"
} finally {
  if (Test-Path $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
}
