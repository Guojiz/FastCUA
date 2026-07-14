## API Reference

# FastCUA sky window2 API

Use this as the supported `sky` / MCP window2 surface for FastCUA.

Tools are available both as individual MCP tools and on `sky` inside the MCP `js` REPL.

```ts
// Inside MCP js: sky is already bound (no @oai/sky import).

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
  window: Window;
};

type WindowState = {
  accessibility: AccessibilityState | null;
  screenshots: Array<Screenshot>;
  window: Window;
  /** Present when host supports it: explicit pixel coordinate space for click/drag/scroll. */
  viewport?: {
    width: number;
    height: number;
    originX?: number;
    originY?: number;
    screenLeft?: number;
    screenTop?: number;
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
};

// js-only helpers on sky (no daemon round-trip except click_cell):
// sky.viewport(state) / sky.grid({width,height,cols,rows,left?,top?,right?,bottom?})
// sky.grid_refine(grid, cellId, cols?, rows?) / sky.click_cell({window, grid, cell})

type PressKeyInput = {
  key: string;
  window: Window;
};

type TypeTextInput = {
  text: string;
  window: Window;
  /**
   * When true (default): clear focused field (select-all + delete), then type.
   * When false: append without clearing.
   * Call only after the model has read accessibility.focused_value and decided to edit.
   * Host does not skip based on current value — that decision is the model's.
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
  focused_value?: string;
  selected_elements?: Array<string>;
  selected_text?: string;
  tree: string;
};

type Screenshot = {
  height?: number;
  id: string;
  originX?: number;
  originY?: number;
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
4. If changing → `type_text({ text, replace: true })` once.
