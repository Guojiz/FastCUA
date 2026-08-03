# FastCUA releases and updates

FastCUA uses one versioned Windows runtime package rather than assembling a release from several source and binary locations.

## Runtime layout

- Development checkout: run `server.mjs` directly from the Git repository.
- Installed release: `%LOCALAPPDATA%\FastCUA\app`.
- Mutable installed data: `%LOCALAPPDATA%\FastCUA\data`.
- Rollback copy: `%LOCALAPPDATA%\FastCUA\app.previous`.

Each runtime root gets its own named pipe. A development checkout also gets a path-scoped data directory and HTTP port, so it cannot silently attach to an installed daemon. `runtime_info` reports the exact root, version, commit, pipe, data directory, HTTP port, and native-host path.

## User commands

```powershell
npx fastcua install
npx fastcua check
npx fastcua update
npx fastcua doctor
```

Installed releases check GitHub Releases at most once per day. The check is non-blocking and never installs silently. Development checkouts do not check for release updates and are never overwritten by the updater.

An update downloads `fastcua-runtime-win-x64.zip` and `SHA256SUMS.txt`, verifies the archive, verifies every file against `runtime-manifest.json`, stages the new runtime, stops the installed daemon, and swaps directories. The previous runtime remains in `app.previous`. A failed swap restores it automatically.

## What ships

The runtime ZIP contains:

- MCP server, resident daemon, control center, overlay, and runtime libraries;
- compiled `cua-native-host.exe`;
- compiled Skill recorder and its deterministic compiler/dry-run tools;
- complete Skills, license, readme, installer, uninstaller, and management script;
- `runtime-manifest.json` with version, Git commit, build time, platform, and SHA-256 for every runtime file.

It does not contain Git history, tests, recordings, build caches, local configuration, logs, API keys, AI sessions, or credentials.

## Creating a release

1. Make `package.json`, `runtime-manifest.json`, `native-host/Cargo.toml`, and `tools/skill-recorder/Cargo.toml` use the same semantic version.
2. Run the release and regression checks.
3. Commit the clean source.
4. Tag that exact commit, for example `v0.3.0`, and push the tag.

The tag workflow builds both Rust binaries, generates the runtime ZIP and manifest, verifies that every component matches the tag, publishes the GitHub Release assets, and publishes the npm CLI when `NPM_TOKEN` is configured.

For a local package validation:

```powershell
.\scripts\build-release.ps1 -OutputDirectory .\dist
```

Do not copy a development binary into an installed release by hand. Use a local staged install when testing the installer:

```powershell
.\scripts\manage.ps1 -Action Install -SourcePath . -NativeHostPath .\native-host\target\release\cua-native-host.exe
```
