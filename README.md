# FastCUA

> [!IMPORTANT]
> **FastCUA is no longer under development.**
>
> Development ended on **August 19, 2026**. New users should use **[Cua](https://github.com/trycua/cua)** instead.

## Project status

FastCUA started as an accessibility-first Windows control plane for AI agents, combining Windows UI Automation, visual fallback, a resident runtime, MCP, and explicit human takeover controls.

Cua has since converged on the same core problem while developing a substantially broader implementation: Windows, macOS, and Linux support; native accessibility backends; background-safe input paths; Electron, Tauri, WPF, WinUI, WebView2 and other desktop stacks; MCP integration; SDKs; and an actively maintained cross-platform test matrix.

Maintaining a second implementation of the same low-level computer-use infrastructure is no longer a good use of development effort. Rather than duplicate work, FastCUA development is stopping and users are encouraged to migrate to Cua.

**Recommended replacement:** https://github.com/trycua/cua

## What happens to FastCUA?

This repository remains available as a historical and technical reference. Existing source code, documentation, experiments, the human-control design, and the Skill Recorder work will remain here.

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

## License

FastCUA remains available under the MIT License. See [LICENSE](LICENSE).

---

Thank you to everyone who tried, tested, discussed, or contributed to FastCUA. The computer-use ecosystem moved quickly, and in this case the right next step is not another parallel driver, but to point users toward the stronger actively maintained implementation.

[中文说明](README_zh.md)
