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
  [switch]$Force,
  [switch]$SkipDesktopIntegration
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$appDir = Join-Path $InstallRoot 'app'
$dataDir = Join-Path $InstallRoot 'data'
$statePath = Join-Path $InstallRoot 'install-state.json'
$runtimeAssetName = 'fastcua-runtime-win-x64.zip'
$checksumsAssetName = 'SHA256SUMS.txt'

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Ensure-Node {
  Refresh-ProcessPath
  if (Get-Command node.exe -ErrorAction SilentlyContinue) { return }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw 'Node.js 18 or newer is required and WinGet is unavailable.'
  }
  Write-Host 'Installing Node.js LTS...' -ForegroundColor Cyan
  & winget.exe install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -ne 0) { throw "WinGet failed to install Node.js (exit $LASTEXITCODE)." }
  Refresh-ProcessPath
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw 'Node.js was installed but is not yet available in PATH. Open a new PowerShell window and retry.'
  }
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Write-JsonFile([string]$Path, $Value) {
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($Path, $json + "`r`n", [System.Text.UTF8Encoding]::new($false))
}

function Normalize-Version([string]$Value) {
  return $Value.Trim().TrimStart('v')
}

function Compare-SemVer([string]$Left, [string]$Right) {
  $a = Normalize-Version $Left
  $b = Normalize-Version $Right
  if ($a -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$') { throw "Invalid version: $Left" }
  $ap = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
  $apr = $Matches[4]
  if ($b -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$') { throw "Invalid version: $Right" }
  $bp = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
  $bpr = $Matches[4]
  for ($i = 0; $i -lt 3; $i++) {
    if ($ap[$i] -gt $bp[$i]) { return 1 }
    if ($ap[$i] -lt $bp[$i]) { return -1 }
  }
  if ($apr -eq $bpr) { return 0 }
  if (-not $apr) { return 1 }
  if (-not $bpr) { return -1 }
  return [Math]::Sign([string]::CompareOrdinal($apr, $bpr))
}

function Get-LatestRelease {
  $headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'FastCUA-Installer'
    'X-GitHub-Api-Version' = '2022-11-28'
  }
  $uri = if ($Version) {
    "https://api.github.com/repos/$Repository/releases/tags/v$(Normalize-Version $Version)"
  } else {
    "https://api.github.com/repos/$Repository/releases/latest"
  }
  return Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri $uri -TimeoutSec 15
}

function Get-CurrentManifest {
  return Read-JsonFile (Join-Path $appDir 'runtime-manifest.json')
}

function Get-FileMap([string]$Root) {
  $result = [ordered]@{}
  Get-ChildItem -LiteralPath $Root -Recurse -File |
    Where-Object { $_.FullName -ne (Join-Path $Root 'runtime-manifest.json') } |
    Sort-Object FullName |
    ForEach-Object {
      $relative = $_.FullName.Substring($Root.Length).TrimStart('\').Replace('\', '/')
      $result[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  return $result
}

function Assert-Runtime([string]$Root) {
  $manifestPath = Join-Path $Root 'runtime-manifest.json'
  $manifest = Read-JsonFile $manifestPath
  if (-not $manifest) { throw "Runtime manifest is missing: $manifestPath" }
  if ($manifest.schemaVersion -ne 1) { throw "Unsupported runtime manifest schema: $($manifest.schemaVersion)" }
  if (-not $manifest.version) { throw 'Runtime manifest has no version.' }
  if ($manifest.platform -ne 'win32-x64') { throw "Unsupported runtime platform: $($manifest.platform)" }
  foreach ($required in @('server.mjs', 'daemon.mjs', 'lib/runtime.mjs', 'helper/cua-native-host.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $required))) {
      throw "Runtime file is missing: $required"
    }
  }
  if ($manifest.files) {
    foreach ($property in $manifest.files.PSObject.Properties) {
      $file = Join-Path $Root ($property.Name.Replace('/', '\'))
      if (-not (Test-Path -LiteralPath $file)) { throw "Manifest file is missing: $($property.Name)" }
      $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -ne [string]$property.Value) { throw "Runtime checksum mismatch: $($property.Name)" }
    }
  }
  return $manifest
}

function Copy-RuntimeFile([string]$SourceRoot, [string]$StageRoot, [string]$RelativePath) {
  $source = Join-Path $SourceRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source)) { throw "Required source file is missing: $RelativePath" }
  $destination = Join-Path $StageRoot $RelativePath
  $parent = Split-Path -Parent $destination
  if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

function New-LocalRuntime([string]$SourceRoot, [string]$StageRoot) {
  $sourceResolved = (Resolve-Path -LiteralPath $SourceRoot).Path
  New-Item -ItemType Directory -Path $StageRoot -Force | Out-Null
  foreach ($relative in @(
    'server.mjs', 'daemon.mjs', 'overlay.ps1', 'card.xaml', 'web.html',
    'install.ps1', 'uninstall.ps1', 'LICENSE', 'README.md', 'README_zh.md',
    'config.json', 'runtime-manifest.json', 'lib', 'skills', 'scripts/manage.ps1',
    'tools/skill-recorder/compile.mjs', 'tools/skill-recorder/dryrun.mjs',
    'tools/skill-recorder/frame-extract.mjs', 'tools/skill-recorder/lint-skill.mjs',
    'tools/skill-recorder/promote.mjs', 'tools/skill-recorder/synthesize.mjs',
    'tools/skill-recorder/writer-config.mjs'
  )) {
    Copy-RuntimeFile $sourceResolved $StageRoot $relative
  }

  $hostPath = if ($NativeHostPath) {
    (Resolve-Path -LiteralPath $NativeHostPath).Path
  } else {
    (Resolve-Path -LiteralPath (Join-Path $sourceResolved 'native-host\target\release\cua-native-host.exe')).Path
  }
  $hostDestination = Join-Path $StageRoot 'helper\cua-native-host.exe'
  New-Item -ItemType Directory -Path (Split-Path -Parent $hostDestination) -Force | Out-Null
  Copy-Item -LiteralPath $hostPath -Destination $hostDestination -Force

  $recorder = Join-Path $sourceResolved 'tools\skill-recorder\target\release\skill-recorder.exe'
  if (Test-Path -LiteralPath $recorder) {
    $recorderDestination = Join-Path $StageRoot 'tools\skill-recorder\target\release\skill-recorder.exe'
    New-Item -ItemType Directory -Path (Split-Path -Parent $recorderDestination) -Force | Out-Null
    Copy-Item -LiteralPath $recorder -Destination $recorderDestination -Force
  }

  $manifest = Read-JsonFile (Join-Path $StageRoot 'runtime-manifest.json')
  $commit = 'local'
  try {
    $commit = (& git -C $sourceResolved rev-parse HEAD 2>$null).Trim()
    $dirty = & git -C $sourceResolved status --porcelain --untracked-files=no 2>$null
    if ($dirty) { $commit += '-dirty' }
  } catch {}
  $manifest.channel = 'local'
  $manifest.buildType = 'local-install'
  $manifest.commit = $commit
  $manifest.buildTime = [DateTime]::UtcNow.ToString('o')
  $manifest | Add-Member -NotePropertyName defaultPort -NotePropertyValue 8420 -Force
  $manifest | Add-Member -NotePropertyName files -NotePropertyValue (Get-FileMap $StageRoot) -Force
  Write-JsonFile (Join-Path $StageRoot 'runtime-manifest.json') $manifest
  return $manifest
}

function Get-ReleaseRuntime([string]$TempRoot, $Release) {
  $runtimeAsset = $Release.assets | Where-Object name -eq $runtimeAssetName | Select-Object -First 1
  $checksumsAsset = $Release.assets | Where-Object name -eq $checksumsAssetName | Select-Object -First 1
  if (-not $runtimeAsset -or -not $checksumsAsset) {
    throw "Release $($Release.tag_name) is missing $runtimeAssetName or $checksumsAssetName."
  }
  $archive = Join-Path $TempRoot $runtimeAssetName
  $checksums = Join-Path $TempRoot $checksumsAssetName
  Invoke-WebRequest -UseBasicParsing -Uri $runtimeAsset.browser_download_url -OutFile $archive -TimeoutSec 60
  Invoke-WebRequest -UseBasicParsing -Uri $checksumsAsset.browser_download_url -OutFile $checksums -TimeoutSec 30
  $line = Get-Content -LiteralPath $checksums | Where-Object { $_ -match ([regex]::Escape($runtimeAssetName) + '$') } | Select-Object -First 1
  if (-not $line) { throw "Checksum is missing for $runtimeAssetName." }
  $expected = ($line -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw 'Runtime package checksum verification failed.' }
  $expanded = Join-Path $TempRoot 'expanded'
  Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
  $root = if (Test-Path -LiteralPath (Join-Path $expanded 'runtime-manifest.json')) {
    $expanded
  } else {
    Get-ChildItem -LiteralPath $expanded -Directory |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'runtime-manifest.json') } |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $root) { throw 'Runtime package does not contain runtime-manifest.json.' }
  $manifest = Assert-Runtime $root
  if ((Normalize-Version $manifest.version) -ne (Normalize-Version $Release.tag_name)) {
    throw "Runtime version $($manifest.version) does not match release $($Release.tag_name)."
  }
  return $root
}

function Stop-InstalledRuntime {
  $config = Read-JsonFile (Join-Path $dataDir 'config.json')
  $port = if ($config -and $config.port) { [int]$config.port } else { 8420 }
  try {
    Invoke-RestMethod -UseBasicParsing -Method Post -ContentType 'application/json' `
      -Body '{"action":"shutdown"}' -Uri "http://127.0.0.1:$port/api/action" -TimeoutSec 3 | Out-Null
    Start-Sleep -Milliseconds 500
  } catch {}
}

function Write-DesktopFiles($Manifest) {
  $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
  if (-not $desktop) { return }
  $config = Read-JsonFile (Join-Path $dataDir 'config.json')
  $port = if ($config -and $config.port) { [int]$config.port } elseif ($Manifest.defaultPort) { [int]$Manifest.defaultPort } else { 8420 }
  $consoleShortcut = Join-Path $desktop 'FastCUA Console.url'
  $shortcut = "[InternetShortcut]`r`nURL=http://127.0.0.1:$port`r`nIconFile=$env:SystemRoot\System32\shell32.dll`r`nIconIndex=14`r`n"
  [System.IO.File]::WriteAllText($consoleShortcut, $shortcut, [System.Text.UTF8Encoding]::new($false))

  $agentPromptPath = Join-Path $desktop 'FastCUA Agent Setup.txt'
  $agentPrompt = @"
Install FastCUA into this AI agent on Windows. Configure this agent's own active Skill and MCP systems; do not substitute another Computer Use implementation.

A successful setup requires BOTH:
1. Copy or register the complete Skill folder from:
   $appDir\skills\computer-use
2. Add a stdio MCP server named sky-computer-use:
   command: node
   args: ["$appDir\server.mjs"]

After reloading the client, call runtime_info and list_apps. runtime_info must report:
   root: $appDir
   version: $($Manifest.version)

If runtime_info reports another directory or version, stop and run:
   npx fastcua doctor

Do not install a forwarding or shortened SKILL.md. Do not expose the local pipe or control center outside this computer.
"@
  [System.IO.File]::WriteAllText($agentPromptPath, $agentPrompt.Trim() + "`r`n", [System.Text.UTF8Encoding]::new($false))
}

function Install-Runtime([string]$PreparedRoot, $Manifest, [string]$SourceLabel) {
  New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $dataDir 'config.json'))) {
    $legacyConfig = Join-Path $appDir 'config.json'
    if (Test-Path -LiteralPath $legacyConfig) {
      Copy-Item -LiteralPath $legacyConfig -Destination (Join-Path $dataDir 'config.json') -Force
    }
  }

  Stop-InstalledRuntime
  $previousDir = Join-Path $InstallRoot 'app.previous'
  $movedCurrent = $false
  try {
    if (Test-Path -LiteralPath $previousDir) {
      Remove-Item -LiteralPath $previousDir -Recurse -Force
    }
    if (Test-Path -LiteralPath $appDir) {
      Move-Item -LiteralPath $appDir -Destination $previousDir
      $movedCurrent = $true
    }
    Move-Item -LiteralPath $PreparedRoot -Destination $appDir
    $installedManifest = Assert-Runtime $appDir
    Write-JsonFile $statePath ([ordered]@{
      schemaVersion = 1
      version = [string]$installedManifest.version
      commit = [string]$installedManifest.commit
      installedAt = [DateTime]::UtcNow.ToString('o')
      source = $SourceLabel
      appDir = $appDir
      previousAvailable = $movedCurrent
    })
    if (-not $SkipDesktopIntegration) { Write-DesktopFiles $installedManifest }
    Write-Host "FastCUA $($installedManifest.version) is ready at $appDir" -ForegroundColor Green
    if ($movedCurrent) { Write-Host "Rollback copy retained at $previousDir" }
  } catch {
    if (Test-Path -LiteralPath $appDir) {
      Remove-Item -LiteralPath $appDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($movedCurrent -and (Test-Path -LiteralPath $previousDir)) {
      Move-Item -LiteralPath $previousDir -Destination $appDir
    }
    throw
  }
}

function Invoke-Check {
  $current = Get-CurrentManifest
  $release = Get-LatestRelease
  $latest = Normalize-Version $release.tag_name
  if (-not $current) {
    Write-Host "FastCUA is not installed. Latest release: $latest"
    return
  }
  $comparison = Compare-SemVer $latest ([string]$current.version)
  if ($comparison -gt 0) {
    Write-Host "Update available: $($current.version) -> $latest" -ForegroundColor Yellow
  } else {
    Write-Host "FastCUA $($current.version) is current." -ForegroundColor Green
  }
}

function Get-ConfiguredServerPaths {
  $files = @(
    (Join-Path $HOME '.codex\config.toml'),
    (Join-Path $HOME '.codex\.mcp.json'),
    (Join-Path $HOME '.claude.json'),
    (Join-Path $HOME 'AppData\Roaming\Code\User\mcp.json'),
    (Join-Path $HOME 'repos\.mcp.json')
  )
  $paths = @()
  foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $text = Get-Content -LiteralPath $file -Raw
    foreach ($match in [regex]::Matches($text, '(?i)[A-Z]:[\\/][^"''\]\r\n]*server\.mjs')) {
      if ($match.Value -match '(?i)FastCUA') {
        $paths += $match.Value.Replace('\\', '\')
      }
    }
  }
  return @($paths | Sort-Object -Unique)
}

function Invoke-Doctor {
  $issues = New-Object System.Collections.Generic.List[string]
  $warnings = New-Object System.Collections.Generic.List[string]
  $manifest = $null
  try {
    $manifest = Assert-Runtime $appDir
    Write-Host "Installed runtime: $($manifest.version) [$($manifest.commit)]"
    Write-Host "Runtime root:      $appDir"
  } catch {
    $issues.Add($_.Exception.Message)
  }

  $configured = @(Get-ConfiguredServerPaths)
  if ($configured.Count) {
    Write-Host 'Configured MCP server paths:'
    $configured | ForEach-Object { Write-Host "  $_" }
    $roots = @($configured | ForEach-Object { Split-Path -Parent $_ } | Sort-Object -Unique)
    if ($roots.Count -gt 1) { $warnings.Add("Multiple FastCUA MCP roots are configured: $($roots -join ', ')") }
  } else {
    $warnings.Add('No FastCUA MCP server path was found in the known AI client configuration files.')
  }

  $config = Read-JsonFile (Join-Path $dataDir 'config.json')
  $port = if ($config -and $config.port) { [int]$config.port } else { 8420 }
  try {
    $live = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$port/api/state" -TimeoutSec 3
    if ($live.runtime) {
      Write-Host "Live daemon:       $($live.runtime.root) v$($live.runtime.version)"
      if ($manifest -and ([System.IO.Path]::GetFullPath([string]$live.runtime.root) -ne [System.IO.Path]::GetFullPath($appDir))) {
        $issues.Add("Port $port is served by another FastCUA root: $($live.runtime.root)")
      }
    } else {
      $warnings.Add("Port $port is served by an older FastCUA without runtime identity.")
    }
  } catch {
    Write-Host "Live daemon:       not running"
  }

  try {
    $daemonRoots = @(Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match '(?i)FastCUA.*daemon\.mjs' } |
      ForEach-Object {
        if ($_.CommandLine -match '"([^"]*FastCUA[^"]*daemon\.mjs)"') { Split-Path -Parent $Matches[1] }
      } | Sort-Object -Unique)
    if ($daemonRoots.Count -gt 1) {
      $warnings.Add("Multiple FastCUA daemon roots are running: $($daemonRoots -join ', ')")
    }
  } catch {
    $warnings.Add('Process command lines could not be inspected; runtime identity checks still completed.')
  }

  foreach ($warning in $warnings) { Write-Warning $warning }
  if ($issues.Count) {
    foreach ($issue in $issues) { Write-Error $issue -ErrorAction Continue }
    throw "FastCUA doctor found $($issues.Count) blocking issue(s)."
  }
  Write-Host 'FastCUA doctor passed.' -ForegroundColor Green
}

switch ($Action) {
  'Check' {
    Invoke-Check
    break
  }
  'Doctor' {
    Invoke-Doctor
    break
  }
  default {
    Ensure-Node
    $current = Get-CurrentManifest
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('fastcua-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    try {
      if ($SourcePath) {
        $prepared = Join-Path $tempDir 'runtime'
        $targetManifest = New-LocalRuntime $SourcePath $prepared
        $sourceLabel = "local:$((Resolve-Path -LiteralPath $SourcePath).Path)"
      } else {
        $release = Get-LatestRelease
        $latest = Normalize-Version $release.tag_name
        if ($Action -eq 'Update' -and $current -and -not $Force -and (Compare-SemVer $latest ([string]$current.version)) -le 0) {
          Write-Host "FastCUA $($current.version) is already current." -ForegroundColor Green
          break
        }
        $prepared = Get-ReleaseRuntime $tempDir $release
        $targetManifest = Assert-Runtime $prepared
        $sourceLabel = [string]$release.html_url
      }
      Install-Runtime $prepared $targetManifest $sourceLabel
    } finally {
      if (Test-Path -LiteralPath $tempDir) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
  }
}
