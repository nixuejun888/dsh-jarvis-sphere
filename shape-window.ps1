param(
  [ValidateSet('ball', 'rect')]
  [string]$Mode = 'ball',
  [string]$StateDir = "$env:USERPROFILE\.dsh\jarvis-sphere"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class JvsShape {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int x1, int y1, int x2, int y2);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateEllipticRgn(int x1, int y1, int x2, int y2);
  [DllImport("gdi32.dll")] public static extern int CombineRgn(IntPtr dest, IntPtr src1, IntPtr src2, int mode);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
}
"@

function Find-JarvisWindow {
  foreach ($p in Get-Process | Where-Object { $_.MainWindowTitle -like '*DeepSeek Harness*' -and $_.MainWindowHandle -ne 0 }) {
    if ($p.MainWindowTitle -like '*360*') { continue }
    return $p.MainWindowHandle
  }
  return [IntPtr]::Zero
}

$hwnd = Find-JarvisWindow
if ($hwnd -eq [IntPtr]::Zero) { throw 'DeepSeek Harness window not found' }
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
$stateFile = Join-Path $StateDir 'window-shape.json'

# keep these in sync with client.js (BALL_WIDTH / BALL_HEIGHT / BALL_DOCK)
$W = 860
$H = 1180
$DOCK = 300
$SPHERE = $W

if ($Mode -eq 'ball') {
  $rect = New-Object JvsShape+RECT
  [JvsShape]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  if (-not (Test-Path $stateFile)) {
    [pscustomobject]@{
      left = $rect.Left; top = $rect.Top
      width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top
      maximized = [JvsShape]::IsZoomed($hwnd)
    } | ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8
  }
  if ([JvsShape]::IsZoomed($hwnd)) { [JvsShape]::ShowWindow($hwnd, 9) | Out-Null }
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $x = [int]($area.X + ($area.Width - $W) / 2)
  $y = [int]$area.Y
  [JvsShape]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $W, $H, 0x0040) | Out-Null
  # the sphere is a full window-width circle at the top, the dock is a bar below it
  $circle = [JvsShape]::CreateEllipticRgn(0, 0, $SPHERE, $SPHERE)
  $dock = [JvsShape]::CreateRectRgn(0, $H - $DOCK, $W, $H)
  $region = [JvsShape]::CreateRectRgn(0, 0, 0, 0)
  [JvsShape]::CombineRgn($region, $circle, $dock, 2) | Out-Null   # RGN_OR
  [JvsShape]::SetWindowRgn($hwnd, $region, $true) | Out-Null
  [JvsShape]::DeleteObject($circle) | Out-Null
  [JvsShape]::DeleteObject($dock) | Out-Null
  [JvsShape]::SetForegroundWindow($hwnd) | Out-Null
  'ball'
} else {
  [JvsShape]::SetWindowRgn($hwnd, [IntPtr]::Zero, $true) | Out-Null
  if (Test-Path $stateFile) {
    $saved = Get-Content $stateFile -Raw | ConvertFrom-Json
    if ($saved.maximized) {
      [JvsShape]::ShowWindow($hwnd, 3) | Out-Null
    } else {
      [JvsShape]::SetWindowPos($hwnd, [IntPtr]::Zero, [int]$saved.left, [int]$saved.top, [int]$saved.width, [int]$saved.height, 0x0040) | Out-Null
    }
    Remove-Item $stateFile -Force
  }
  'rect'
}
