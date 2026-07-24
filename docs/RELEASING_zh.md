# FastCUA 发行与更新

FastCUA 使用一个带版本的 Windows 运行时包，不再从多个源码目录和二进制目录临时拼装发行版。

## 目录边界

- 开发版：直接运行 Git 仓库中的 `server.mjs`。
- 正式安装版：`%LOCALAPPDATA%\FastCUA\app`。
- 安装版可变数据：`%LOCALAPPDATA%\FastCUA\data`。
- 上一版本回滚副本：`%LOCALAPPDATA%\FastCUA\app.previous`。

每个运行时根目录使用独立的命名管道。开发仓库还使用路径隔离的数据目录和 HTTP 端口，因此不会再悄悄连接到安装版的旧 daemon。`runtime_info` 会报告实际根目录、版本、Git 提交、管道、数据目录、HTTP 端口和 native-host 路径。

## 用户命令

```powershell
npx fastcua install
npx fastcua check
npx fastcua update
npx fastcua doctor
```

正式安装版每天最多自动检查一次 GitHub Releases。检查不阻塞当前操作，也不会静默安装。开发仓库不检查发行版更新，更新器也不会覆盖开发仓库。

更新流程为：下载 `fastcua-runtime-win-x64.zip` 和 `SHA256SUMS.txt`，校验压缩包，再按照 `runtime-manifest.json` 校验每个运行时文件，然后暂存、停止安装版 daemon 并替换目录。旧版本保留在 `app.previous`；替换失败会自动恢复。

## 发行包包含什么

- MCP server、常驻 daemon、控制中心、状态浮层和运行时库；
- 编译后的 `cua-native-host.exe`；
- 编译后的技能录制器及确定性编译、干跑工具；
- 完整 Skills、许可证、说明、安装器、卸载器和管理脚本；
- 包含版本、Git 提交、构建时间、平台及全部文件 SHA-256 的 `runtime-manifest.json`。

发行包不包含 Git 历史、测试、录制数据、编译缓存、本机配置、日志、API 密钥、AI 会话或认证信息。

## 发布新版本

1. 保证 `package.json`、`runtime-manifest.json`、`native-host/Cargo.toml` 和 `tools/skill-recorder/Cargo.toml` 使用同一语义化版本。
2. 跑完发行检查与回归测试。
3. 提交干净源码。
4. 给该提交打标签，例如 `v0.3.0`，然后推送标签。

标签工作流会编译两个 Rust 二进制，生成运行时 ZIP 和清单，检查所有组件版本与标签一致，发布 GitHub Release；配置了 `NPM_TOKEN` 时还会发布 npm CLI。

本地验证发行包：

```powershell
.\scripts\build-release.ps1 -OutputDirectory .\dist
```

不要手工把开发二进制复制进安装版。需要测试安装器时，使用本地暂存安装：

```powershell
.\scripts\manage.ps1 -Action Install -SourcePath . -NativeHostPath .\native-host\target\release\cua-native-host.exe
```
