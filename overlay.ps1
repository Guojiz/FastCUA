param(
    [int]$Port = 8420,
    [string]$Title = "FastCUA"
)

$ErrorActionPreference = "Stop"

# Single-instance guard: if another overlay is already running, exit quietly.
$script:mutex = [System.Threading.Mutex]::new($false, "Global\FastCUAOverlay")
if (-not $script:mutex.WaitOne(0, $false)) { exit }

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

# Win32 for full-screen click-through border window
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinApi {
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint crKey, byte alpha, uint flags);
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_LAYERED = 0x80000;
    public const int WS_EX_TRANSPARENT = 0x20;
    public const uint LWA_COLORKEY = 1;
    public const int WM_HOTKEY = 0x312;
    public const int MOD_CONTROL = 2;
    public const int MOD_SHIFT = 4;
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}
"@

$base = "http://127.0.0.1:$Port"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$screenW = [System.Windows.SystemParameters]::PrimaryScreenWidth
$screenH = [System.Windows.SystemParameters]::PrimaryScreenHeight

# Soft pastel rainbow — Apple-style thin translucent edge glow (not RGB gaming strip)
$rainbowColors = @(
    "#FF7F99",  # soft pink
    "#FFAA77",  # soft peach
    "#FFD677",  # soft gold
    "#88DD88",  # soft mint
    "#77AADD",  # soft sky
    "#AA88DD",  # soft lavender
    "#DD77BB"   # soft rose
)

# ============================================================
# Window A: full-screen click-through rainbow screen-edge border
# ============================================================
$borderWin = New-Object System.Windows.Window
$borderWin.WindowStyle = [System.Windows.WindowStyle]::None
$borderWin.AllowsTransparency = $true
$borderWin.Background = [System.Windows.Media.Brushes]::Transparent
$borderWin.ResizeMode = [System.Windows.ResizeMode]::NoResize
$borderWin.Topmost = $true
$borderWin.ShowInTaskbar = $false
$borderWin.ShowActivated = $false
$borderWin.Left = 0
$borderWin.Top = 0
$borderWin.Width = $screenW
$borderWin.Height = $screenH

$borderBrush = New-Object System.Windows.Media.LinearGradientBrush
$borderBrush.StartPoint = New-Object System.Windows.Point(0, 0)
$borderBrush.EndPoint = New-Object System.Windows.Point(1, 1)
foreach ($c in $rainbowColors) {
    $stop = New-Object System.Windows.Media.GradientStop
    $stop.Color = [System.Windows.Media.ColorConverter]::ConvertFromString($c)
    $stop.Offset = 0
    $borderBrush.GradientStops.Add($stop)
}

$borderEl = New-Object System.Windows.Controls.Border
$borderEl.BorderBrush = $borderBrush
$borderEl.BorderThickness = New-Object System.Windows.Thickness(3)
$borderEl.Background = [System.Windows.Media.Brushes]::Transparent
$borderWin.Content = $borderEl

# Make the border window click-through (mouse events pass to the desktop behind it).
# WPF AllowsTransparency already gives us a layered window; just add WS_EX_TRANSPARENT.
$borderWin.Add_SourceInitialized({
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($borderWin)
    $helper.EnsureHandle()
    $hwnd = $helper.Handle
    $ex = [WinApi]::GetWindowLong($hwnd, [WinApi]::GWL_EXSTYLE)
    [WinApi]::SetWindowLong($hwnd, [WinApi]::GWL_EXSTYLE, $ex -bor [WinApi]::WS_EX_TRANSPARENT)
})

# ============================================================
# Window B: corner card (interactive) — loaded from card.xaml
# ============================================================
$cardXaml = [System.IO.File]::ReadAllText([System.IO.Path]::Combine($scriptDir, "card.xaml"))
$cardXaml = $cardXaml.Replace("TITLE_PLACEHOLDER", $Title)
$cardXaml = $cardXaml.Replace("SUBTITLE_PLACEHOLDER", "Esc to quit / Esc 退出")
$reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($cardXaml))
$cardWin = [System.Windows.Markup.XamlReader]::Load($reader)
$reader.Close()
$cardWin.Topmost = $true
# Top-center, near Siri bar
$cardWin.Left = ($screenW - $cardWin.Width) / 2
$cardWin.Top = 40

$NF = { param($n) $cardWin.FindName($n) }
$stopBtn  = & $NF "StopBtn"
$inputBox = & $NF "InputBox"

# Drag card to move
$cardWin.Add_MouseLeftButtonDown({ try { $cardWin.DragMove() } catch {} })

# ============================================================
# Global hotkeys: Ctrl+Shift+I = interjection, Ctrl+Shift+S = stop
# ============================================================
$cardWin.Add_SourceInitialized({
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($cardWin)
    $script:hwndCard = $helper.Handle

    # Register global hotkeys
    $HOTKEY_INTERJECT = 1
    $HOTKEY_STOP = 2
    [WinApi]::RegisterHotKey($script:hwndCard, $HOTKEY_INTERJECT,
        [WinApi]::MOD_CONTROL -bor [WinApi]::MOD_SHIFT, 0x49) | Out-Null  # Ctrl+Shift+I
    [WinApi]::RegisterHotKey($script:hwndCard, $HOTKEY_STOP,
        [WinApi]::MOD_CONTROL -bor [WinApi]::MOD_SHIFT, 0x53) | Out-Null  # Ctrl+Shift+S

    # Hook WndProc for WM_HOTKEY
    $source = [System.Windows.Interop.HwndSource]::FromHwnd($script:hwndCard)
    $source.AddHook({
        param($hwnd, $msg, $wParam, $lParam, $ref)
        if ($msg -eq [WinApi]::WM_HOTKEY) {
            switch ($wParam.ToInt32()) {
                1 { # Ctrl+Shift+I: raise card + focus input
                    $cardWin.Dispatcher.Invoke({
                        $cardWin.Show()
                        $cardWin.Activate()
                        $inputBox.Focus()
                        $script:visible = $true
                        $script:lastActivity = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                    })
                    return 1
                }
                2 { # Ctrl+Shift+S: stop
                    $cardWin.Dispatcher.Invoke({
                        try { Invoke-RestMethod -Uri "$base/api/action" -Method Post -ContentType "application/json" -Body '{"action":"stopAll"}' -TimeoutSec 3 | Out-Null } catch {}
                    })
                    return 1
                }
            }
        }
        return 0
    })
})

# Helpers
# ============================================================
function Build-RainbowStops($t) {
    $n = $rainbowColors.Count
    $stops = New-Object System.Windows.Media.GradientStopCollection
    for ($i = 0; $i -lt 7; $i++) {
        $offset = [Math]::Round(($i / 6.0 + $t) % 1.0, 4)
        $ci = [Math]::Abs([Math]::Floor(($i + $t * $n) % $n)) % $n
        $color = [System.Windows.Media.ColorConverter]::ConvertFromString($rainbowColors[$ci])
        $stops.Add((New-Object System.Windows.Media.GradientStop $color, $offset))
    }
    return $stops
}

# ============================================================
# State
# ============================================================
$script:lastEventId = 0
$script:inflight = $null
$script:history = @()
$script:visible = $false
$script:lastActivity = 0

# ============================================================
# Timer: animate rainbow + poll daemon + update display
# ============================================================
$timer = [System.Windows.Threading.DispatcherTimer]::new(
    [System.Windows.Threading.DispatcherPriority]::Background,
    $cardWin.Dispatcher)
$timer.Interval = [TimeSpan]::FromMilliseconds(70)

$script:tickCount = 0
$timer.Add_Tick({
    $script:tickCount++

    # animate rainbow gradient on the screen-edge border
    $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 20000.0
    $newStops = Build-RainbowStops $t
    $borderBrush.GradientStops.Clear()
    foreach ($s in $newStops) { $borderBrush.GradientStops.Add($s) }

    # Auto-hide when idle: no inflight for >2.5s → hide both windows.
    # Auto-show when inflight appears or fresh activity arrives.
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($script:inflight) {
        $script:lastActivity = $nowMs
        if (-not $script:visible) {
            $borderWin.Dispatcher.Invoke({ $borderWin.Show() })
            $cardWin.Dispatcher.Invoke({ $cardWin.Show() })
            $script:visible = $true
        }
    } elseif ($script:visible -and ($nowMs - $script:lastActivity) -gt 2500) {
        $borderWin.Dispatcher.Invoke({ $borderWin.Hide() })
        $cardWin.Dispatcher.Invoke({ $cardWin.Hide() })
        $script:visible = $false
    }

    # poll daemon every ~700ms (every 10th tick) when visible, ~2.1s when hidden
    $pollInterval = if ($script:visible) { 10 } else { 30 }
    if ($script:tickCount % $pollInterval -eq 0) {
        try {
            $resp = Invoke-RestMethod -Uri "$base/api/events?since=$script:lastEventId" -Method Get -TimeoutSec 3
            if ($resp.inflight) { $script:inflight = $resp.inflight } else { $script:inflight = $null }
            foreach ($e in $resp.events) {
                if ($e.id -gt $script:lastEventId) { $script:lastEventId = $e.id }
                if ($e.type -eq "action_end") {
                    $script:history += $e
                    $script:lastActivity = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                }
            }
            while ($script:history.Count -gt 5) { $script:history = $script:history[1..($script:history.Count-1)] }
        } catch {}
    }
})
$timer.Start()

# ============================================================
# Stop button -> interrupt + return to AI
# ============================================================
$stopBtn.Add_Click({
    try { Invoke-RestMethod -Uri "$base/api/action" -Method Post -ContentType "application/json" -Body '{"action":"stopAll"}' -TimeoutSec 3 | Out-Null } catch {}
})

# ============================================================
# Input -> interjection (return to AI with the message)
# ============================================================
$inputBox.Add_KeyDown({
    param($s, $e)
    if ($e.Key -eq "Return") {
        $text = $inputBox.Text.Trim()
        if ($text.Length -gt 0) {
            try {
                $body = @{text = $text} | ConvertTo-Json
                Invoke-RestMethod -Uri "$base/api/interject" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 3 | Out-Null
                $inputBox.Text = ""
            } catch {}
        }
        $e.Handled = $true
    }
})

$borderWin.Add_Closed({
    $timer.Stop()
    try { [WinApi]::UnregisterHotKey($script:hwndCard, 1) | Out-Null } catch {}
    try { [WinApi]::UnregisterHotKey($script:hwndCard, 2) | Out-Null } catch {}
    $cardWin.Close()
})
$cardWin.Add_Closed({ $timer.Stop(); $borderWin.Close() })

# ============================================================
# Run the WPF dispatcher (windows start hidden, shown on first action)
# ============================================================
[System.Windows.Threading.Dispatcher]::Run()
