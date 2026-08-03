# FastCUA

**A local, accessibility-first Windows control plane for AI agents.**

[Website](https://guojiz.github.io/FastCUA/) · [中文](README_zh.md) · [Technical paper](docs/TECHNICAL_PAPER.md)

> [!WARNING]
> FastCUA is an experimental project under active development. Use it for testing, not important or unattended work.

FastCUA gives an agent a fast, inspectable interface to Windows applications. It prefers Windows UI Automation text, switches to screenshots and a numbered square grid when semantics are weak, and executes related native actions through one resident local runtime. The human remains in control through visible state, per-app approval, global pause, interjection, and exit controls.

FastCUA is agent-neutral, but a complete installation always has two parts in the **same agent host**:

1. the full `skills/computer-use/` operating policy;
2. the `sky-computer-use` stdio MCP server.

MCP alone is capability without the required procedure. The Skill alone has no executor.

## Why FastCUA

| | Vision-first computer use | Browser automation | FastCUA |
|---|---|---|---|
| Main observation | Screenshots | DOM/CDP | UIA text, then vision when needed |
| Scope | Any visible surface | Web content | Windows apps, browser chrome, cross-app flows |
| Execution | Often one action per loop | Browser commands | Several native actions per model turn |
| Runtime state | Often rebuilt per call | Browser session | One warm daemon and native host |
| Human takeover | Integration-dependent | Browser-limited | Global pause, interject, approve, exit |

FastCUA complements in-page browser automation; it does not replace it.

## Architecture

```mermaid
flowchart TB
  A["Agent host + computer-use Skill"] -->|"stdio MCP"| B["server.mjs"]
  B -->|"path-scoped named pipe"| C["Resident daemon"]
  C --> D["Rust native host"]
  D --> E["UI Automation / HWND"]
  D --> F["Capture / square grid"]
  D --> G["Keyboard / mouse input"]
  C --> H["Approval / pause / interjection"]
```

Core behavior:

- **Accessibility first:** use semantic names, roles, values, and bounds when UIA is healthy.
- **Vision on demand:** weak or hung providers produce `prefer_vision:true`; `grid_view` returns one annotated image and can refine one cell into 3×3.
- **One control plane:** all clients share lifecycle, policy, runtime identity, and one physical cursor.
- **Many actions per turn:** a persistent `js` tool exposes bounded `sky.*` operations and cancels late work when a cell ends.
- **Fail explicitly:** stale elements, out-of-bounds coordinates, focus loss, pointer movement, timeout, approval wait, or human interruption stop the action.
- **Local by design:** the console binds to loopback and policy remains on the machine.

For the complete design, formal coordinate model, input state machines, evidence, limitations, recorder architecture, self-hosting, and release process, read the [technical paper](docs/TECHNICAL_PAPER.md).

## Install

### Fastest path

Windows 11 with Node.js 18 or newer:

```powershell
npx fastcua
```

Or let the bootstrapper install Node.js through WinGet when needed:

```powershell
irm https://raw.githubusercontent.com/Guojiz/FastCUA/main/install.ps1 | iex
```

The verified installer writes `FastCUA Agent Setup.txt` to the desktop. Give it to the agent that will actually use FastCUA. That agent must:

1. install the complete `skills\computer-use` folder into its own Skill system;
2. configure Node.js + the installed `server.mjs` as `sky-computer-use` MCP;
3. reload and verify that the Skill is discoverable;
4. call `list_windows` successfully.

If either the Skill or MCP is missing, installation is incomplete.

### Verify and update

```powershell
npx fastcua doctor
npx fastcua check
npx fastcua update
```

Inside MCP, call `runtime_info` to confirm the exact server, daemon, native host, version, commit, pipe, and data directory in use.

## Human control

| Key | Action |
|---|---|
| `F7` | Pause and open the control center |
| `F8` | Pause or resume |
| `F9` | Pause and interject text |
| `F10` | Exit FastCUA |

The local control center is available at `http://127.0.0.1:8420`. Safe mode asks before acting in an unknown application. Trust uses exact application identity, not fuzzy name matching.

## Example: one multi-step turn

```js
const windows = await sky.list_windows();
const window = windows.find((w) => /Notepad/i.test(w.title));
if (!window) throw new Error("Notepad is not open");

const state = await sky.get_window_state({
  window,
  include_screenshot: false,
  include_text: true,
});

if (state.uia?.prefer_vision) {
  let view = await sky.grid_view({ window });
  view = await sky.grid_refine({ window, grid: view.grid, cell: "4" });
  await sky.click_cell({ window, grid: view.grid, cell: "5" });
} else {
  const editor = /^\s*(\d+)\s+(?:Edit|Document)\b/m.exec(
    state.accessibility.tree || "",
  );
  if (!editor) throw new Error("Editor not found");
  await sky.click({ window, element_index: Number(editor[1]) });
}

await sky.type_text({ window, text: "FastCUA" });
await sky.close();
```

Element indexes belong to the latest UIA snapshot. Refresh after layout changes. Selecting a grid number does not click; only an explicit click helper commits input.

## Record a Skill (preview)

The optional recorder turns a demonstration into an auditable evidence package before any Skill is written:

```text
record → compile evidence → dedicated writer → provenance lint
       → dry-run with new values → human-reviewed promotion
```

Password fields and secure-desktop moments are structurally redacted. Compiled drafts are non-executable and unverified. Out-of-scope applications, unresolved anchors, control-plane interruption, and promotion without explicit review all fail closed. The agent procedure is in `skills/skill-recorder/`; the design and evidence model are in the [technical paper](docs/TECHNICAL_PAPER.md#9-evidence-first-skill-recording).

## Develop from source

```powershell
git clone https://github.com/Guojiz/FastCUA.git
cd FastCUA
.\native-host\build.ps1
```

Then copy the complete `skills\computer-use` directory into the active agent's Skill directory and configure the absolute path to `server.mjs` as a stdio MCP server. Use `runtime_info` to verify the checkout. Reproduction commands and the test matrix are in the [technical paper](docs/TECHNICAL_PAPER.md#12-reproduction-and-operation).

## Boundaries

FastCUA currently targets Windows 11 x64. UAC, Secure Desktop, authentication dialogs, password managers, Windows Security, higher-integrity processes, protected surfaces, and applications with unusual capture/accessibility behavior are outside the normal path. Synthetic input is not hardware input, and the current key-chord implementation still uses the superseded `keybd_event` API. See the paper's [limitations and roadmap](docs/TECHNICAL_PAPER.md#11-limitations-and-engineering-roadmap) before relying on a specific application.

## Uninstall

```powershell
& "$env:LOCALAPPDATA\FastCUA\app\uninstall.ps1"
```

## License

MIT. See [LICENSE](LICENSE).
