# FastCUA

> [!IMPORTANT]
> **FastCUA is no longer under development.**
>
> Development ended on **August 19, 2026**. New users should use **[Cua](https://github.com/trycua/cua)** instead.

<p align="center">
  <a href="https://guojiz.github.io/FastCUA/"><img alt="Project site" src="https://img.shields.io/badge/site-guojiz.github.io%2FFastCUA-111111?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111111?style=flat-square"></a>
  <a href="https://github.com/trycua/cua"><img alt="Use Cua instead" src="https://img.shields.io/badge/replacement-Cua-111111?style=flat-square"></a>
</p>

**Project site (historical documentation):** https://guojiz.github.io/FastCUA/

The site remains as a record of the original FastCUA design: accessibility-first Windows control, vision on demand, a warm runtime, and visible human takeover. It is not a launch page for new deployments.

## Project status

FastCUA started as an accessibility-first Windows control plane for AI agents, combining Windows UI Automation, visual fallback, a resident runtime, MCP, and explicit human takeover controls.

Cua has since converged on the same core problem while developing a substantially broader implementation: Windows, macOS, and Linux support; native accessibility backends; background-safe input paths; Electron, Tauri, WPF, WinUI, WebView2 and other desktop stacks; MCP integration; SDKs; and an actively maintained cross-platform test matrix.

Maintaining a second implementation of the same low-level computer-use infrastructure is no longer a good use of development effort. Rather than duplicate work, FastCUA development is stopping and users are encouraged to migrate to Cua.

**Recommended replacement:** https://github.com/trycua/cua

## What happens to FastCUA?

This repository remains available as a historical and technical reference. Existing source code, documentation, experiments, the human-control design, and the Skill Recorder work will remain here. The [project site](https://guojiz.github.io/FastCUA/) and the [recorder playbook](skills/skill-recorder) stay with that record.

However:

- no new FastCUA features are planned;
- no compatibility work is planned;
- bugs may remain unfixed;
- the project should not be selected for new deployments;
- users should migrate to Cua for ongoing computer-use development.

The original FastCUA design may still be useful as prior art, especially its emphasis on human takeover, interjection, per-application approval, and evidence-first Skill recording.

## Existing installations

Existing installations can continue to run at their own risk, but they are no longer maintained. To remove FastCUA:

```powershell
& "$env:LOCALAPPDATA\FastCUA\app\uninstall.ps1"
```

For a maintained replacement, see the Cua repository:

https://github.com/trycua/cua

## Links

| | |
| --- | --- |
| **Project site** | https://guojiz.github.io/FastCUA/ |
| **Replacement** | https://github.com/trycua/cua |
| **Author site** | https://guojiz.github.io/ |
| **X** | https://x.com/guojizh |
| **Bilibili** | https://space.bilibili.com/3493114115263006 |
| **Sponsor** | https://github.com/Guojiz/Sponsors |

### Other Guojiz projects with official sites

- [GitLearnOS](https://guojiz.github.io/gitlearnos/) — learner-owned Git memory for AI-assisted study
- [Word Snap](https://guojiz.github.io/word-snap/) — bilingual vocabulary matching PWA

## License

FastCUA remains available under the MIT License. See [LICENSE](LICENSE).

---

Thank you to everyone who tried, tested, discussed, or contributed to FastCUA. The computer-use ecosystem moved quickly, and in this case the right next step is not another parallel driver, but to point users toward the stronger actively maintained implementation.

[中文说明](README_zh.md)
