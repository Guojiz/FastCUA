#requires -Version 5.1
# SPDX-License-Identifier: MIT

[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\dist'),
  [string]$Version = '',
  [string]$Commit = '',
  [string]$BuildTime = ''
)

$ErrorActionPreference = 'Stop'

function Normalize-Version([string]$Value) {
  return $Value.Trim().TrimStart('v')
}
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -LiteralPath (Join-Path $root 'runtime-manifest.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = [string]$manifest.version }
if (-not $Commit) {
  $Commit = (& git -C $root rev-parse HEAD).Trim()
  $dirty = & git -C $root status --porcelain --untracked-files=no
  if ($dirty) { $Commit += '-dirty' }
}
if (-not $BuildTime) { $BuildTime = [DateTime]::UtcNow.ToString('o') }

& cargo build --release --locked --manifest-path (Join-Path $root 'native-host\Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw "Native host build failed: $LASTEXITCODE" }
& cargo build --release --locked --manifest-path (Join-Path $root 'tools\skill-recorder\Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw "Skill recorder build failed: $LASTEXITCODE" }

$stageParent = Join-Path ([System.IO.Path]::GetTempPath()) ('fastcua-release-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $stageParent 'FastCUA'
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  foreach ($relative in @(
    'server.mjs', 'daemon.mjs', 'overlay.ps1', 'card.xaml', 'web.html',
    'install.ps1', 'uninstall.ps1', 'LICENSE', 'README.md', 'README_zh.md',
    'config.json', 'runtime-manifest.json', 'lib', 'skills', 'scripts/manage.ps1',
    'tools/skill-recorder/compile.mjs', 'tools/skill-recorder/dryrun.mjs',
    'tools/skill-recorder/frame-extract.mjs', 'tools/skill-recorder/lint-skill.mjs',
    'tools/skill-recorder/promote.mjs', 'tools/skill-recorder/synthesize.mjs',
    'tools/skill-recorder/writer-config.mjs'
  )) {
    $source = Join-Path $root $relative
    $destination = Join-Path $stage $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
  }
  New-Item -ItemType Directory -Path (Join-Path $stage 'helper') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $root 'native-host\target\release\cua-native-host.exe') `
    -Destination (Join-Path $stage 'helper\cua-native-host.exe') -Force
  $recorderDestination = Join-Path $stage 'tools\skill-recorder\target\release\skill-recorder.exe'
  New-Item -ItemType Directory -Path (Split-Path -Parent $recorderDestination) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $root 'tools\skill-recorder\target\release\skill-recorder.exe') `
    -Destination $recorderDestination -Force

  $releaseManifest = Get-Content -LiteralPath (Join-Path $stage 'runtime-manifest.json') -Raw | ConvertFrom-Json
  $releaseManifest.version = (Normalize-Version $Version)
  $releaseManifest.channel = 'stable'
  $releaseManifest.buildType = 'release'
  $releaseManifest.commit = $Commit
  $releaseManifest.buildTime = $BuildTime
  $releaseManifest | Add-Member -NotePropertyName defaultPort -NotePropertyValue 8420 -Force
  $files = [ordered]@{}
  Get-ChildItem -LiteralPath $stage -Recurse -File |
    Where-Object Name -ne 'runtime-manifest.json' |
    Sort-Object FullName |
    ForEach-Object {
      $relative = $_.FullName.Substring($stage.Length).TrimStart('\').Replace('\', '/')
      $files[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  $releaseManifest | Add-Member -NotePropertyName files -NotePropertyValue $files -Force
  [System.IO.File]::WriteAllText(
    (Join-Path $stage 'runtime-manifest.json'),
    ($releaseManifest | ConvertTo-Json -Depth 20) + "`r`n",
    [System.Text.UTF8Encoding]::new($false)
  )

  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  $archive = Join-Path $OutputDirectory 'fastcua-runtime-win-x64.zip'
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  [System.IO.File]::WriteAllText(
    (Join-Path $OutputDirectory 'SHA256SUMS.txt'),
    "$hash  fastcua-runtime-win-x64.zip`r`n",
    [System.Text.Encoding]::ASCII
  )
  Copy-Item -LiteralPath (Join-Path $stage 'runtime-manifest.json') `
    -Destination (Join-Path $OutputDirectory 'runtime-manifest.json') -Force
  Write-Host "Release package: $archive"
  Write-Host "SHA-256: $hash"
} finally {
  if (Test-Path -LiteralPath $stageParent) {
    Remove-Item -LiteralPath $stageParent -Recurse -Force -ErrorAction SilentlyContinue
  }
}
