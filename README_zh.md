# FastCUA

> [!IMPORTANT]
> **FastCUA 已停止开发。**
>
> 项目于 **2026 年 8 月 19 日**结束后续开发。新用户请直接使用 **[Cua](https://github.com/trycua/cua)**。

<p align="center">
  <a href="https://guojiz.github.io/FastCUA/"><img alt="项目站点" src="https://img.shields.io/badge/站点-guojiz.github.io%2FFastCUA-111111?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111111?style=flat-square"></a>
  <a href="https://github.com/trycua/cua"><img alt="改用 Cua" src="https://img.shields.io/badge/替代-Cua-111111?style=flat-square"></a>
</p>

**项目站点（历史文档）：** https://guojiz.github.io/FastCUA/

该站点保留 FastCUA 原先的设计说明：accessibility-first 的 Windows 控制、按需视觉、常驻运行时，以及可见的人类接管。它不是给新部署用的上线页。

## 项目状态

FastCUA 最初定位为面向 AI Agent 的 accessibility-first Windows 控制平面，将 Windows UI Automation、视觉回退、常驻运行时、MCP 与明确的人类接管机制组合在一起。

此后，Cua 已经发展到与 FastCUA 高度重叠的核心方向，并形成了更完整的实现：支持 Windows、macOS 与 Linux，具备各平台原生无障碍接口、后台安全输入路径，以及 Electron、Tauri、WPF、WinUI、WebView2 等桌面技术栈适配，同时提供 MCP、SDK 和持续维护的跨平台测试矩阵。

继续维护第二套高度重叠的底层 Computer Use 基础设施已经没有足够意义。与其重复造轮子，FastCUA 将停止开发，并建议所有新老用户逐步迁移到 Cua。

**推荐替代项目：** https://github.com/trycua/cua

## FastCUA 接下来会怎样？

本仓库会继续保留，作为历史与技术参考。现有源码、文档、实验、人类控制设计以及 Skill Recorder 相关工作都会保存在这里。[项目站点](https://guojiz.github.io/FastCUA/)与 [recorder playbook](skills/skill-recorder) 也一并作为记录保留。

但需要明确：

- 不再计划新增 FastCUA 功能；
- 不再计划继续做兼容性适配；
- 已知或未来出现的问题可能不会修复；
- 不建议再把 FastCUA 用于新的部署；
- 后续 Computer Use 开发建议迁移到 Cua。

FastCUA 的部分设计仍然可能具有参考价值，尤其是人类随时接管、插话、按应用审批，以及基于证据生成 Skill 的思路。

## 已安装用户

现有安装仍可能继续运行，但已经不再维护。如需卸载 FastCUA：

```powershell
& "$env:LOCALAPPDATA\FastCUA\app\uninstall.ps1"
```

如需持续维护的替代方案，请查看 Cua 仓库：

https://github.com/trycua/cua

## 链接

| | |
| --- | --- |
| **项目站点** | https://guojiz.github.io/FastCUA/ |
| **替代项目** | https://github.com/trycua/cua |
| **作者站点** | https://guojiz.github.io/ |
| **X** | https://x.com/guojizh |
| **哔哩哔哩** | https://space.bilibili.com/3493114115263006 |
| **赞助** | https://github.com/Guojiz/Sponsors |

### 其它已上线官网的 Guojiz 项目

- [GitLearnOS](https://guojiz.github.io/gitlearnos/) — 学习者拥有的 Git 学习记忆
- [Word Snap](https://guojiz.github.io/word-snap/) — 双语单词匹配 PWA

## 许可证

FastCUA 仍以 MIT License 提供，见 [LICENSE](LICENSE)。

---

感谢所有试用、测试、讨论或参与过 FastCUA 的人。Computer Use 这个领域发展得非常快，而这一次，更合理的下一步不是继续维护另一套平行 Driver，而是把用户引向当前更完整、仍在积极维护的实现。

[English](README.md)
