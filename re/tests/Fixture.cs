using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class FixtureProgram
{
    private const uint WS_OVERLAPPEDWINDOW = 0x00CF0000;
    private const uint WS_VISIBLE = 0x10000000;
    private const uint WS_CHILD = 0x40000000;
    private const uint WS_VSCROLL = 0x00200000;
    private const uint WS_BORDER = 0x00800000;
    private const uint WS_TABSTOP = 0x00010000;
    private const uint ES_AUTOHSCROLL = 0x0080;
    private const uint BS_PUSHBUTTON = 0x00000000;
    private const uint LBS_NOTIFY = 0x0001;
    private const uint TBS_AUTOTICKS = 0x0001;
    private const uint WS_EX_CLIENTEDGE = 0x00000200;
    private const uint WM_DESTROY = 0x0002;
    private const uint WM_COMMAND = 0x0111;
    private const uint LB_ADDSTRING = 0x0180;
    private const int EN_CHANGE = 0x0300;
    private const int SW_SHOW = 5;
    private const int IDC_ARROW = 32512;
    private const int ButtonId = 1001;

    private static readonly WndProc WindowProcedure = HandleMessage;
    private static IntPtr statusWindow;
    private static IntPtr textStatusWindow;
    private static int clicks;

    [STAThread]
    private static void Main()
    {
        var instance = GetModuleHandle(null);
        var className = "FastCuaNativeFixtureWindow";
        var windowClass = new WNDCLASSEX
        {
            cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX)),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(WindowProcedure),
            hInstance = instance,
            hCursor = LoadCursor(IntPtr.Zero, new IntPtr(IDC_ARROW)),
            hbrBackground = new IntPtr(6),
            lpszClassName = className
        };
        if (RegisterClassEx(ref windowClass) == 0)
            throw new InvalidOperationException("RegisterClassEx failed: " + Marshal.GetLastWin32Error());

        var window = CreateWindowEx(
            0, className, "FastCUA Host Test Fixture", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            200, 120, 680, 520, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
        if (window == IntPtr.Zero)
            throw new InvalidOperationException("CreateWindowEx failed: " + Marshal.GetLastWin32Error());

        CreateWindowEx(0, "STATIC", "Fixture Text", WS_CHILD | WS_VISIBLE,
            24, 25, 110, 24, window, IntPtr.Zero, instance, IntPtr.Zero);
        CreateWindowEx(WS_EX_CLIENTEDGE, "EDIT", "initial-value",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL,
            140, 20, 330, 30, window, new IntPtr(1002), instance, IntPtr.Zero);
        CreateWindowEx(0, "BUTTON", "Increment Button",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
            490, 19, 145, 32, window, new IntPtr(ButtonId), instance, IntPtr.Zero);
        statusWindow = CreateWindowEx(0, "STATIC", "Clicks: 0", WS_CHILD | WS_VISIBLE,
            24, 70, 300, 24, window, IntPtr.Zero, instance, IntPtr.Zero);
        textStatusWindow = CreateWindowEx(0, "STATIC", "Text: initial-value", WS_CHILD | WS_VISIBLE,
            180, 70, 330, 24, window, IntPtr.Zero, instance, IntPtr.Zero);

        var list = CreateWindowEx(WS_EX_CLIENTEDGE, "LISTBOX", "",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_VSCROLL | WS_BORDER | LBS_NOTIFY,
            24, 110, 285, 320, window, new IntPtr(1003), instance, IntPtr.Zero);
        for (var index = 1; index <= 100; index++)
            SendMessage(list, LB_ADDSTRING, IntPtr.Zero, "List item " + index);

        CreateWindowEx(0, "STATIC", "Drag Target", WS_CHILD | WS_VISIBLE,
            350, 125, 200, 24, window, IntPtr.Zero, instance, IntPtr.Zero);
        CreateWindowEx(0, "msctls_trackbar32", "",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | TBS_AUTOTICKS,
            350, 160, 285, 55, window, new IntPtr(1004), instance, IntPtr.Zero);

        ShowWindow(window, SW_SHOW);
        UpdateWindow(window);
        MSG message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
    }

    private static IntPtr HandleMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        var commandId = (int)(wParam.ToInt64() & 0xffff);
        var notification = (int)((wParam.ToInt64() >> 16) & 0xffff);
        if (message == WM_COMMAND && commandId == ButtonId)
        {
            SetWindowText(statusWindow, "Clicks: " + (++clicks));
            return IntPtr.Zero;
        }
        if (message == WM_COMMAND && commandId == 1002 && notification == EN_CHANGE)
        {
            var value = new StringBuilder(512);
            GetWindowText(lParam, value, value.Capacity);
            SetWindowText(textStatusWindow, "Text: " + value);
            return IntPtr.Zero;
        }
        if (message == WM_DESTROY)
        {
            PostQuitMessage(0);
            return IntPtr.Zero;
        }
        return DefWindowProc(hwnd, message, wParam, lParam);
    }

    private delegate IntPtr WndProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEX
    {
        public uint cbSize;
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string lpszMenuName;
        public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
        public uint lPrivate;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string moduleName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassEx(ref WNDCLASSEX windowClass);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(uint exStyle, string className, string windowName,
        uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu,
        IntPtr instance, IntPtr parameter);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DefWindowProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    private static extern bool UpdateWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern sbyte GetMessage(out MSG message, IntPtr hwnd, uint min, uint max);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG message);

    [DllImport("user32.dll")]
    private static extern void PostQuitMessage(int exitCode);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool SetWindowText(IntPtr hwnd, string text);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, string lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr LoadCursor(IntPtr instance, IntPtr cursorName);
}
