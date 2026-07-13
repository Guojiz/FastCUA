#requires -Version 5.1
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding(SupportsShouldProcess)]
param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'FastCUA'))

$ErrorActionPreference = 'Stop'
$appDir = Join-Path $InstallRoot 'app'
if (Test-Path $appDir) {
  $resolvedAppDir = [System.IO.Path]::GetFullPath($appDir)
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessId -ne $PID -and
      $_.Name -in @('node.exe', 'powershell.exe', 'pwsh.exe', 'cua-native-host.exe') -and
      $_.CommandLine -and
      $_.CommandLine.IndexOf($resolvedAppDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    } |
    ForEach-Object {
      if ($PSCmdlet.ShouldProcess("PID $($_.ProcessId)", 'Stop FastCUA process')) {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ((Get-ItemProperty -Path $runKey -Name FastCUA -ErrorAction SilentlyContinue) -and $PSCmdlet.ShouldProcess($runKey, 'Remove FastCUA sign-in entry')) {
  Remove-ItemProperty -Path $runKey -Name FastCUA -Force
}
if ((Test-Path $InstallRoot) -and $PSCmdlet.ShouldProcess($InstallRoot, 'Remove FastCUA application files')) {
  Remove-Item -LiteralPath $InstallRoot -Recurse -Force
}
$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
$consoleShortcut = if ($desktop) { Join-Path $desktop 'FastCUA Console.url' } else { $null }
if ($consoleShortcut -and (Test-Path $consoleShortcut) -and $PSCmdlet.ShouldProcess($consoleShortcut, 'Remove FastCUA Console shortcut')) {
  Remove-Item -LiteralPath $consoleShortcut -Force
}
$agentPrompt = if ($desktop) { Join-Path $desktop 'FastCUA Agent Setup.txt' } else { $null }
if ($agentPrompt -and (Test-Path $agentPrompt) -and $PSCmdlet.ShouldProcess($agentPrompt, 'Remove FastCUA agent setup prompt')) {
  Remove-Item -LiteralPath $agentPrompt -Force
}
Write-Host 'FastCUA was removed. AI client configuration was left unchanged.' -ForegroundColor Green
