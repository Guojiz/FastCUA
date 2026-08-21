#requires -Version 5.1
# SPDX-License-Identifier: MIT
#
# FastCUA agent self-setup.
# Registers the sky-computer-use MCP server and installs the computer-use
# Skill into supported AI agent hosts, then verifies the runtime end-to-end.
#
# Usage:
#   .\scripts\agent-setup.ps1 -Action List
#   .\scripts\agent-setup.ps1 -Action Install            # all detected agents
#   .\scripts\agent-setup.ps1 -Action Install -Agent qoder,claude
#   .\scripts\agent-setup.ps1 -Action Verify
#
# Supported agents: qoder, claude, claude-desktop, codex, vscode, opencode, kimi

[CmdletBinding()]
param(
  [ValidateSet('List', 'Install', 'Verify')]
  [string]$Action = 'List',
  [string[]]$Agent = @(),
  [string]$AppDir = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step([string]$Message) { Write-Host $Message -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "  [ok] $Message" -ForegroundColor Green }
function Write-Skip([string]$Message) { Write-Host "  [--] $Message" -ForegroundColor DarkGray }
function Write-Warn2([string]$Message){ Write-Host "  [!!] $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "  [xx] $Message" -ForegroundColor Red }

# ---------------------------------------------------------------- runtime ---

function Get-AppDir {
  if ($script:AppDir) { return $script:AppDir }
  $installed = Join-Path $env:LOCALAPPDATA 'FastCUA\app'
  if (Test-Path -LiteralPath (Join-Path $installed 'server.mjs')) { return $installed }
  $repo = Join-Path $PSScriptRoot '..'
  if (Test-Path -LiteralPath (Join-Path $repo 'server.mjs')) {
    return (Resolve-Path -LiteralPath $repo).Path
  }
  throw 'FastCUA runtime not found. Install it first (irm install.ps1 | iex) or pass -AppDir.'
}

function Get-RuntimeVersion([string]$Dir) {
  $manifest = Join-Path $Dir 'runtime-manifest.json'
  if (Test-Path -LiteralPath $manifest) {
    $json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    return [string]$json.version
  }
  return 'unknown'
}

# ----------------------------------------------------------------- agents ---
# Each agent: where its MCP config lives, which JSON key holds servers,
# the JSON shape for one server entry, and where its skills folder lives
# ($null when the host has no skill system).

function Get-AgentRegistry([string]$AppDir) {
  $serverMjs = (Join-Path $AppDir 'server.mjs')
  $skillSource = Join-Path $AppDir 'skills\computer-use'

  [ordered]@{
    'qoder' = @{
      Label       = 'Qoder'
      McpConfig   = (Join-Path $HOME '.qoder\mcp.json')
      McpRootKey  = 'mcpServers'
      McpEntry    = [ordered]@{ command = 'node'; args = @($serverMjs) }
      SkillsDir   = (Join-Path $HOME '.qoder\skills')
      SkillSource = $skillSource
      Detect      = { Test-Path -LiteralPath (Join-Path $HOME '.qoder') }
    }
    'claude' = @{
      Label       = 'Claude Code'
      McpConfig   = (Join-Path $HOME '.claude.json')
      McpRootKey  = 'mcpServers'
      McpEntry    = [ordered]@{ command = 'node'; args = @($serverMjs) }
      SkillsDir   = (Join-Path $HOME '.claude\skills')
      SkillSource = $skillSource
      Detect      = { (Test-Path -LiteralPath (Join-Path $HOME '.claude.json')) -or (Test-Path -LiteralPath (Join-Path $HOME '.claude')) }
    }
    'claude-desktop' = @{
      Label       = 'Claude Desktop'
      McpConfig   = (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json')
      McpRootKey  = 'mcpServers'
      McpEntry    = [ordered]@{ command = 'node'; args = @($serverMjs) }
      SkillsDir   = $null
      SkillSource = $null
      Detect      = { Test-Path -LiteralPath (Join-Path $env:APPDATA 'Claude') }
    }
    'codex' = @{
      Label       = 'Codex CLI'
      McpConfig   = (Join-Path $HOME '.codex\.mcp.json')
      McpRootKey  = 'mcpServers'
      McpEntry    = [ordered]@{ command = 'node'; args = @($serverMjs) }
      SkillsDir   = (Join-Path $HOME '.codex\skills')
      SkillSource = $skillSource
      Detect      = { Test-Path -LiteralPath (Join-Path $HOME '.codex') }
    }
    'vscode' = @{
      Label       = 'VS Code (Copilot MCP)'
      McpConfig   = (Join-Path $env:APPDATA 'Code\User\mcp.json')
      McpRootKey  = 'servers'
      McpEntry    = [ordered]@{ type = 'stdio'; command = 'node'; args = @($serverMjs) }
      SkillsDir   = $null
      SkillSource = $null
      Detect      = { Test-Path -LiteralPath (Join-Path $env:APPDATA 'Code\User') }
    }
    'opencode' = @{
      Label       = 'opencode'
      McpConfig   = (Join-Path $HOME '.config\opencode\opencode.json')
      McpRootKey  = 'mcp'
      McpEntry    = [ordered]@{ type = 'local'; command = @('node', $serverMjs); enabled = $true }
      SkillsDir   = (Join-Path $HOME '.config\opencode\skills')
      SkillSource = $skillSource
      Detect      = { Test-Path -LiteralPath (Join-Path $HOME '.config\opencode') }
    }
    'kimi' = @{
      Label       = 'Kimi Work'
      McpConfig   = $null
      McpRootKey  = $null
      McpEntry    = $null
      SkillsDir   = (Join-Path $env:APPDATA 'kimi-desktop\daimon-share\daimon\skills')
      SkillSource = $skillSource
      Detect      = { Test-Path -LiteralPath (Join-Path $env:APPDATA 'kimi-desktop') }
    }
  }
}

# ------------------------------------------------------------------- json ---

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $raw = Get-Content -LiteralPath $Path -Raw
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return ($raw | ConvertFrom-Json)
}

function Write-JsonFile([string]$Path, $Value) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  if (Test-Path -LiteralPath $Path) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item -LiteralPath $Path -Destination "$Path.bak.$stamp" -Force
  }
  $json = ConvertTo-Json -InputObject $Value -Depth 20
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Get-ConfiguredServerPath([string]$ConfigPath, [string]$RootKey) {
  $json = Read-JsonFile $ConfigPath
  if (-not $json) { return $null }
  $servers = $json.PSObject.Properties[$RootKey]
  if (-not $servers) { return $null }
  $entry = $servers.Value.PSObject.Properties['sky-computer-use']
  if (-not $entry) { return $null }
  $argsProp = $entry.Value.PSObject.Properties['args']
  if (-not $argsProp) { $argsProp = $entry.Value.PSObject.Properties['command'] }  # opencode shape
  if (-not $argsProp -or @($argsProp.Value).Count -lt 1) { return $null }
  foreach ($arg in @($argsProp.Value)) {
    if ([string]$arg -match 'server\.mjs$') { return [string]$arg }
  }
  return $null
}

function Set-McpEntry($Def, [string]$AppDir) {
  $configPath = $Def.McpConfig
  $rootKey = $Def.McpRootKey
  $json = Read-JsonFile $configPath
  if (-not $json) { $json = [pscustomobject]@{} }
  if (-not $json.PSObject.Properties[$rootKey]) {
    $json | Add-Member -NotePropertyName $rootKey -NotePropertyValue ([pscustomobject]@{})
  }
  $servers = $json.$rootKey
  $entry = [pscustomobject]$Def.McpEntry
  if ($servers.PSObject.Properties['sky-computer-use']) {
    $servers.PSObject.Properties['sky-computer-use'].Value = $entry
  } else {
    $servers | Add-Member -NotePropertyName 'sky-computer-use' -NotePropertyValue $entry
  }
  if ($DryRun) {
    Write-Skip "dry-run: would write $($Def.Label) MCP config at $configPath"
    return
  }
  Write-JsonFile $configPath $json
  Write-Ok "$($Def.Label) MCP registered -> $configPath"
}

function Install-Skill($Def) {
  if (-not $Def.SkillsDir) {
    Write-Skip "$($Def.Label) has no skill system; MCP only"
    return
  }
  $target = Join-Path $Def.SkillsDir 'computer-use'
  if ($DryRun) {
    Write-Skip "dry-run: would copy skill to $target"
    return
  }
  if (-not (Test-Path -LiteralPath $Def.SkillsDir)) {
    New-Item -ItemType Directory -Path $Def.SkillsDir -Force | Out-Null
  }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  Copy-Item -LiteralPath $Def.SkillSource -Destination $target -Recurse -Force
  Write-Ok "$($Def.Label) skill installed -> $target"
}

# ------------------------------------------------------------ smoke test ---

$script:SmokePaused = $false

function Test-McpSmoke([string]$AppDir) {
  $script:SmokePaused = $false
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Write-Fail 'node not found on PATH'; return $false }
  $serverMjs = Join-Path $AppDir 'server.mjs'

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node.Source
  $psi.Arguments = "`"$serverMjs`""
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true

  $init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"fastcua-agent-setup","version":"1.0"}}}'
  $ready = '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  $call = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_windows","arguments":{}}}'

  $proc = [System.Diagnostics.Process]::Start($psi)
  try {
    $proc.StandardInput.WriteLine($init)
    $proc.StandardInput.Flush()
    $succeeded = $false
    $deadline = (Get-Date).AddSeconds(30)
    $initialized = $false
    while ((Get-Date) -lt $deadline) {
      $task = $proc.StandardOutput.ReadLineAsync()
      if (-not $task.Wait(2000)) { continue }
      $line = $task.Result
      if ($null -eq $line) { break }
      if (-not $initialized -and $line -match '"id"\s*:\s*1') {
        $proc.StandardInput.WriteLine($ready)
        $proc.StandardInput.WriteLine($call)
        $proc.StandardInput.Flush()
        $initialized = $true
      }
      if ($initialized -and $line -match '"id"\s*:\s*2') {
        if ($line -match 'control_plane:paused') {
          $script:SmokePaused = $true
        }
        $succeeded = ($line -match '"result"') -and
                     ($line -notmatch '"error"\s*:') -and
                     ($line -notmatch '"isError"\s*:\s*true')
        break
      }
    }
    return $succeeded
  } finally {
    try {
      if (-not $proc.HasExited) { $proc.Kill() }
      $proc.Dispose()
    } catch { }
  }
}

# ----------------------------------------------------------------- actions ---

function Select-Agents($Registry) {
  if ($Agent -and $Agent.Count -gt 0) {
    $chosen = @()
    foreach ($name in $Agent) {
      if (-not $Registry.Contains($name)) {
        throw "Unknown agent '$name'. Known: $($Registry.Keys -join ', ')"
      }
      $chosen += $name
    }
    return $chosen
  }
  $detected = @()
  foreach ($name in $Registry.Keys) {
    if (& $Registry[$name].Detect) { $detected += $name }
  }
  return $detected
}

function Invoke-List($Registry, [string]$AppDir) {
  Write-Step "FastCUA runtime: $AppDir (v$(Get-RuntimeVersion $AppDir))"
  Write-Host ''
  foreach ($name in $Registry.Keys) {
    $def = $Registry[$name]
    $present = & $def.Detect
    if (-not $present) { Write-Skip "$($def.Label): not detected"; continue }
    $line = "$($def.Label): detected"
    if ($def.McpConfig) {
      $configured = Get-ConfiguredServerPath $def.McpConfig $def.McpRootKey
      if ($configured) {
        if ($configured -ieq (Join-Path $AppDir 'server.mjs')) {
          $line += ", MCP configured (current runtime)"
        } else {
          $line += ", MCP configured but STALE -> $configured"
        }
      } else {
        $line += ', MCP not configured'
      }
    } else {
      $line += ', MCP n/a'
    }
    if ($def.SkillsDir) {
      $skill = Join-Path $def.SkillsDir 'computer-use\SKILL.md'
      $line += if (Test-Path -LiteralPath $skill) { ', skill installed' } else { ', skill missing' }
    }
    Write-Host "  $line"
  }
  Write-Host ''
  Write-Host "Install into detected agents:  agent-setup.ps1 -Action Install"
  Write-Host "Target a specific agent:       agent-setup.ps1 -Action Install -Agent qoder"
}

function Invoke-Install($Registry, [string]$AppDir) {
  $names = Select-Agents $Registry
  if ($names.Count -eq 0) {
    Write-Warn2 'No supported agent detected. Pass -Agent explicitly, e.g. -Agent qoder'
    return
  }
  foreach ($name in $names) {
    $def = $Registry[$name]
    Write-Step "Configuring $($def.Label)"
    if ($def.McpConfig) { Set-McpEntry $def $AppDir } else { Write-Skip "$($def.Label): MCP configured elsewhere (see docs/AGENT_SETUP.md)" }
    if ($def.SkillSource) { Install-Skill $def }
  }
  Write-Host ''
  Write-Step 'Smoke test (stdio MCP handshake against server.mjs)'
  if (Test-McpSmoke $AppDir) {
    Write-Ok 'end-to-end check succeeded; list_windows returned a real response'
  } elseif ($SmokePaused) {
    Write-Warn2 'Runtime reachable, but desktop control is paused by the user.'
    Write-Warn2 'Resume through the FastCUA named-pipe control plane, then retry.'
  } else {
    Write-Fail 'MCP handshake failed. Run: install.ps1 -Action Doctor'
  }
  Write-Host ''
  Write-Host 'Restart each agent client so MCP and skills reload, then verify with runtime_info.'
}

function Invoke-Verify($Registry, [string]$AppDir) {
  $expected = Join-Path $AppDir 'server.mjs'
  $problems = 0
  foreach ($name in $Registry.Keys) {
    $def = $Registry[$name]
    if (-not (& $def.Detect)) { continue }
    if ($def.McpConfig) {
      $configured = Get-ConfiguredServerPath $def.McpConfig $def.McpRootKey
      if (-not $configured) {
        Write-Warn2 "$($def.Label): sky-computer-use MCP not configured"
        $problems++
      } elseif ($configured -ine $expected) {
        Write-Fail "$($def.Label): MCP points at stale path: $configured (expected $expected)"
        $problems++
      } else {
        Write-Ok "$($def.Label): MCP configured for current runtime"
      }
    }
    if ($def.SkillsDir) {
      $skill = Join-Path $def.SkillsDir 'computer-use\SKILL.md'
      if (Test-Path -LiteralPath $skill) {
        Write-Ok "$($def.Label): skill present"
      } else {
        Write-Warn2 "$($def.Label): skill missing at $($def.SkillsDir)"
        $problems++
      }
    }
  }
  Write-Step 'Smoke test (stdio MCP handshake against server.mjs)'
  if (Test-McpSmoke $AppDir) {
    Write-Ok 'end-to-end check succeeded; list_windows returned a real response'
  } elseif ($SmokePaused) {
    Write-Warn2 'Runtime reachable, but desktop control is paused by the user.'
    Write-Warn2 'Resume through the FastCUA named-pipe control plane, then retry.'
    $problems++
  } else {
    Write-Fail 'MCP handshake failed. Run: install.ps1 -Action Doctor'
    $problems++
  }
  if ($problems -eq 0) { Write-Ok 'Agent setup verified.' } else { Write-Fail "$problems problem(s) found." }
}

# ------------------------------------------------------------------- main ---

$runtimeDir = Get-AppDir
$registry = Get-AgentRegistry $runtimeDir

switch ($Action) {
  'List'    { Invoke-List $registry $runtimeDir }
  'Install' { Invoke-Install $registry $runtimeDir }
  'Verify'  { Invoke-Verify $registry $runtimeDir }
}
