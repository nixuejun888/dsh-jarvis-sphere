param(
  [ValidateSet('ball', 'rect', 'min', 'close')]
  [string]$Mode = 'ball',
  [int]$Width = 900,
  [int]$Height = 1150,
  [string]$StateDir = "$env:USERPROFILE\.dsh\jarvis-sphere"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class JvsWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
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

switch ($Mode) {
  'min' { [JvsWin]::ShowWindow($hwnd, 6) | Out-Null; 'min'; break }
  'close' { [JvsWin]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; 'close'; break }
  'ball' {
    $rect = New-Object JvsWin+RECT
    [JvsWin]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    if (-not (Test-Path $stateFile)) {
      [pscustomobject]@{
        left = $rect.Left; top = $rect.Top
        width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top
        maximized = [JvsWin]::IsZoomed($hwnd)
      } | ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8
    }
    # a transparent window must not be maximized
    if ([JvsWin]::IsZoomed($hwnd)) { [JvsWin]::ShowWindow($hwnd, 9) | Out-Null }
    [JvsWin]::SetWindowRgn($hwnd, [IntPtr]::Zero, $true) | Out-Null
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $x = [int]($area.X + ($area.Width - $Width) / 2)
    $y = [int]($area.Y + [Math]::Max(0, ($area.Height - $Height) / 2))
    [JvsWin]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $Width, $Height, 0x0040) | Out-Null
    [JvsWin]::SetForegroundWindow($hwnd) | Out-Null
    'ball'
    break
  }
  'rect' {
    [JvsWin]::SetWindowRgn($hwnd, [IntPtr]::Zero, $true) | Out-Null
    if (Test-Path $stateFile) {
      $saved = Get-Content $stateFile -Raw | ConvertFrom-Json
      if ($saved.maximized) { [JvsWin]::ShowWindow($hwnd, 3) | Out-Null }
      else {
        [JvsWin]::SetWindowPos($hwnd, [IntPtr]::Zero, [int]$saved.left, [int]$saved.top, [int]$saved.width, [int]$saved.height, 0x0040) | Out-Null
      }
      Remove-Item $stateFile -Force
    }
    'rect'
    break
  }
}
