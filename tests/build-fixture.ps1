# SPDX-License-Identifier: MIT

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'Fixture.cs'
$output = Join-Path $PSScriptRoot 'FastCuaFixture.exe'
$csc = Get-ChildItem "$env:WINDIR\Microsoft.NET\Framework64" -Recurse -Filter csc.exe |
  Sort-Object FullName -Descending |
  Select-Object -First 1

if (-not $csc) {
  throw 'C# compiler not found. Install the .NET Framework developer tools.'
}

& $csc.FullName /nologo /target:winexe /out:$output /reference:System.Windows.Forms.dll /reference:System.Drawing.dll $source
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-Item $output | Select-Object FullName, Length, LastWriteTime
