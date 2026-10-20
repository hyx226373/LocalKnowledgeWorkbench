# desk-r1-A A-03 v2 Win32 window visibility check (ASCII-only for Windows PowerShell 5.1).
# Proves on-screen visibility of OUR window WITHOUT screenshots (GDI is blacked out by content protection):
#   IsWindowVisible(hwnd), !IsIconic(hwnd), GetWindowRect intersects primary monitor,
#   WindowFromPoint(center + 4 quadrant centers of rect-on-primary) -> GetAncestor(GA_ROOT) == hwnd (topmost, unoccluded there).
# Writes raw values to -OutJson. Never throws; failures land in .error (verdict treats that as INCONCLUSIVE).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Hwnd,
  [Parameter(Mandatory = $true)][string]$OutJson,
  [int]$ExpectPid = 0
)
$ErrorActionPreference = 'Stop'
$res = [ordered]@{
  tool = 'win32-window-check.ps1'
  ts = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffzzz')
  hwndInput = $Hwnd
  hwnd = $null
  hwndDec = $null
  threadDpiAwarenessSet = $false
  isWindow = $null
  isWindowVisible = $null
  isIconic = $null
  rect = $null
  primaryMonitor = $null
  intersectsPrimary = $null
  intersection = $null
  point = $null
  windowFromPoint = $null
  rootMatchesHwnd = $null
  ownerPid = $null
  expectPid = $ExpectPid
  ownerPidMatchesExpect = $null
  className = $null
  title = $null
  dpiForWindow = $null
  displayAffinity = $null
  samples = $null
  samplesNotOurs = $null
  samplesAllRootOurs = $null
  error = $null
}
function Fmt-Hwnd([IntPtr]$h) { if ($h -eq [IntPtr]::Zero) { return $null }; return ('0x{0:X}' -f $h.ToInt64()) }
function Rect-Obj($r) { return [ordered]@{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) } }
function Get-Cls([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 256; [void][DeskR1A03Win32]::GetClassName($h, $sb, 256); return $sb.ToString() }
function Get-Ttl([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 512; [void][DeskR1A03Win32]::GetWindowText($h, $sb, 512); return $sb.ToString() }
try {
  if (-not ([System.Management.Automation.PSTypeName]'DeskR1A03Win32').Type) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DeskR1A03Win32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT p, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint procId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint aff);
}
"@
  }
  # Per-monitor-v2 DPI awareness on this thread so all coordinates are physical pixels.
  try { $prev = [DeskR1A03Win32]::SetThreadDpiAwarenessContext([IntPtr](-4)); $res.threadDpiAwarenessSet = ($prev -ne [IntPtr]::Zero) } catch { $res.threadDpiAwarenessSet = $false }

  $s = $Hwnd.Trim()
  if ($s -match '^0[xX]') { $v = [Convert]::ToInt64($s.Substring(2), 16) } else { $v = [Int64]::Parse($s) }
  if ($v -eq 0) { throw 'hwnd is zero/empty' }
  $h = [IntPtr]$v
  $res.hwnd = Fmt-Hwnd $h
  $res.hwndDec = $v
  $res.isWindow = [DeskR1A03Win32]::IsWindow($h)
  if (-not $res.isWindow) { throw "IsWindow false for $($res.hwnd)" }
  $res.isWindowVisible = [DeskR1A03Win32]::IsWindowVisible($h)
  $res.isIconic = [DeskR1A03Win32]::IsIconic($h)
  $res.className = Get-Cls $h
  $res.title = Get-Ttl $h
  $opid = [uint32]0
  [void][DeskR1A03Win32]::GetWindowThreadProcessId($h, [ref]$opid)
  $res.ownerPid = $opid
  if ($ExpectPid -gt 0) { $res.ownerPidMatchesExpect = ($opid -eq $ExpectPid) }
  try { $res.dpiForWindow = [DeskR1A03Win32]::GetDpiForWindow($h) } catch { }
  try { $aff = [uint32]0; if ([DeskR1A03Win32]::GetWindowDisplayAffinity($h, [ref]$aff)) { $res.displayAffinity = ('0x{0:X}' -f $aff) } } catch { }

  $r = New-Object DeskR1A03Win32+RECT
  if (-not [DeskR1A03Win32]::GetWindowRect($h, [ref]$r)) { throw 'GetWindowRect failed' }
  $res.rect = Rect-Obj $r

  $origin = New-Object DeskR1A03Win32+POINT
  $origin.X = 0; $origin.Y = 0
  $hm = [DeskR1A03Win32]::MonitorFromPoint($origin, 1)  # MONITOR_DEFAULTTOPRIMARY
  $mi = New-Object DeskR1A03Win32+MONITORINFO
  $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DeskR1A03Win32+MONITORINFO])
  if (-not [DeskR1A03Win32]::GetMonitorInfo($hm, [ref]$mi)) { throw 'GetMonitorInfo(primary) failed' }
  $isPrimaryFlag = (($mi.dwFlags -band 1) -eq 1)
  $res.primaryMonitor = [ordered]@{ hmonitor = (Fmt-Hwnd $hm); rect = (Rect-Obj $mi.rcMonitor); work = (Rect-Obj $mi.rcWork); flags = $mi.dwFlags; isPrimaryFlag = $isPrimaryFlag }

  $il = [Math]::Max($r.Left, $mi.rcMonitor.Left)
  $it = [Math]::Max($r.Top, $mi.rcMonitor.Top)
  $ir = [Math]::Min($r.Right, $mi.rcMonitor.Right)
  $ib = [Math]::Min($r.Bottom, $mi.rcMonitor.Bottom)
  $inter = ($ir -gt $il -and $ib -gt $it)
  $res.intersectsPrimary = ($inter -and $isPrimaryFlag)
  if ($inter) {
    $res.intersection = [ordered]@{ left = $il; top = $it; right = $ir; bottom = $ib; width = ($ir - $il); height = ($ib - $it) }
    $pt = New-Object DeskR1A03Win32+POINT
    $pt.X = [int][Math]::Floor(($il + $ir) / 2)
    $pt.Y = [int][Math]::Floor(($it + $ib) / 2)
    $res.point = [ordered]@{ x = $pt.X; y = $pt.Y; basis = 'center of (window rect intersect primary monitor); marker div is position:fixed inset:0' }
    $hit = [DeskR1A03Win32]::WindowFromPoint($pt)
    $root = [IntPtr]::Zero
    if ($hit -ne [IntPtr]::Zero) { $root = [DeskR1A03Win32]::GetAncestor($hit, 2) }  # GA_ROOT
    $rootPid = [uint32]0
    if ($root -ne [IntPtr]::Zero) { [void][DeskR1A03Win32]::GetWindowThreadProcessId($root, [ref]$rootPid) }
    $res.windowFromPoint = [ordered]@{
      hwnd = (Fmt-Hwnd $hit); class = $(if ($hit -ne [IntPtr]::Zero) { Get-Cls $hit } else { $null })
      rootHwnd = (Fmt-Hwnd $root); rootClass = $(if ($root -ne [IntPtr]::Zero) { Get-Cls $root } else { $null })
      rootTitle = $(if ($root -ne [IntPtr]::Zero) { Get-Ttl $root } else { $null }); rootPid = $rootPid
    }
    $res.rootMatchesHwnd = ($root -ne [IntPtr]::Zero -and $root.ToInt64() -eq $v)
    # A-03 v2.1: sample center + four quadrant centers of (rect intersect primary). Fail closed: any root != hwnd -> rootMatchesHwnd=false.
    $sw = ($ir - $il); $sh2 = ($ib - $it)
    $defs = @(
      @('center', [Math]::Floor(($il + $ir) / 2), [Math]::Floor(($it + $ib) / 2)),
      @('q_tl', [Math]::Floor($il + $sw / 4), [Math]::Floor($it + $sh2 / 4)),
      @('q_tr', [Math]::Floor($il + 3 * $sw / 4), [Math]::Floor($it + $sh2 / 4)),
      @('q_bl', [Math]::Floor($il + $sw / 4), [Math]::Floor($it + 3 * $sh2 / 4)),
      @('q_br', [Math]::Floor($il + 3 * $sw / 4), [Math]::Floor($it + 3 * $sh2 / 4))
    )
    $samples = @()
    foreach ($d in $defs) {
      $sp = New-Object DeskR1A03Win32+POINT
      $sp.X = [int]$d[1]; $sp.Y = [int]$d[2]
      $shit = [DeskR1A03Win32]::WindowFromPoint($sp)
      $sroot = [IntPtr]::Zero
      if ($shit -ne [IntPtr]::Zero) { $sroot = [DeskR1A03Win32]::GetAncestor($shit, 2) }
      $spid = [uint32]0
      if ($sroot -ne [IntPtr]::Zero) { [void][DeskR1A03Win32]::GetWindowThreadProcessId($sroot, [ref]$spid) }
      $samples += [pscustomobject][ordered]@{
        name = $d[0]; x = $sp.X; y = $sp.Y
        hwnd = (Fmt-Hwnd $shit); class = $(if ($shit -ne [IntPtr]::Zero) { Get-Cls $shit } else { $null })
        rootHwnd = (Fmt-Hwnd $sroot); rootClass = $(if ($sroot -ne [IntPtr]::Zero) { Get-Cls $sroot } else { $null })
        rootTitle = $(if ($sroot -ne [IntPtr]::Zero) { Get-Ttl $sroot } else { $null }); rootPid = $spid
        rootIsOurs = ($sroot -ne [IntPtr]::Zero -and $sroot.ToInt64() -eq $v)
      }
    }
    $res.samples = $samples
    $bad = @($samples | Where-Object { -not $_.rootIsOurs })
    $res.samplesNotOurs = @($bad | ForEach-Object { $_.name })
    $res.samplesAllRootOurs = ($samples.Count -eq 5 -and $bad.Count -eq 0)
    $res.rootMatchesHwnd = ([bool]$res.rootMatchesHwnd -and $res.samplesAllRootOurs)
  } else {
    $res.rootMatchesHwnd = $false
    $res.samplesAllRootOurs = $false
  }
} catch {
  $res.error = $_.Exception.Message
}
$json = $res | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($OutJson, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host ("win32-check: hwnd={0} visible={1} iconic={2} onPrimary={3} wfpRoot={4} rootMatch={5} affinity={6} err={7}" -f $res.hwnd, $res.isWindowVisible, $res.isIconic, $res.intersectsPrimary, $(if ($res.windowFromPoint) { $res.windowFromPoint.rootHwnd } else { $null }), $res.rootMatchesHwnd, $res.displayAffinity, $res.error)
if ($res.samples) { foreach ($q in $res.samples) { Write-Host ("  wfp[{0}] ({1},{2}) hit={3} root={4} rootClass={5} ours={6}" -f $q.name, $q.x, $q.y, $q.hwnd, $q.rootHwnd, $q.rootClass, $q.rootIsOurs) } }
