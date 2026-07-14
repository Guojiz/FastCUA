# FastCUA

**Turn Windows GUIs into a fast, executable interface for AI agents.**

[Website](https://guojiz.github.io/FastCUA/) · [中文](README_zh.md) · [Self-hosting](docs/SELF_HOSTING.md)

> **Bring your own agent, and install FastCUA into that agent itself by default.** The Windows installer prepares Node.js and the verified FastCUA runtime. The agent that receives the setup prompt must then install both the complete `computer-use` Skill and the `sky-computer-use` MCP server into its own active configuration. Missing either part means installation failed.

FastCUA is an open-source, local-first Computer Use runtime for Windows. It combines accessibility-first navigation, optional screenshots, native keyboard and mouse input, multi-action execution, access policy, and visible human control in one resident service.

Instead of forcing an agent to repeat the slow loop of **screenshot → reason → click → screenshot**, FastCUA lets it inspect Windows UI elements as text, plan several related actions, and execute them through one warm native control plane. Vision remains available for canvases, custom controls, and other places where accessibility data is not enough.

## Why FastCUA

| | Vision-first Computer Use | Browser bridge / extension | FastCUA |
|---|---|---|---|
| Control scope | What appears in screenshots | Web pages inside the browser | Windows desktop applications and browser windows |
| Primary navigation | Pixel coordinates | DOM / CDP / browser APIs | Windows UI Automation text, with screenshots when needed |
| Model requirement | Usually a vision-capable model | Usually text is enough | Text-only or vision-capable models |
| Execution pattern | Often one action per observe-reason loop | Browser commands | Multiple native actions in one model turn |
| Desktop drag and drawing | Depends on the implementation | Usually outside its scope | Native click, keyboard, scroll, drag, and repeated strokes |
| Human takeover | Varies | Usually limited to the browser | Global pause, interjection, approval, resume, and exit |

FastCUA does not replace browser automation. Inside a webpage, CDP or a browser bridge can still be the best tool. FastCUA covers the layer around it: application windows, system file dialogs, Paint, File Explorer, Office-style applications, browser chrome, and workflows that cross application boundaries.

## The fast path

### 1. Accessibility first, vision optional

An agent can request only the Windows accessibility tree when the next step is identifiable by text:

```js
const state = await sky.get_window_state({
  window,
  include_screenshot: false,
  include_text: true,
});
```

Screenshots can be requested independently for canvases, visual editors, custom-rendered controls, and verification. This avoids sending nearly identical images through the model when pixels add no useful information.

### 2. One warm native host

All connected clients share one resident Windows native host and one coherent control plane. Window identity, pointer state, approvals, pauses, and interruptions are not rebuilt for every individual action.

### 3. Many actions per model turn

FastCUA exposes a persistent JavaScript action environment through MCP, so an agent can execute related operations sequentially without returning to the model after every mouse movement:

```js
await sky.click({ window, x: 180, y: 240 });
await sky.press_key({ window, key: "Control_L+a" });
await sky.type_text({ window, text: "FastCUA" });
await sky.drag({ window, from_x: 120, from_y: 320, to_x: 420, to_y: 180 });
```

The agent should observe again when the layout, focus, modal state, or target elements may have changed. Stable keyboard, text, coordinate, and drawing actions can be batched against the same captured window.

## Start in 30 seconds

On Windows 11, open PowerShell as a regular user:

```powershell
irm https://raw.githubusercontent.com/Guojiz/FastCUA/main/install.ps1 | iex
```

The installer prepares Node.js, the FastCUA runtime, and the SHA-256-verified native host. It also creates `FastCUA Agent Setup.txt` on the desktop.

Give that prompt to **the agent that will actually use FastCUA**. By default, the target is the receiving agent itself. It must:

1. Copy, link, or register the entire `skills\computer-use` folder in its own active Skill system. Merely reading `SKILL.md` is not enough.
2. Add the `sky-computer-use` stdio MCP server to its own MCP configuration.
3. Reload both parts, verify that `computer-use` is discoverable, and successfully call `list_windows` through MCP.

If either the Skill or MCP is missing, installation must be reported as failed. The agent must also report the Skill destination and the MCP configuration file it changed.

Then give the agent a real task:

> Open Paint and draw a house with the sun and grass.

The local control center is available at `http://127.0.0.1:8420`. Control endpoints listen on loopback only.

FastCUA is agent-neutral, but the complete deployment flow requires a client that supports both local Skills and stdio MCP.

## You stay in control

| State | Visual signal | Behavior |
|---|---|---|
| Active | Compact translucent island + screen border | AI is using the computer; the border remains click-through |
| Approval | Amber | `1` once · `2` always approve · `3` full access · `4` deny |
| Full access | Purple / pink | No per-app prompts until you disable the mode |
| Paused | Red | New actions are blocked and can be resumed in one step |

Safe mode is the default. Trusted applications run directly; unknown applications require a decision. Full access is a separate, visible, reversible mode.

### Four global controls

| Key | Action |
|---|---|
| `F7` | Pause and open the control center |
| `F8` | Pause / resume |
| `F9` | Pause first, then expand the island to interject |
| `F10` | Exit FastCUA completely (agents must not self-restart) |

Clicking the island also pauses and opens the control center for mouse takeover. Global keys remain available while the agent owns the pointer.

## More than a mouse script

- **Window-aware coordinates:** actions remain attached to the target window and account for Windows DPI scaling.
- **Accessibility and pixels are independent:** request text, screenshot, or both according to the next decision.
- **Native input:** click, keyboard chords, Unicode text, scrolling, drag, and supported accessibility actions.
- **Two-way interruption:** a person can pause or redirect the task; approval waiting also pauses the machine.
- **Exact trust rules:** canonical paths and executable names are matched exactly, never by unsafe substring.
- **Visible without being noisy:** the island stays compact until approval, interjection, or an exceptional state requires attention.
- **Local first:** MCP traffic uses a named pipe, the console binds to `127.0.0.1`, and policy remains on the PC.

## How it fits together

```mermaid
flowchart LR
  A["Agent with the computer-use Skill installed"] -->|"MCP"| B["FastCUA control plane"]
  B --> C["Resident Windows native host"]
  C --> D["UI Automation tree"]
  C --> E["Optional window screenshot"]
  C --> F["Native keyboard and mouse input"]
  B --> G["Policy, pause, approval, and interjection"]
  B --> H["Dynamic Island, border, and local console"]
```

## Current boundaries

FastCUA currently targets Windows 11 x64. Secure Desktop, UAC elevation surfaces, authentication dialogs, password managers, and Windows security interfaces are intentionally outside the normal automation path. Applications that expose little or no accessibility information may require screenshots and coordinate input. Element indexes belong to the latest accessibility snapshot and should be refreshed after meaningful layout changes.

## Self-host

Self-hosting is not complete after building and starting the daemon. The complete flow is:

1. Clone and build the native host.
2. Install the complete `computer-use` Skill into the current agent itself by default.
3. Install `sky-computer-use` MCP into the same agent.
4. Reload and verify both the Skill and `list_windows`.

```powershell
git clone https://github.com/Guojiz/FastCUA.git
cd FastCUA
.\native-host\build.ps1
```

During normal use, the MCP server starts the daemon automatically. You do not need to run `node daemon.mjs` manually. See the [self-hosting guide](docs/SELF_HOSTING.md) for exact paths, configuration templates, and acceptance checks.

## FAQ

**How do I take control immediately?** Press `F7` to pause or `F10` to exit.

**How does an agent finish a FastCUA task?** It calls `close` once after verification. `close` ends the current turn and closes that MCP client connection; it does not stop the shared daemon or other clients. Pause only blocks new actions and does not end any process.

**Can an unknown application launch silently?** Not in safe mode. Choose allow once, trust, or deny.

**Is Claude Code required?** No. Any agent that supports both local Skills and stdio MCP can install the complete FastCUA stack.

**Can I configure only MCP?** No. Standard FastCUA installation requires the same agent to install both the `computer-use` Skill and `sky-computer-use` MCP, then pass both verification checks.

**Does FastCUA eliminate screenshots?** No. It makes them optional. Accessibility text is preferred when it can express the interface accurately; screenshots remain available where visual understanding is necessary.

**Is FastCUA only for browsers?** No. Browser windows are one target among Windows desktop applications. Browser-native automation can still be combined with FastCUA when DOM or network-level access is more suitable.

**How do I uninstall it?**

```powershell
& "$env:LOCALAPPDATA\FastCUA\app\uninstall.ps1"
```

The uninstaller removes the FastCUA runtime but intentionally leaves AI client configuration unchanged. Remove the `computer-use` Skill and `sky-computer-use` MCP entry from every agent where FastCUA was installed.

## License

Apache-2.0. See [LICENSE](LICENSE).
