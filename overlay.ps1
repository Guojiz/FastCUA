param([int]$Port = 8420, [string]$Title = "FastCUA", [string]$Language = "auto")
$ErrorActionPreference = "Stop"
$script:mutex = [System.Threading.Mutex]::new($false, "Global\FastCUAOverlay")
if (-not $script:mutex.WaitOne(0, $false)) { exit }

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class IslandWinApi {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int index, int value);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public const int WM_HOTKEY = 0x312, MOD_CONTROL = 2, MOD_SHIFT = 4;
  public const int GWL_EXSTYLE = -20, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;
  public const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
}
"@
$base = "http://127.0.0.1:$Port"
$script:dpiScale = [Math]::Max(1.0, [IslandWinApi]::GetDpiForSystem() / 96.0)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$xaml = [System.IO.File]::ReadAllText([System.IO.Path]::Combine($scriptDir, "card.xaml"))
$reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($xaml))
$win = [System.Windows.Markup.XamlReader]::Load($reader)
$reader.Close()

$edgeXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" WindowStyle="None"
 AllowsTransparency="True" Background="Transparent" ResizeMode="NoResize" Topmost="True"
 ShowInTaskbar="False" ShowActivated="False">
  <Border Name="EdgeBorder" BorderThickness="5" CornerRadius="2">
    <Border.Effect><DropShadowEffect Color="#5500D8FF" BlurRadius="16" ShadowDepth="0" Opacity=".7"/></Border.Effect>
  </Border>
</Window>
"@
$edgeReader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($edgeXaml))
$edgeWin = [System.Windows.Markup.XamlReader]::Load($edgeReader)
$edgeReader.Close()
$edge = $edgeWin.FindName("EdgeBorder")
$edgeWin.Left = [System.Windows.SystemParameters]::VirtualScreenLeft / $script:dpiScale
$edgeWin.Top = [System.Windows.SystemParameters]::VirtualScreenTop / $script:dpiScale
$edgeWin.Width = [System.Windows.SystemParameters]::VirtualScreenWidth / $script:dpiScale
$edgeWin.Height = [System.Windows.SystemParameters]::VirtualScreenHeight / $script:dpiScale
$edgeWin.IsHitTestVisible = $false
$script:language = if ($Language -in @("en", "zh")) { $Language } elseif ([Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName -eq "zh") { "zh" } else { "en" }

$NF = { param($name) $win.FindName($name) }
$root = & $NF "IslandRoot"
$compact = & $NF "CompactPanel"
$expanded = & $NF "ExpandedPanel"
$dot = & $NF "StateDot"
$status = & $NF "StatusText"
$shortcut = & $NF "ShortcutText"
$action = & $NF "ActionText"
$app = & $NF "AppText"
$approvalPanel = & $NF "ApprovalPanel"
$allowOnce = & $NF "AllowOnceBtn"
$trust = & $NF "TrustBtn"
$fullAccess = & $NF "FullAccessBtn"
$deny = & $NF "DenyBtn"
$pause = & $NF "PauseBtn"
$resume = & $NF "ResumeBtn"
$stop = & $NF "StopBtn"
$exitButton = & $NF "ExitBtn"
$settings = & $NF "SettingsBtn"
$inputBox = & $NF "InputBox"

$script:pending = $null
$script:lastEventId = 0
$script:manualExpanded = $false
$script:forceExpanded = $false
$script:controlState = "running"
$script:hotkeyHwnd = [IntPtr]::Zero
$script:edgeHwnd = [IntPtr]::Zero
$script:rainbowBrush = $null
$script:registeredHotkeys = @{}
$script:keyWasDown = @{}

function B([string]$value) { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }

function T([string]$key) {
  $zh = @{ "using"=(B "RmFzdENVQSDmraPlnKjkvb/nlKjkvaDnmoTnlLXohJE="); "paused"=(B "RmFzdENVQSDlt7LmmoLlgZw="); "approval"=(B "RmFzdENVQSDpnIDopoHmjojmnYM="); "offline"=(B "RmFzdENVQSDlt7Lnprvnur8="); "settings"=(B "Rjcg6K6+572u"); "pause"=(B "Rjgg5pqC5YGc"); "resume"=(B "Rjgg5oGi5aSN"); "interject"=(B "Rjkg5o+S6K+d"); "exit"=(B "RjEwIOmAgOWHug=="); "active"=(B "5qGM6Z2i5o6n5Yi26L+b6KGM5Lit"); "blocked"=(B "5qGM6Z2i6L6T5YWl5bey6ZSB5a6a77yM5oGi5aSN5ZCO57un57ut44CC"); "choose"=(B "MSDkuIDmrKEgfCAyIOWni+e7iCB8IDMg5a6M5YWoIHwgNCDmi5Lnu50="); "waiting"=(B "5q2j5Zyo562J5b6F5L2g55qE5Yaz5a6a"); "inputTip"=(B "6L6T5YWl5oyH5Luk77yM5oyJIEVudGVyIOWPkemAgQ==") }
  $en = @{ "using"="FastCUA is using your computer"; "paused"="FastCUA is paused"; "approval"="FastCUA needs approval"; "offline"="FastCUA is offline"; "settings"="F7 settings"; "pause"="F8 pause"; "resume"="F8 resume"; "interject"="F9 interject"; "exit"="F10 exit"; "active"="Desktop control is active"; "blocked"="Desktop input is blocked until you resume."; "choose"="1 once  |  2 always  |  3 full access  |  4 deny"; "waiting"="is waiting for your decision"; "inputTip"="Type an instruction and press Enter" }
  return $(if ($script:language -eq "zh") { $zh[$key] } else { $en[$key] })
}

function Apply-StaticLabels {
  $settings.Content = $(if ($script:language -eq "zh") { B "6K6+572u" } else { "Settings" })
  $pause.Content = $(if ($script:language -eq "zh") { B "5pqC5YGc" } else { "Pause" })
  $resume.Content = $(if ($script:language -eq "zh") { B "5oGi5aSN" } else { "Resume" })
  $stop.Content = $(if ($script:language -eq "zh") { B "5YGc5q2i5Lu75Yqh" } else { "Stop task" })
  $exitButton.Content = $(if ($script:language -eq "zh") { B "6YCA5Ye6" } else { "Exit" })
  $allowOnce.Content = $(if ($script:language -eq "zh") { B "MSDCtyDlhYHorrjkuIDmrKE=" } else { "1 · Allow once" })
  $trust.Content = $(if ($script:language -eq "zh") { B "MiDCtyDlp4vnu4jmibnlh4Y=" } else { "2 · Always approve" })
  $fullAccess.Content = $(if ($script:language -eq "zh") { B "MyDCtyDlrozlhajorr/pl64=" } else { "3 · Full access" })
  $deny.Content = $(if ($script:language -eq "zh") { B "NCDCtyDmi5Lnu50=" } else { "4 · Deny" })
  $inputBox.ToolTip = T "inputTip"
}

function New-RainbowBrush {
  $brush = [System.Windows.Media.LinearGradientBrush]::new()
  $brush.StartPoint = [System.Windows.Point]::new(0, 0)
  $brush.EndPoint = [System.Windows.Point]::new(1, 1)
  foreach ($item in @(
    @(0.00, "#FF65E7FF"), @(0.20, "#FF74F0B4"), @(0.40, "#FFFFE783"),
    @(0.60, "#FFFF9EB6"), @(0.80, "#FFC6A5FF"), @(1.00, "#FF65E7FF")
  )) {
    $brush.GradientStops.Add([System.Windows.Media.GradientStop]::new(
      [System.Windows.Media.ColorConverter]::ConvertFromString($item[1]), [double]$item[0]))
  }
  $brush.RelativeTransform = [System.Windows.Media.RotateTransform]::new(0, .5, .5)
  return $brush
}

function Keep-Topmost {
  $flags = [IslandWinApi]::SWP_NOMOVE -bor [IslandWinApi]::SWP_NOSIZE -bor [IslandWinApi]::SWP_NOACTIVATE -bor [IslandWinApi]::SWP_SHOWWINDOW
  if ($script:edgeHwnd -ne [IntPtr]::Zero) { [IslandWinApi]::SetWindowPos($script:edgeHwnd, [IslandWinApi]::HWND_TOPMOST, 0, 0, 0, 0, $flags) | Out-Null }
  if ($script:hotkeyHwnd -ne [IntPtr]::Zero) { [IslandWinApi]::SetWindowPos($script:hotkeyHwnd, [IslandWinApi]::HWND_TOPMOST, 0, 0, 0, 0, $flags) | Out-Null }
}

function Set-IslandPosition {
  $work = [System.Windows.SystemParameters]::WorkArea
  $win.Left = $work.Left + ($work.Width - $win.Width) / 2
  $win.Top = $work.Top + 14
}

# Expand/collapse the Dynamic Island.
# - $asManual=$true  → user opened it (F9); sticky until user collapses or exceptional state ends
# - $asManual=$false → system force (approval / pause). Must NOT stick after the state ends,
#   otherwise the panel stays open and blocks the screen (e.g. after Full access / Allow once).
function Set-IslandExpanded([bool]$expand, [bool]$focusInput = $false, [bool]$asManual = $false) {
  if ($expand) {
    if ($asManual) { $script:manualExpanded = $true } else { $script:manualExpanded = $false }
    $win.Width = 580
    $win.Height = if ($approvalPanel.Visibility -eq "Visible") { 300 } else { 200 }
    $expanded.Visibility = "Visible"
    $root.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#F2111522")
    $root.Padding = [System.Windows.Thickness]::new(16, 11, 16, 12)
    Set-IslandPosition
    if ($focusInput) {
      $win.ShowActivated = $true
      $win.Activate() | Out-Null
      $inputBox.Focus() | Out-Null
    }
  } else {
    $script:manualExpanded = $false
    $script:forceExpanded = $false
    $expanded.Visibility = "Collapsed"
    $win.Width = 410
    $win.Height = 68
    $root.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#A8111522")
    $root.Padding = [System.Windows.Thickness]::new(14, 9, 14, 9)
    $win.ShowActivated = $false
    try { $inputBox.Text = "" } catch {}
    Set-IslandPosition
  }
}

# Collapse when leaving exceptional UI states (approval resolved, resume, deny, etc.).
function Collapse-Island {
  Set-IslandExpanded $false
}

function Set-StateStyle([string]$state) {
  $palette = switch ($state) {
    "awaiting_approval" { @{ dot = "#FFF8D782"; border = "#C8F8D782"; glow = "#B0F8A620"; edge = "#FFF4B95E" } }
    "paused_by_user"   { @{ dot = "#FFFF6E7F"; border = "#C8FF6E7F"; glow = "#B0FF304A"; edge = "#FFFF596C" } }
    "offline"          { @{ dot = "#FFFF6E7F"; border = "#9AFF6E7F"; glow = "#80FF304A"; edge = "#FFFF596C" } }
    "working"          { @{ dot = "#FF63D5FF"; border = "#AA63D5FF"; glow = "#9063B8FF"; edge = "#FF63D5FF" } }
    "full_access"      { @{ dot = "#FFFF70C6"; border = "#C8FF70C6"; glow = "#B0B45CFF"; edge = "#FFFF70C6" } }
    default             { @{ dot = "#FF38D996"; border = "#7A63D5FF"; glow = "#6A00B8FF"; edge = $null } }
  }
  $dot.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString($palette.dot)
  $root.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString($palette.border)
  $root.Effect.Color = [System.Windows.Media.ColorConverter]::ConvertFromString($palette.glow)
  if ($palette.edge) {
    $edge.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString($palette.edge)
  } else {
    $script:rainbowBrush = New-RainbowBrush
    $edge.BorderBrush = $script:rainbowBrush
  }
  $edge.Effect.Color = [System.Windows.Media.ColorConverter]::ConvertFromString($palette.glow)
}

function Open-Settings {
  # Pause if daemon is up; still open the console URL so the user can diagnose offline state.
  # Keep strings ASCII-only so PowerShell parsing stays encoding-safe.
  try {
    Invoke-RestMethod -Uri "$base/api/action" -Method Post -ContentType "application/json" -Body (@{ action = "pause" } | ConvertTo-Json -Compress) -TimeoutSec 2 | Out-Null
  } catch {
    try { $action.Text = "Console offline - opening page" } catch {}
  }
  Start-Process "$base/" | Out-Null
}

function Post-Action([string]$name, [string]$token = "") {
  try {
    Invoke-RestMethod -Uri "$base/api/action" -Method Post -ContentType "application/json" -Body (@{ action = $name; token = $token } | ConvertTo-Json -Compress) -TimeoutSec 3 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Open-Interjection {
  # Always pause first so the agent stops while the user types.
  # Pause is a silent block (no agent instruction). The typed text is the only prompt.
  if ($script:controlState -ne "paused_by_user") {
    Post-Action "pause" | Out-Null
    $script:controlState = "paused_by_user"
  }
  # User-initiated expand (sticky while paused so they can type).
  Set-IslandExpanded $true $true $true
}

function Decide-Approval([string]$name) {
  if (-not $script:pending) { return }
  $token = $script:pending.token
  # Optimistic collapse: hide approval UI immediately so the panel does not keep
  # blocking the screen after Full access / Allow once / Always / Deny.
  $script:pending = $null
  $approvalPanel.Visibility = "Collapsed"
  Collapse-Island
  Post-Action $name $token | Out-Null
}

function Resume-Control {
  Post-Action "resume" | Out-Null
  $script:controlState = "running"
  Collapse-Island
}

function Send-Interjection {
  $text = $inputBox.Text.Trim()
  if (-not $text) { return }
  try {
    # Ensure paused, then deliver interjection text as the agent-facing instruction.
    # /api/interject is atomic (interrupt + pause); stopAll remains a safe follow-up.
    if ($script:controlState -ne "paused_by_user") {
      Post-Action "pause" | Out-Null
    }
    Invoke-RestMethod -Uri "$base/api/interject" -Method Post -ContentType "application/json" -Body (@{ text = $text } | ConvertTo-Json -Compress) -TimeoutSec 3 | Out-Null
    Post-Action "stopAll" | Out-Null
    $inputBox.Text = ""
    $script:controlState = "paused_by_user"
    # After send: stay compact unless pause UI needs the expanded resume controls.
    # Refresh-Island will re-open compact-or-expanded for paused state next tick.
    Collapse-Island
    try {
      $status.Text = T "paused"
      $action.Text = "Interjected and paused"
    } catch {}
  } catch {
    try {
      $action.Text = "Interject failed: daemon unavailable"
      $status.Text = T "offline"
    } catch {}
  }
}

function Refresh-Island {
  try {
    $feed = Invoke-RestMethod -Uri "$base/api/events?since=$script:lastEventId" -Method Get -TimeoutSec 2
    foreach ($event in $feed.events) {
      if ($event.id -gt $script:lastEventId) { $script:lastEventId = $event.id }
    }
    $pending = @($feed.pendingApprovals)[0]
    # PowerShell may yield $null for empty pendingApprovals[0]
    if ($null -eq $pending -or ($pending -is [string] -and [string]::IsNullOrWhiteSpace($pending))) { $pending = $null }
    $script:controlState = $feed.controlState
    $prevForce = $script:forceExpanded
    $script:forceExpanded = $false

    if ($feed.controlState -eq "paused_by_user") {
      Set-StateStyle "paused_by_user"
      $status.Text = T "paused"
      $shortcut.Text = "$(T 'settings')  |  $(T 'resume')  |  $(T 'interject')  |  $(T 'exit')"
      $action.Text = T "blocked"
      $approvalPanel.Visibility = "Collapsed"
      $pause.Visibility = "Collapsed"
      $resume.Visibility = "Visible"
      $script:pending = $null
      $script:forceExpanded = $true
      # System force-expand for pause controls (not sticky after resume).
      if ($expanded.Visibility -ne "Visible") { Set-IslandExpanded $true $false $false }
    } elseif ($pending) {
      Set-StateStyle "awaiting_approval"
      $status.Text = T "approval"
      $shortcut.Text = T "choose"
      $action.Text = "$($pending.action) $(T 'waiting')"
      $app.Text = $pending.app
      $approvalPanel.Visibility = "Visible"
      $pause.Visibility = "Collapsed"
      $resume.Visibility = "Collapsed"
      $script:pending = $pending
      $script:forceExpanded = $true
      # System force-expand for approval (not sticky after decision).
      if ($expanded.Visibility -ne "Visible" -or $win.Height -lt 170 -or $approvalPanel.Visibility -ne "Visible") {
        Set-IslandExpanded $true $false $false
      } else {
        # Keep size correct while approval panel is showing.
        $win.Height = 300
      }
    } else {
      # Normal / full-access / working: island must go compact unless user kept it open (F9).
      Set-StateStyle $(if ($feed.approvalPolicy -eq "full") { "full_access" } elseif ($feed.inflight) { "working" } else { "ready" })
      $status.Text = T "using"
      $shortcut.Text = $(if ($feed.approvalPolicy -eq "full") { "FULL ACCESS  |  $(T 'settings')  |  $(T 'pause')  |  $(T 'interject')  |  $(T 'exit')" } else { "$(T 'settings')  |  $(T 'pause')  |  $(T 'interject')  |  $(T 'exit')" })
      $action.Text = $(if ($feed.inflight) { $feed.inflight.summary } else { T "active" })
      $approvalPanel.Visibility = "Collapsed"
      $pause.Visibility = "Visible"
      $resume.Visibility = "Collapsed"
      $script:pending = $null
      $script:forceExpanded = $false
      # Leaving exceptional UI (approval resolved, resume, deny, offline recovery):
      # system force-expand must never stick; only pure F9 manual expand may remain.
      if ($prevForce) {
        Collapse-Island
      } elseif ($expanded.Visibility -eq "Visible" -and -not $script:manualExpanded) {
        Collapse-Island
      }
    }
  } catch {
    $script:forceExpanded = $false
    Set-StateStyle "offline"
    $status.Text = T "offline"
    $shortcut.Text = "Start the local daemon to reconnect"
    $approvalPanel.Visibility = "Collapsed"
    $pause.Visibility = "Collapsed"
    $resume.Visibility = "Collapsed"
    # Offline: collapse so a large dead panel does not cover the desktop.
    if ($expanded.Visibility -eq "Visible" -and -not $script:manualExpanded) { Collapse-Island }
  }
}

$edgeWin.Add_SourceInitialized({
  $script:edgeHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($edgeWin)).Handle
  $style = [IslandWinApi]::GetWindowLong($script:edgeHwnd, [IslandWinApi]::GWL_EXSTYLE)
  [IslandWinApi]::SetWindowLong($script:edgeHwnd, [IslandWinApi]::GWL_EXSTYLE,
    $style -bor [IslandWinApi]::WS_EX_TRANSPARENT -bor [IslandWinApi]::WS_EX_TOOLWINDOW -bor [IslandWinApi]::WS_EX_NOACTIVATE) | Out-Null
  Keep-Topmost
})

$win.Add_SourceInitialized({
  $script:hotkeyHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
  $script:registeredHotkeys[1] = [IslandWinApi]::RegisterHotKey($script:hotkeyHwnd, 1, 0, 0x76)
  $script:registeredHotkeys[2] = [IslandWinApi]::RegisterHotKey($script:hotkeyHwnd, 2, 0, 0x77)
  $script:registeredHotkeys[3] = [IslandWinApi]::RegisterHotKey($script:hotkeyHwnd, 3, 0, 0x78)
  $script:registeredHotkeys[4] = [IslandWinApi]::RegisterHotKey($script:hotkeyHwnd, 4, 0, 0x79)
  Write-Output "hotkeys F7=$($script:registeredHotkeys[1]) F8=$($script:registeredHotkeys[2]) F9=$($script:registeredHotkeys[3]) F10=$($script:registeredHotkeys[4])"
  $source = [System.Windows.Interop.HwndSource]::FromHwnd($script:hotkeyHwnd)
  $source.AddHook({
    param($h, $message, $w, $l, $handled)
    if ($message -eq [IslandWinApi]::WM_HOTKEY) {
      switch ($w.ToInt32()) {
        1 { Open-Settings }
        2 { Toggle-PauseResume }
        3 { Open-Interjection }
        4 { Post-Action "shutdown" }
      }
      return [IntPtr]::new(1)
    }
    return [IntPtr]::Zero
  })
  Set-IslandPosition
  Keep-Topmost
})

function Toggle-PauseResume {
  if ($script:controlState -eq "paused_by_user") {
    Resume-Control
  } else {
    Post-Action "pause" | Out-Null
  }
}

$compact.Add_MouseLeftButtonUp({ Open-Settings })
$settings.Add_Click({ Open-Settings })
$pause.Add_Click({ Post-Action "pause" })
$resume.Add_Click({ Resume-Control })
$stop.Add_Click({ Post-Action "stopAll"; Collapse-Island })
$exitButton.Add_Click({ Post-Action "shutdown" })
$allowOnce.Add_Click({ Decide-Approval "allowOnce" })
$trust.Add_Click({ Decide-Approval "alwaysApprove" })
$fullAccess.Add_Click({ Decide-Approval "fullAccess" })
$deny.Add_Click({ Decide-Approval "denyApproval" })
$inputBox.Add_KeyDown({ param($sender, $event) if ($event.Key -eq "Return") { Send-Interjection; $event.Handled = $true } })

# Approval keyboard: 1 once / 2 always / 3 full access / 4 deny
$win.Add_PreviewKeyDown({
  param($sender, $event)
  if ($approvalPanel.Visibility -ne "Visible" -or -not $script:pending) { return }
  if ($inputBox.IsKeyboardFocused) { return }
  switch ($event.Key.ToString()) {
    "D1" { Decide-Approval "allowOnce"; $event.Handled = $true }
    "NumPad1" { Decide-Approval "allowOnce"; $event.Handled = $true }
    "D2" { Decide-Approval "alwaysApprove"; $event.Handled = $true }
    "NumPad2" { Decide-Approval "alwaysApprove"; $event.Handled = $true }
    "D3" { Decide-Approval "fullAccess"; $event.Handled = $true }
    "NumPad3" { Decide-Approval "fullAccess"; $event.Handled = $true }
    "D4" { Decide-Approval "denyApproval"; $event.Handled = $true }
    "NumPad4" { Decide-Approval "denyApproval"; $event.Handled = $true }
  }
})

$timer = [System.Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(400)
$timer.Add_Tick({ Keep-Topmost; Refresh-Island })
$timer.Start()
$keyTimer = [System.Windows.Threading.DispatcherTimer]::new()
$keyTimer.Interval = [TimeSpan]::FromMilliseconds(55)
$keyTimer.Add_Tick({
  foreach ($item in @(@(1,0x76),@(2,0x77),@(3,0x78),@(4,0x79))) {
    $id = $item[0]; $vk = $item[1]
    if ($script:registeredHotkeys[$id]) { continue }
    $down = ([IslandWinApi]::GetAsyncKeyState($vk) -band 0x8000) -ne 0
    if ($down -and -not $script:keyWasDown[$id]) {
      switch ($id) {
        1 { Open-Settings }
        2 { Toggle-PauseResume }
        3 { Open-Interjection }
        4 { Post-Action "shutdown" }
      }
    }
    $script:keyWasDown[$id] = $down
  }
  # Global approval keys (work even when island does not have keyboard focus)
  if ($approvalPanel.Visibility -eq "Visible" -and $script:pending -and -not $inputBox.IsKeyboardFocused) {
    foreach ($item in @(@("ap1",0x31,"allowOnce"),@("ap2",0x32,"alwaysApprove"),@("ap3",0x33,"fullAccess"),@("ap4",0x34,"denyApproval"))) {
      $id = $item[0]; $vk = $item[1]; $actionName = $item[2]
      $down = ([IslandWinApi]::GetAsyncKeyState($vk) -band 0x8000) -ne 0
      if ($down -and -not $script:keyWasDown[$id]) { Decide-Approval $actionName }
      $script:keyWasDown[$id] = $down
    }
  }
})
$keyTimer.Start()
$win.Add_Closed({
  $timer.Stop()
  $keyTimer.Stop()
  if ($script:hotkeyHwnd -ne [IntPtr]::Zero) {
    1..4 | ForEach-Object { [IslandWinApi]::UnregisterHotKey($script:hotkeyHwnd, $_) | Out-Null }
  }
  $edgeWin.Close()
  try { $script:mutex.ReleaseMutex() } catch {}
})

Set-IslandPosition
Apply-StaticLabels
Set-StateStyle "ready"
$edgeWin.Show()
$win.Show()
Refresh-Island
[System.Windows.Threading.Dispatcher]::Run()
