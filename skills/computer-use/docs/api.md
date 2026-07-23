## API Reference

# FastCUA sky window2 API

Use this as the supported `sky` / MCP window2 surface for FastCUA.

Tools are available both as individual MCP tools and on `sky` inside the MCP `js` REPL.

```ts
// Inside MCP js: sky is already bound by FastCUA (no client-side import).

interface Window2ComputerUseClient {
  list_windows(): Promise<Array<Window>>;
  get_window(input: GetWindowInput): Promise<Window>;
  list_apps(): Promise<Array<ListAppsApp>>;
  launch_app(input: LaunchAppInput): Promise<void>;
  get_window_state(input: GetWindowStateInput): Promise<WindowState>;
  click(input: ClickInput): Promise<void>;
  press_key(input: PressKeyInput): Promise<void>;
  type_text(input: TypeTextInput): Promise<void>;
  scroll(input: ScrollInput): Promise<void>;
  set_value(input: SetValueInput): Promise<void>; // protocol/sky only; not a first-class MCP tool in this release
  drag(input: DragInput): Promise<void>;
  perform_secondary_action(input: PerformSecondaryActionInput): Promise<void>;
  activate_window(input: ActivateWindowInput): Promise<void>;
}

// MCP also exposes:
// - js({ code }) — persistent JS REPL with sky + nodeRepl
// - close() — end this turn and close this MCP client connection

type Window = {
  app: AppIdentifier;
  id: number;
  title?: string;
};

type GetWindowInput = {
  app?: AppIdentifier;
  id: number;
};

type ListAppsApp = {
  displayName?: string;
  id: AppIdentifier;
  isRunning?: boolean;
  lastUsedDate?: string;
  useCount?: number;
  windows: Array<Window>;
};

type LaunchAppInput = {
  /** list_apps id, absolute .exe path, `paint`, or shell:AppsFolder\<AUMID> */
  app: AppIdentifier;
};

type GetWindowStateInput = {
  /** Default true in FastCUA MCP when omitted */
  include_screenshot?: boolean;
  /** Default true in FastCUA MCP when omitted. Prefer false when only pixels are needed. */
  include_text?: boolean;
  /**
   * Max long edge of the returned JPEG (default 1568, env FASTCUA_MAX_EDGE,
   * <= 0 disables). When downscaled, screenshots[0].scale and viewport.scale
   * report window px / image px — read scale before any pixel click.
   */
  max_edge?: number;
  window: Window;
};

type WindowState = {
  accessibility: AccessibilityState;
  cacheDiagnostics: {
    accessibilityRevision: number;
    accessibilitySnapshotCount: number;
    captureCachedSessionCount: number;
  };
  screenshots: Array<Screenshot>;
  uia: UiaState;
  window: Window;
  /** Present when host supports it: explicit pixel coordinate space for click/drag/scroll. */
  viewport?: {
    width: number;
    height: number;
    /** window px / screenshot px (1 when no downscale). window px = screenshot px * scale. */
    scale?: number;
    originX?: number;
    originY?: number;
    screenLeft?: number;
    screenTop?: number;
    screenRight?: number;
    screenBottom?: number;
    coordinate_space: "window_screenshot_pixels";
    origin: "top_left";
    click_xy?: string;
    normalized?: string;
    grid_hint?: string;
  };
};

type ClickInput = {
  click_count?: number;
  element_index?: number;
  mouse_button?: MouseButton;
  screenshotId?: string;
  window: Window;
  /** Screenshot/window pixel X, or 0..1 fraction when both x and y are in 0..1. */
  x?: number;
  /** Screenshot/window pixel Y, or 0..1 fraction when both x and y are in 0..1. */
  y?: number;
  /**
   * Pixel space of x,y. Default "screenshot_pixels": the space of the latest
   * get_window_state screenshot (host multiplies by its recorded scale when the
   * capture was downscaled). "window_pixels": x,y are already full window
   * pixels (used internally by click_cell / click_view).
   */
  space?: "screenshot_pixels" | "window_pixels";
  /**
   * When true (click_cell sets this): a bounded (~800ms) UIA point-hit at the
   * target; if it resolves to an element with valid bounds, that element's
   * center is clicked instead. Timeout / no-hit / hung app keep the point.
   */
  snap?: boolean;
};

// The five click modes:
// 1. element_index — click a UIA element from the latest tree (preferred when UIA is healthy).
// 2. absolute x,y — pixels in the latest get_window_state screenshot space
//    (read viewport.scale first; the host maps screenshot px -> window px for you).
// 3. click_cell — sky.click_cell({window, grid, cell}): cell center, with a bounded
//    UIA snap to the element under the point when UIA is healthy.
// 4. click_in_cell — sky.click_in_cell({window, grid, cell, x, y, view?}): x,y are
//    pixels INSIDE the named cell square (cell top-left = 0,0), in image units;
//    pass view (or view.scale) when the image was downscaled. Out-of-cell coords
//    are rejected, never clamped. Snaps like click_cell.
// 5. click_view — sky.click_view({window, view, x, y}): x,y are pixels in the
//    image returned by grid_view/grid_refine; the helper bounds-checks, then
//    translates via view.cropLeft/cropTop and view.scale. Rejects out-of-view points.

// Voice-ready interaction (primitives only — no speech engine):
//   "点击 5"        -> sky.click_cell({window, grid, cell: "5"})
//   "5 号格内 x,y"   -> sky.click_in_cell({window, grid, cell: "5", x, y, view})
//   refined pixels  -> sky.click_view({window, view, x, y})
// Grid JSON already carries everything a voice layer needs per cell:
// {id, row, col, left, top, right, bottom, cx, cy, side} in window pixels.

// js-only helpers on sky (no daemon round-trip except click_cell/click_in_cell/click_view):
// sky.viewport(state) / sky.grid({width,height,cols,rows,left?,top?,right?,bottom?})
// sky.grid_refine(grid, cellId, cols?, rows?) / sky.click_cell({window, grid, cell})
// sky.click_in_cell({window, grid, cell, x, y, view?})
// sky.click_view({window, view, x, y, mouse_button?, click_count?})

type PressKeyInput = {
  key: string;
  window: Window;
};

type TypeTextInput = {
  text: string;
  window: Window;
  /**
   * When false (default): type at the current caret/selection.
   * When true: replace only a focused writable UIA ValuePattern. It fails
   * safely instead of sending Ctrl+A to a document, grid, or application.
   * Read accessibility.focused_value before requesting replacement.
   * The resulting caret position is unspecified.
   */
  replace?: boolean;
};

type ScrollInput = {
  screenshotId?: string;
  scrollX: number;
  scrollY: number;
  window: Window;
  x: number;
  y: number;
};

type SetValueInput = {
  element_index: number;
  value: string;
  window: Window;
};

type DragInput = {
  from_x: number;
  from_y: number;
  screenshotId?: string;
  to_x: number;
  to_y: number;
  window: Window;
};

type PerformSecondaryActionInput = {
  /** This release supports action "Raise" on element_index 0 */
  action: string;
  element_index: number;
  window: Window;
};

type ActivateWindowInput = {
  window: Window;
};

type AppIdentifier = string;

type AccessibilityState = {
  document_text?: string;
  focused_element?: string;
  /** UIA ValuePattern text of the focused control — use for form field contents */
  focused_value?: string | null;
  selected_elements?: Array<string>;
  selected_text?: string;
  /** Omitted when include_text is false. */
  tree?: string;
};

type UiaState = {
  quality: "good" | "weak" | "broken" | "unknown";
  prefer_vision: boolean;
  /** Continuous 0..1 companion to quality (higher = more trustworthy tree). */
  confidence?: number;
  reason: string;
  actionable_count?: number;
  no_hit_count?: number;
  element_count?: number;
  howto?: string;
};

type Screenshot = {
  height?: number;
  id: string;
  originX?: number;
  originY?: number;
  /** Present only when pixels are identical to the previous capture (short-TTL
   *  dedup, invalidated by any input into the window): url is then omitted and
   *  the agent MUST reuse the image from the previous response. */
  unchanged?: boolean;
  /** window px / image px (1 when no downscale). */
  scale?: number;
  /** Omitted when unchanged is true. */
  url: string;
  width?: number;
  zIndex: number;
};

type MouseButton = "left" | "right" | "middle" | "l" | "r" | "m";
```

### Text-field contract

1. Model focuses control and calls `get_window_state` with `include_text: true`.
2. Model reads `accessibility.focused_value`.
3. If already correct → no `type_text`.
4. If replacing that focused value → `type_text({ text, replace: true })` once.
5. If typing at a caret or explicit selection → `type_text({ text })`.

### Capture size, scale, and dedup contract

- `get_window_state` / `grid_view` JPEG output is capped at a max long edge of
  **1568px** (per-request `max_edge`, or `FASTCUA_MAX_EDGE` env; `<= 0`
  disables). When a capture is downscaled, `scale` (window px / image px) is
  emitted on `screenshots[]`, `viewport`, and grid `view`. **Always read
  `scale` before reasoning about pixel positions**; plain x,y clicks are
  issued in screenshot units and the host maps them through the recorded scale.
- Short-TTL (2s) per-window pixel dedup: an identical frame returns
  `unchanged: true` with no new image payload. Treat `unchanged` as *"same
  pixels as the previous response — reuse that image"*. Dedup never spans
  different windows and is invalidated by any input (`click`, `type_text`,
  `press_key`, `scroll`, `drag`, `set_value`) into the window.
- `grid_view` `view` object: `{cropLeft, cropTop, cropRight, cropBottom,
  width, height, scale, note}` — the coordinate contract for
  `sky.click_view({window, view, x, y})`: window px = (cropLeft + x*scale,
  cropTop + y*scale).

### Per-app UIA quality profile (prior, not verdict)

The daemon keeps `<configDir>/uia-profile.json` with per-app observations
(exe identity = full path + PE timestamp + content hash; records: quality
history, avg snapshot ms, hang count, last_seen; 30-day TTL; corrupt/missing
file = all apps unknown). A known-bad app's first UIA request in a session
runs a **short ~300ms probe** instead of the full provider timeout: probe
failure keeps the session-disabled fast path, probe success rehabilitates the
app immediately (bad score decays, normal path resumes). Real-time
`assess_uia_quality` still runs on every call — the profile only shortens the
first failure, it never skips UIA.
