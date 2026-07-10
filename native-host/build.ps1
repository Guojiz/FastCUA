# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$localCargo = Join-Path $root '.cargo-home\bin\cargo.exe'

if (Test-Path -LiteralPath $localCargo) {
    $env:CARGO_HOME = Join-Path $root '.cargo-home'
    $env:RUSTUP_HOME = Join-Path $root '.rustup-home'
    & $localCargo build --release @args
} else {
    & cargo build --release @args
}

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Get-Item (Join-Path $root 'target\release\cua-native-host.exe') |
    Select-Object FullName, Length, LastWriteTime
