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
$reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($cardXaml))
$cardWin = [System.Windows.Markup.XamlReader]::Load($reader)
$reader.Close()
$cardWin.Topmost = $true
# Top-center, near Siri bar
$cardWin.Left = ($screenW - $cardWin.Width) / 2
$cardWin.Top = 40

$NF = { param($n) $cardWin.FindName($n) }
$text0    = & $NF "Text0"
$text1    = & $NF "Text1"
$stopBtn  = & $NF "StopBtn"
$inputBox = & $NF "InputBox"

# Drag card to move
$cardWin.Add_MouseLeftButtonDown({ try { $cardWin.DragMove() } catch {} })

# ============================================================
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

function Update-Display {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($script:inflight) {
        $elapsed = $now - [long]$script:inflight.ts
        $text0.Text       = $script:inflight.summary
        $text0.Foreground = "#1D1D1F"  # Apple dark gray
    } else {
        $text0.Text       = "Idle"
        $text0.Foreground = "#6E6E73"  # Apple medium gray
    }
    if ($script:history.Count -gt 0) {
        $last = $script:history[-1]
        $text1.Text       = $last.summary
        $text1.Foreground = "#8E8E93"  # Apple light gray
    } else {
        $text1.Text = ""
    }
}

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

    # update elapsed time every tick (smooth)
    Update-Display

    # poll daemon every ~1.4s (every 20th tick)
    if ($script:tickCount % 20 -eq 0) {
        try {
            $resp = Invoke-RestMethod -Uri "$base/api/events?since=$script:lastEventId" -Method Get -TimeoutSec 3
            if ($resp.inflight) { $script:inflight = $resp.inflight } else { $script:inflight = $null }
            foreach ($e in $resp.events) {
                if ($e.id -gt $script:lastEventId) { $script:lastEventId = $e.id }
                if ($e.type -eq "action_end") { $script:history += $e }
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

$borderWin.Add_Closed({ $timer.Stop(); $cardWin.Close() })
$cardWin.Add_Closed({ $timer.Stop(); $borderWin.Close() })

# ============================================================
# Run both windows
# ============================================================
$borderWin.Show()
$cardWin.Show()
[System.Windows.Threading.Dispatcher]::Run()
