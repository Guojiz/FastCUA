# FastCUA

**A local, accessibility-first Windows control plane for AI agents.**

[Website](https://guojiz.github.io/FastCUA/) · [中文](README_zh.md) · [Technical paper](docs/TECHNICAL_PAPER.md) · [Next design](docs/NEXT_DESIGN.md)

> [!WARNING]
> FastCUA is an experimental project under active development. Use it for testing, not important or unattended work.

FastCUA gives an agent a fast, inspectable interface to Windows applications. It prefers Windows UI Automation text, switches to screenshots and a numbered square grid when semantics are weak, and executes related native actions through one resident local runtime. The human remains in control through visible state, per-app approval, global pause, interjection, and exit controls.

FastCUA is agent-neutral, but a complete installation always has two parts in the **same agent host**:

1. the full `skills/computer-use/` operating policy;
2. the `sky-computer-use` stdio MCP server.

MCP alone is capability without the required procedure. The Skill alone has no executor.

## Model requirement

Use **one full-capability primary model** with text/image understanding, reliable reasoning, Skills, MCP, and enough context for the whole task. Native audio understanding is useful for recorded narration; otherwise use typed notes. Do not configure writer, transcription, fallback, or text-only models.

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

All clients share one daemon, policy state, and physical pointer. A persistent `js` cell can execute related `sky.*` actions in one model turn; stale targets, changed focus/cursor, out-of-bounds points, timeouts, and human control signals stop execution.

## Targeting logic

Start with `get_window_state({include_text:true})` and read `state.uia`:

| Observation | Required action |
|---|---|
| `quality:"good"` and a named, bounded target | Click its current `element_index` |
| `prefer_vision:true`, `weak`, `broken`, `[no-hit]`, or one stale-index failure | Stop semantic clicking and call `grid_view` |

Visual control is **observe → select → refine → commit**:

1. `grid_view({window})` returns one window image with numbered square cells.
2. Inspect the image and select the number containing the target. Selection is only a decision; it sends no input.
3. If the target is not safely isolated at that cell's center, call `grid_refine({window,grid,cell})`. It crops that square and draws a new 3×3 grid; refine again if needed.
4. Commit exactly once: `click_cell({window,grid,cell})` for the cell center, `click_in_cell({window,grid,cell,x,y,view})` for a cell-local offset, or `click_view({window,view,x,y})` for an exact point in the current image/crop.
5. Re-observe after any action that may change layout or focus.

Coordinates always use the current window image or crop, origin at its top-left. The helpers reverse capture scaling and reject points outside the target window. Full mechanics and proofs are in the [technical paper](docs/TECHNICAL_PAPER.md#4-observation-semantics-first-pixels-when-needed).

## Install

Use the PowerShell installer. It installs Node.js through WinGet when needed, downloads the GitHub Release runtime, and verifies its checksum:

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
& "$env:LOCALAPPDATA\FastCUA\app\install.ps1" -Action Doctor
& "$env:LOCALAPPDATA\FastCUA\app\install.ps1" -Action Check
& "$env:LOCALAPPDATA\FastCUA\app\install.ps1" -Action Update
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

## Visual click example

Given a `window` returned by `list_windows`:

```js
let view = await sky.grid_view({ window });       // inspect; choose cell 4
view = await sky.grid_refine({
  window,
  grid: view.grid,
  cell: "4",
});                                               // inspect; choose cell 5
await sky.click_cell({ window, grid: view.grid, cell: "5" });
await sky.close();
```

## Record a Skill (preview)

The optional recorder turns a demonstration into an auditable evidence package before any Skill is written:

```text
record → compile evidence → current primary agent writes → provenance lint
       → dry-run with new values → human-reviewed promotion
```

Password fields and secure-desktop moments are redacted. The current primary agent writes the Skill from evidence; lint, dry-run, application scope, and explicit promotion approval remain hard gates. See `skills/skill-recorder/` and the [technical paper](docs/TECHNICAL_PAPER.md#9-evidence-first-skill-recording).

## Develop from source

```powershell
git clone https://github.com/Guojiz/FastCUA.git
cd FastCUA
.\native-host\build.ps1
```

Then copy the complete `skills\computer-use` directory into the active agent's Skill directory and configure the absolute path to `server.mjs` as a stdio MCP server. Use `runtime_info` to verify the checkout. Reproduction commands and the test matrix are in the [technical paper](docs/TECHNICAL_PAPER.md#12-reproduction-and-operation).

## Boundaries

FastCUA currently targets Windows 11 x64. UAC, Secure Desktop, authentication dialogs, password managers, Windows Security, higher-integrity processes, protected surfaces, and applications with unusual capture/accessibility behavior are outside the normal path. Synthetic input is not hardware input, and the current key-chord implementation still uses the superseded `keybd_event` API. Remaining input, provider, capture, IPC, and evaluation work is tracked in [Next design](docs/NEXT_DESIGN.md).

## Uninstall

```powershell
& "$env:LOCALAPPDATA\FastCUA\app\uninstall.ps1"
```

## License

MIT. See [LICENSE](LICENSE).
