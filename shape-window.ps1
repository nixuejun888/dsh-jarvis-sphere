param(
  [ValidateSet('ball', 'rect')]
  [string]$Mode = 'ball',
  [int]$Size = 900,
  [string]$StateDir = "$env:USERPROFILE\.dsh\jarvis-sphere"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class JvsWindowShape {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("gdi32.dll")] public static extern IntPtr CreateEllipticRgn(int x1, int y1, int x2, int y2);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

function Find-JarvisWindow {
  $procs = Get-Process | Where-Object { $_.MainWindowTitle -like '*DeepSeek Harness*' -and $_.MainWindowHandle -ne 0 }
  foreach ($p in $procs) {
    $title = $p.MainWindowTitle
    if ($title -like '*360*') { continue }
    if ($title -like '*DeepSeek Harness*') { return $p.MainWindowHandle }
  }
  return [IntPtr]::Zero
}

$hwnd = Find-JarvisWindow
if ($hwnd -eq [IntPtr]::Zero) { throw 'DeepSeek Harness window not found' }

if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
$stateFile = Join-Path $StateDir 'window-shape.json'

if ($Mode -eq 'ball') {
  $rect = New-Object JvsWindowShape+RECT
  [JvsWindowShape]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  if (-not (Test-Path $stateFile)) {
    [pscustomobject]@{
      left = $rect.Left; top = $rect.Top
      width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top
      maximized = [JvsWindowShape]::IsZoomed($hwnd)
    } | ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8
  }
  if ([JvsWindowShape]::IsZoomed($hwnd)) { [JvsWindowShape]::ShowWindow($hwnd, 9) | Out-Null }
  $side = [Math]::Min($Size, 1000)
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $x = [int]($area.X + ($area.Width - $side) / 2)
  $y = [int]($area.Y + ($area.Height - $side) / 2)
  [JvsWindowShape]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $side, $side, 0x0040) | Out-Null
  $rgn = [JvsWindowShape]::CreateEllipticRgn(0, 0, $side, $side)
  [JvsWindowShape]::SetWindowRgn($hwnd, $rgn, $true) | Out-Null
  [JvsWindowShape]::SetForegroundWindow($hwnd) | Out-Null
  'ball'
} else {
  [JvsWindowShape]::SetWindowRgn($hwnd, [IntPtr]::Zero, $true) | Out-Null
  if (Test-Path $stateFile) {
    $saved = Get-Content $stateFile -Raw | ConvertFrom-Json
    if ($saved.maximized) {
      [JvsWindowShape]::ShowWindow($hwnd, 3) | Out-Null
    } else {
      [JvsWindowShape]::SetWindowPos($hwnd, [IntPtr]::Zero, [int]$saved.left, [int]$saved.top, [int]$saved.width, [int]$saved.height, 0x0040) | Out-Null
    }
    Remove-Item $stateFile -Force
  }
  'rect'
}