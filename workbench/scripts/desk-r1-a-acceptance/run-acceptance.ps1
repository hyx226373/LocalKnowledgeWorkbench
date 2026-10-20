# desk-r1-A acceptance launcher round-5 (ASCII-only: Windows PowerShell 5.1 misreads BOM-less UTF-8).
# r6: -A03Only; port-9222 preflight hard-fail; A-03 v2 = phase1 positive control (protection OFF, OS-ref+stream) + phase2 Win32 visibility (protection ON); txt from JSON only.
# Default: self-check (NO Electron). Full run ONLY with -FullRun after supervisor says "kaipao" (go).
# GrabFrame: -GrabFrame -SelfCheck (static) | -GrabFrame -Out <png> [-Count/-IntervalMs] | -GrabFrame -KeepAlive (trigger file).
# E-04: KeepAlive keeps ONE persistent MediaStream track; -HideMode minimize|offscreen; -PcRoi x,y,w,h; exit 3 = STALE.
# E-04 v2: exit 3 = STALE (any frame), exit 4 = INCONCLUSIVE (no capture timestamp / ImageCapture w/o -PcRoi /
#   own window not uniquely identifiable -> hide refused; v3: also hide failed). KeepAlive quit = worst frame (3 > 4 > 0). Neither prints "GrabFrame OK". Hide acts on OUR hwnd only
#   (-Hwnd N, page test hook, or unique document.title marker); -ProtectHwnd a,b = E panel hwnds never touched.
# Default FullRun does NOT set DESK_R1_STUB_FULLSCREEN. Use -AllowStub only with printed reason.
[CmdletBinding()]
param(
  [switch]$SelfCheck,
  [switch]$FullRun,
  [switch]$A03Only,
  [switch]$GrabFrame,
  [string]$Out = '',
  [int]$Count = 1,
  [int]$IntervalMs = 500,
  [switch]$KeepAlive,
  [string]$TriggerPath = '',
  [int]$CdpPort = 9222,
  [switch]$SkipBuild,
  [switch]$AllowStub,
  [switch]$NoMinimize,
  [ValidateSet('minimize','offscreen')][string]$HideMode = 'minimize',
  [string]$PcRoi = '',
  [double]$PcThreshold = 1.0,
  [switch]$NoFreshnessCheck,
  [long]$Hwnd = 0,
  [string]$ProtectHwnd = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here '..\..')).Path
Set-Location $root

if ($A03Only) { $FullRun = $true }

# GrabFrame is an independent entry (for group E). It never implies FullRun.
# Static self-check when: -SelfCheck, or -GrabFrame without -Out/-KeepAlive, or default (no FullRun/GrabFrame).
$grabLive = $false
if ($GrabFrame) {
  if ($KeepAlive -or ($Out -and $Out.Trim().Length -gt 0)) {
    if ($SelfCheck) {
      Write-Host 'NOTE: -SelfCheck with -KeepAlive/-Out -> static GrabFrame self-check only (no live capture).'
      $grabLive = $false
    } else {
      $grabLive = $true
    }
  } else {
    $SelfCheck = $true
  }
}
if (-not $FullRun -and -not $grabLive) { $SelfCheck = $true }

Write-Host "desk-r1-A acceptance r2 | root=$root"
if ($grabLive -and $KeepAlive) { Write-Host 'mode: GRABFRAME-KEEPALIVE (launches Electron once; trigger-file grabs)' }
elseif ($grabLive) { Write-Host 'mode: GRABFRAME (launches Electron; CDP stream grab -> PNG+JSON)' }
elseif ($GrabFrame -and $SelfCheck) { Write-Host 'mode: GRABFRAME-SELF-CHECK (no windows, no Electron)' }
elseif ($A03Only) { Write-Host 'mode: A-03-ONLY (launches Electron; skips A-01/A-02)' }
elseif ($FullRun) { Write-Host 'mode: FULL (launches Electron; stream-frame verdicts)' }
else { Write-Host 'mode: SELF-CHECK (no windows, no Electron)' }

if ($SelfCheck -and -not $grabLive) {
  if ($GrabFrame) {
    node (Join-Path $here 'grab-frame.mjs') --self-check --cdp-port=$CdpPort
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host ''
    Write-Host 'GrabFrame self-check OK (no Electron / no windows).'
    Write-Host 'Live: .\run-acceptance.ps1 -GrabFrame -Out <path.png> [-Count N -IntervalMs M]'
    Write-Host 'Keep-alive: .\run-acceptance.ps1 -GrabFrame -KeepAlive -Out <path.png>'
    exit 0
  }
  node (Join-Path $here 'cdp-client.mjs') --self-check
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  if (Test-Path (Join-Path $here 'grab-frame.mjs')) {
    node (Join-Path $here 'grab-frame.mjs') --self-check --cdp-port=$CdpPort
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  Write-Host ''
  Write-Host 'Self-check OK. Estimated full run: 5-8 minutes (incl. npm run build ~1-2 min).'
  Write-Host 'Do NOT run -FullRun until supervisor says kaipao (go).'
  Write-Host 'Stub policy: default NO DESK_R1_STUB_FULLSCREEN; real setFullScreen via _testSetFullscreen.'
  Write-Host 'GrabFrame: .\run-acceptance.ps1 -GrabFrame -SelfCheck  (static) or -Out <png> (live).'
  exit 0
}

# ---------------- GrabFrame live (group E entry; not FullRun) ----------------
if ($grabLive) {
  # Reuse accepted capture chain: no stub, process-local proxy clear, 9222 preflight,
  # CDP stream grabFrame -> full-res PNG + JSON sidecar. Content protection ON; minimize for occlusion.
  Remove-Item Env:DESK_R1_STUB_FULLSCREEN -ErrorAction SilentlyContinue
  Write-Host 'stub: OFF (GrabFrame uses real _testSetFullscreen gate)'
  $env:DESK_R1_A_TEST_HOOK = '1'
  $env:DESK_R1_CDP_PORT = "$CdpPort"

  foreach ($k in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NO_PROXY','no_proxy')) {
    Remove-Item "Env:$k" -ErrorAction SilentlyContinue
  }
  Write-Host 'proxy: cleared HTTP(S)/ALL_PROXY in process env only'

  function Test-DeskR1PortInUse([int]$Port) {
    try {
      $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
      if ($listeners) { return $true }
    } catch { }
    try {
      $lines = netstat -ano | Select-String -Pattern (":$Port\s+")
      foreach ($ln in $lines) {
        if ($ln.Line -match 'LISTENING') { return $true }
      }
    } catch { }
    return $false
  }
  if (Test-DeskR1PortInUse $CdpPort) {
    Write-Host "PREFLIGHT FAIL: port $CdpPort already in use. Kill the zombie listener before GrabFrame."
    throw "PREFLIGHT FAIL: CDP port $CdpPort already in use - refusing to proceed"
  }
  Write-Host "preflight: port $CdpPort is free"

  $outDir = Join-Path $root 'out\acceptance'
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $cleanupLog = Join-Path $outDir 'grabframe-cleanup-log.txt'
  $script:DeskR1RunId = Get-Date -Format 'yyyyMMdd-HHmmss'
  $electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $electronExe)) { throw "electron.exe not found: $electronExe" }

  if (-not $Out -or -not $Out.Trim()) {
    $Out = Join-Path $outDir 'grab-frame.png'
  }
  if (-not [System.IO.Path]::IsPathRooted($Out)) {
    $Out = Join-Path $root $Out
  }
  $trigger = $TriggerPath
  if (-not $trigger -or -not $trigger.Trim()) {
    $trigger = Join-Path $outDir 'grab-trigger'
  }
  if (-not [System.IO.Path]::IsPathRooted($trigger)) {
    $trigger = Join-Path $root $trigger
  }

  $app = $null
  $electronPid = $null
  $cleanupNotes = New-Object System.Collections.Generic.List[string]
  try {
    if (-not $SkipBuild) {
      Write-Host 'npm run build ...'
      cmd /c "npm.cmd run build"
      if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
    }

    # v7 PREFLIGHT (exit 5): the built main bundle must register every IPC handler GrabFrame's prepare calls.
    # desk-r1-A-capture alone lacks B's desktopPanel.source.enumerate; build from the merge stack (e.g. 7134bcb)
    # with the A scripts overlaid, then run with -SkipBuild.
    $mainJs = Join-Path $root 'out\main\index.js'
    $gfRequiredHandlers = [ordered]@{
      'desktopPanel.source.enumerate (B)' = 'handle\(\s*[\w$.]*sourceEnumerate\b'
      'capture.start (A)'                 = 'handle\(\s*[\w$.]*CAPTURE_IPC\.start\b'
      'capture.getStatus (A)'             = 'handle\(\s*[\w$.]*CAPTURE_IPC\.getStatus\b'
      'test bootstrap (A)'                = 'handle\(\s*DESK_R1_A_TEST_BOOTSTRAP\b'
      'test fullscreen (A)'               = 'handle\(\s*DESK_R1_A_TEST_SET_FULLSCREEN\b'
      'test content protection (A)'       = 'handle\(\s*DESK_R1_A_TEST_SET_CONTENT_PROTECTION\b'
    }
    if (-not (Test-Path -LiteralPath $mainJs)) {
      Write-Host "PREFLIGHT FAIL (exit 5): $mainJs missing (build first or drop -SkipBuild)"
      exit 5
    }
    $mainJsText = Get-Content -LiteralPath $mainJs -Raw
    $gfMissing = @($gfRequiredHandlers.Keys | Where-Object { $mainJsText -notmatch $gfRequiredHandlers[$_] })
    if ($gfMissing.Count -gt 0) {
      Write-Host ("PREFLIGHT FAIL (exit 5): out\main\index.js lacks IPC handler(s): " + ($gfMissing -join ', '))
      Write-Host 'This tree cannot run GrabFrame (desk-r1-A-capture has no B source.enumerate). Build from the merge stack (e.g. 7134bcb) with A scripts overlaid, then use -SkipBuild.'
      exit 5
    }
    $cleanupNotes.Add('preflight: all 6 GrabFrame IPC handlers present in out\main\index.js')
    Write-Host 'PREFLIGHT OK: all 6 GrabFrame IPC handlers present'

    # E-04: process-level equivalent of backgroundThrottling:false (no product change) so a minimized/occluded
    # renderer keeps running timers and the capture pipeline.
    $gfElectronArgs = @('.', "--remote-debugging-port=$CdpPort", "--remote-allow-origins=*",
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows')
    $app = Start-Process -FilePath $electronExe -ArgumentList $gfElectronArgs -PassThru -WorkingDirectory $root
    $electronPid = $app.Id
    Write-Host "GrabFrame Electron pid=$electronPid; waiting for CDP on $CdpPort ..."
    $cleanupNotes.Add("recorded electronPid=$electronPid")
    $cleanupNotes.Add("runId=$($script:DeskR1RunId)")
    @(
      "=== desk-r1-A GrabFrame launch ===",
      "runId=$($script:DeskR1RunId)",
      "electronPid=$electronPid",
      "cdpPort=$CdpPort",
      "out=$Out",
      "keepAlive=$KeepAlive",
      "launchAt=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
    ) | Set-Content -Path (Join-Path $outDir 'grabframe-launch-record.txt') -Encoding ascii

    $ready = $false
    for ($i = 0; $i -lt 90; $i++) {
      try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/list" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200 -and $r.Content -match 'webSocketDebuggerUrl') { $ready = $true; break }
      } catch { }
      Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "CDP not ready on $CdpPort" }
    Start-Sleep -Seconds 3

    $gfArgs = @((Join-Path $here 'grab-frame.mjs'), "--out=$Out", "--cdp-port=$CdpPort", "--pid=$electronPid")
    if ($Count -gt 1) { $gfArgs += "--count=$Count"; $gfArgs += "--interval-ms=$IntervalMs" }
    elseif ($IntervalMs -ne 500 -and -not $KeepAlive) { $gfArgs += "--interval-ms=$IntervalMs" }
    if ($NoMinimize) { $gfArgs += '--no-minimize' }
    $gfArgs += "--hide-mode=$HideMode"
    if ($PcRoi -and $PcRoi.Trim()) { $gfArgs += "--pc-roi=$PcRoi"; $gfArgs += "--pc-threshold=$PcThreshold" }
    if ($NoFreshnessCheck) {
      $gfArgs += '--no-freshness-check'
      $cleanupNotes.Add('freshnessCheck=disabled-by-flag (-NoFreshnessCheck): frames are NOT verified fresh (sidecar stale=null)')
      Write-Host 'WARNING: freshnessCheck=disabled-by-flag (-NoFreshnessCheck); sidecar stale=null, verdict=unchecked'
    } else {
      $cleanupNotes.Add('freshnessCheck=default (keep-alive / Count>=2: enabled)')
    }
    if ($Hwnd -gt 0) { $gfArgs += "--hwnd=$Hwnd"; $cleanupNotes.Add("ownHwnd(explicit)=$Hwnd") }
    if ($ProtectHwnd -and $ProtectHwnd.Trim()) { $gfArgs += "--protect-hwnd=$($ProtectHwnd.Trim())"; $cleanupNotes.Add("protectHwnd=$ProtectHwnd") }
    if ($KeepAlive) {
      $gfArgs += '--keep-alive'
      $gfArgs += "--trigger=$trigger"
      Write-Host "GrabFrame keep-alive: trigger=$trigger (write 'grab' / 'grab <path>' / 'quit')"
    }

    Write-Host ("node " + ($gfArgs -join ' '))
    node @gfArgs
    $gfExit = $LASTEXITCODE
    $script:gfExit = $gfExit
    # v3: KeepAlive quit exits with the worst frame verdict seen (3 STALE > 4 INCONCLUSIVE > 0); per-frame status is in each sidecar JSON.
    $gfWhat = if ($KeepAlive) { 'KeepAlive (worst frame seen; per-frame verdict in each <png>.json)' } else { 'see <out>.json / <out>.freshness.json' }
    if ($gfExit -eq 3) { $cleanupNotes.Add('STALE: stale frame detected (exit 3)'); $script:gfStale = $true; Write-Host "GrabFrame STALE (exit 3): $gfWhat" }
    elseif ($gfExit -eq 4) { $cleanupNotes.Add('INCONCLUSIVE: freshness unprovable, own window not uniquely identifiable or hide failed (exit 4)'); $script:gfInconclusive = $true; Write-Host "GrabFrame INCONCLUSIVE (exit 4): $gfWhat" }
    elseif ($gfExit -eq 130 -or $gfExit -eq 143 -or $gfExit -eq 149) { $cleanupNotes.Add("INTERRUPTED: grab-frame.mjs signal exit $gfExit (title/track/hwnd restored)"); throw "grab-frame.mjs interrupted by signal (exit $gfExit)" }
    elseif ($gfExit -ne 0) { throw "grab-frame.mjs exited $gfExit" }
    else { Write-Host "GrabFrame OK -> $Out" }
  }
  finally {
    $cleanupNotes.Insert(0, "cleanupAt=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
    $cleanupNotes.Insert(0, "runId=$($script:DeskR1RunId)")
    $cleanupNotes.Insert(0, "=== desk-r1-A GrabFrame cleanup ===")
    if ($electronPid) {
      $still = Get-Process -Id $electronPid -ErrorAction SilentlyContinue
      if ($still) {
        $cleanupNotes.Add("taskkill /PID $electronPid /T /F")
        $tk = cmd /c "taskkill /PID $electronPid /T /F" 2>&1 | Out-String
        $cleanupNotes.Add("taskkill output: $tk")
        Start-Sleep -Milliseconds 500
      } else {
        $cleanupNotes.Add("electron pid $electronPid already gone before taskkill")
      }
      $gone = $false
      for ($vi = 0; $vi -lt 10; $vi++) {
        $verify = Get-Process -Id $electronPid -ErrorAction SilentlyContinue
        if (-not $verify) { $gone = $true; break }
        try {
          Stop-Process -Id $electronPid -Force -ErrorAction SilentlyContinue
          cmd /c "taskkill /PID $electronPid /T /F" 2>&1 | Out-Null
        } catch {}
        Start-Sleep -Milliseconds 400
      }
      if ($gone) { $cleanupNotes.Add("VERIFY OK: pid $electronPid gone") }
      else { $cleanupNotes.Add("VERIFY FAIL: pid $electronPid still present") }
    }
    try {
      $null = Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/version" -UseBasicParsing -TimeoutSec 1
      $cleanupNotes.Add("VERIFY WARN: CDP port $CdpPort still responding")
    } catch {
      $cleanupNotes.Add("VERIFY OK: CDP port $CdpPort closed")
    }
    $cleanupNotes | Out-File -FilePath $cleanupLog -Encoding ascii
    Write-Host "GrabFrame cleanup log -> $cleanupLog"
  }
  if ($script:gfStale) { exit 3 }
  if ($script:gfInconclusive) { exit 4 }
  exit 0
}

# ---------------- Full run (after go) ----------------
# No mouse automation. Stream frames via CDP getUserMedia + canvas. OS screenshots optional reference only.
if ($AllowStub) {
  Write-Host 'WARNING: -AllowStub set. DESK_R1_STUB_FULLSCREEN=1 stubs the fullscreen GATE only (not OS fullscreen).'
  Write-Host 'Reason required by policy: operator explicitly allowed stub for this run.'
  $env:DESK_R1_STUB_FULLSCREEN = '1'
} else {
  # Ensure stub is OFF
  Remove-Item Env:DESK_R1_STUB_FULLSCREEN -ErrorAction SilentlyContinue
  Write-Host 'stub: OFF (using real BrowserWindow.setFullScreen via _testSetFullscreen)'
}

$env:DESK_R1_A_TEST_HOOK = '1'
$env:DESK_R1_CDP_PORT = "$CdpPort"



# Clear proxy env in THIS process only (do not touch User/Machine env) - helps CDP/local fetch
foreach ($k in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NO_PROXY','no_proxy')) {
  Remove-Item "Env:$k" -ErrorAction SilentlyContinue
}
Write-Host 'proxy: cleared HTTP(S)/ALL_PROXY in process env only'
# Preflight: if CDP port already in use, error-exit immediately (do not proceed / do not launch).
function Test-DeskR1PortInUse([int]$Port) {
  try {
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listeners) { return $true }
  } catch { }
  try {
    $lines = netstat -ano | Select-String -Pattern (":$Port\s+")
    foreach ($ln in $lines) {
      if ($ln.Line -match 'LISTENING') { return $true }
    }
  } catch { }
  return $false
}
if (Test-DeskR1PortInUse $CdpPort) {
  Write-Host "PREFLIGHT FAIL: port $CdpPort already in use. Kill the zombie listener before FullRun."
  throw "PREFLIGHT FAIL: CDP port $CdpPort already in use - refusing to proceed"
}
Write-Host "preflight: port $CdpPort is free"


$outDir = Join-Path $root 'out\acceptance'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$cleanupLog = Join-Path $outDir 'cleanup-log.txt'
$consoleLog = Join-Path $outDir 'fullrun-console.txt'
# Fresh console transcript every FullRun (overwrite)
try { Stop-Transcript -ErrorAction SilentlyContinue } catch {}
Start-Transcript -Path $consoleLog -Force | Out-Null
Write-Host "console transcript -> $consoleLog"
$script:DeskR1RunId = Get-Date -Format 'yyyyMMdd-HHmmss'
# Wipe cleanup-log at run start so prior pids cannot masquerade as this run
@(
  "=== desk-r1-A cleanup log ===",
  "runId=$($script:DeskR1RunId)",
  "started=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')",
  "status=RUNNING (rewritten at cleanup)",
  "electronPid=(pending launch)"
) | Set-Content -Path $cleanupLog -Encoding ascii
if ($reportDir) { Copy-Item $cleanupLog $reportDir -Force }
$probeDir = Join-Path $outDir 'explorer-probe'
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
Set-Content -Path (Join-Path $probeDir 'probe.txt') -Value 'desk-r1-A explorer probe' -Encoding ascii

$parent = Split-Path $root -Parent
$reportBase = Get-ChildItem $parent -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'desk-r1-A-public-entry') } | Select-Object -First 1
$reportDir = $null
if ($reportBase) {
  $reportDir = Join-Path $reportBase.FullName 'desk-r1-A-acceptance'
  New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
}

function Copy-Out([string]$name) {
  if ($reportDir -and (Test-Path (Join-Path $outDir $name))) {
    Copy-Item (Join-Path $outDir $name) (Join-Path $reportDir $name) -Force
  }
}

function Save-OsRef([string]$name) {
  # Reference only - not used for PASS/FAIL
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
    $path = Join-Path $outDir $name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "os-ref (not verdict) -> $path"
    Copy-Out $name
  } catch {
    Write-Host "os-ref skipped: $($_.Exception.Message)"
  }
}


function Test-OsRefMarker([string]$pngPath) {
  # Sample OS reference PNG for marker color #E911E9 (tol=8). Used as A-03 gate only.
  $result = [ordered]@{ path = $pngPath; step = 4; hits = 0; samples = 0; ratio = 0.0; hasMarker = $false; error = $null }
  if (-not (Test-Path $pngPath)) {
    $result.error = 'missing'
    return [pscustomobject]$result
  }
  try {
    Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
    $bmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path $pngPath))
    $step = 4
    $hits = 0
    $samples = 0
    for ($y = 0; $y -lt $bmp.Height; $y += $step) {
      for ($x = 0; $x -lt $bmp.Width; $x += $step) {
        $c = $bmp.GetPixel($x, $y)
        if ([Math]::Abs([int]$c.R - 233) -le 8 -and [Math]::Abs([int]$c.G - 17) -le 8 -and [Math]::Abs([int]$c.B - 233) -le 8) {
          $hits++
        }
        $samples++
      }
    }
    $bmp.Dispose()
    $ratio = 0.0
    if ($samples -gt 0) { $ratio = [double]$hits / [double]$samples }
    # Require a non-trivial number of marker-colored samples (checker may be sparse).
    $result.hits = $hits
    $result.samples = $samples
    $result.ratio = $ratio
    $result.hasMarker = ($hits -ge 30 -or $ratio -ge 0.0005)
  } catch {
    $result.error = $_.Exception.Message
  }
  return [pscustomobject]$result
}

function Get-ExplorerLocations {
  $list = @()
  try {
    $sh = New-Object -ComObject Shell.Application
    foreach ($w in @($sh.Windows())) {
      try {
        $list += [pscustomobject]@{ HWND = [int64]$w.HWND; Path = [string]$w.Document.Folder.Self.Path; LocationURL = [string]$w.LocationURL }
      } catch { }
    }
  } catch { }
  return $list
}

$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electronExe)) { throw "electron.exe not found: $electronExe" }

$app = $null
$electronPid = $null
$openedExplorerPath = $null
$explorerBefore = @(Get-ExplorerLocations)
$cleanupNotes = New-Object System.Collections.Generic.List[string]
$script:A03Exit = $null

try {
  if (-not $SkipBuild) {
    Write-Host 'npm run build ...'
    # Use cmd so npm stderr does not become a PowerShell NativeCommandError under ErrorAction Stop.
    cmd /c "npm.cmd run build"
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
  }

  $app = Start-Process -FilePath $electronExe -ArgumentList @('.', "--remote-debugging-port=$CdpPort", "--remote-allow-origins=*") -PassThru -WorkingDirectory $root
  $electronPid = $app.Id
  Write-Host "Electron pid=$electronPid; waiting for CDP on $CdpPort ..."
  $cleanupNotes.Add("recorded electronPid=$electronPid")
  $cleanupNotes.Add("runId=$($script:DeskR1RunId)")
  $cleanupNotes.Add("launchAt=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
  @(
    "=== desk-r1-A launch record ===",
    "runId=$($script:DeskR1RunId)",
    "electronPid=$electronPid",
    "cdpPort=$CdpPort",
    "launchAt=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
  ) | Set-Content -Path (Join-Path $outDir 'launch-record.txt') -Encoding ascii

  $ready = $false
  for ($i = 0; $i -lt 90; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/list" -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200 -and $r.Content -match 'webSocketDebuggerUrl') { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw "CDP not ready on $CdpPort" }
  Start-Sleep -Seconds 3

  if (-not $A03Only) {
  # A-01 stream frames
  node (Join-Path $here 'cdp-client.mjs') --full --phase=a01
  if ($LASTEXITCODE -ne 0) { throw 'A-01 stream phase failed' }
  Copy-Out 'A-01-stream.png'; Copy-Out 'A-01-verdict.json'; Copy-Out 'cdp-result.json'
  Save-OsRef 'A-01-os-ref.png'

  # A-02 before/after stream + explorer probe folder
  node (Join-Path $here 'cdp-client.mjs') --full --phase=a02-before
  if ($LASTEXITCODE -ne 0) { throw 'A-02 before failed' }
  Copy-Out 'A-02-before-stream.png'

  Start-Process explorer.exe -ArgumentList $probeDir
  $openedExplorerPath = $probeDir
  $cleanupNotes.Add("opened explorer path=$probeDir")
  Start-Sleep -Seconds 4

  node (Join-Path $here 'cdp-client.mjs') --full --phase=a02-after
  if ($LASTEXITCODE -ne 0) { throw 'A-02 after/diff failed' }
  Copy-Out 'A-02-after-stream.png'; Copy-Out 'A-02-verdict.json'

  } else {
    Write-Host 'A03Only: skipping A-01 and A-02 phases'
  }
  # ---- A-03 v2: positive control (protection OFF) + Win32 visibility (protection ON) ----
  # Phase 1: content protection OFF. OS-ref (GDI CopyFromScreen) AND stream frame must both contain #E911E9;
  #          if either side lacks the marker the pipeline is broken -> INCONCLUSIVE (never PASS).
  # Phase 2: content protection ON. NO screenshot as visibility proof. Win32 only: IsWindowVisible, !IsIconic,
  #          GetWindowRect on primary monitor, WindowFromPoint(center)->GA_ROOT == our hwnd. Then stream:
  #          markerHits==0 -> PASS; marker -> FAIL; any Win32 check fails -> INCONCLUSIVE.
  # A-03-verdict.json is computed offline from the raw JSON files; A-03-verdict.txt is rendered from that JSON only.
  $a03Files = @('A-03-p1-arm.json','A-03-p1-os.json','A-03-p1-os-ref.png','A-03-p1-win32.json','A-03-p1-stream.json','A-03-p1-stream.png','A-03-p2-arm.json','A-03-p2-win32.json','A-03-p2-stream.json','A-03-p2-stream.png','A-03-verdict.json','A-03-verdict.txt')
  foreach ($stale in ($a03Files + @('A-03-arm.json','A-03-os-gate.json','A-03-os-ref.png','A-03-stream.png'))) {
    Remove-Item (Join-Path $outDir $stale) -ErrorAction SilentlyContinue
  }
  $win32Helper = Join-Path $here 'win32-window-check.ps1'

  # Phase 1 (positive control)
  node (Join-Path $here 'cdp-client.mjs') --full --phase=a03-p1-arm
  if ($LASTEXITCODE -ne 0) { throw 'A-03 p1 arm (marker + content protection OFF) failed' }
  $p1Arm = Get-Content (Join-Path $outDir 'A-03-p1-arm.json') -Raw -Encoding utf8 | ConvertFrom-Json
  Save-OsRef 'A-03-p1-os-ref.png'
  $p1Os = Test-OsRefMarker (Join-Path $outDir 'A-03-p1-os-ref.png')
  ($p1Os | ConvertTo-Json -Depth 5) | Set-Content -Path (Join-Path $outDir 'A-03-p1-os.json') -Encoding utf8
  Write-Host ("A-03 p1 OS-ref: hits={0} samples={1} ratio={2} hasMarker={3} err={4}" -f $p1Os.hits, $p1Os.samples, $p1Os.ratio, $p1Os.hasMarker, $p1Os.error)
  & $win32Helper -Hwnd ([string]$p1Arm.contentProtection.hwnd) -OutJson (Join-Path $outDir 'A-03-p1-win32.json') -ExpectPid $electronPid
  node (Join-Path $here 'cdp-client.mjs') --full --phase=a03-p1-stream
  if ($LASTEXITCODE -ne 0) { throw 'A-03 p1 stream failed' }

  # Phase 2 (content protection ON; Win32 visibility)
  node (Join-Path $here 'cdp-client.mjs') --full --phase=a03-p2-arm
  if ($LASTEXITCODE -ne 0) { throw 'A-03 p2 arm (marker + content protection ON) failed' }
  $p2Arm = Get-Content (Join-Path $outDir 'A-03-p2-arm.json') -Raw -Encoding utf8 | ConvertFrom-Json
  & $win32Helper -Hwnd ([string]$p2Arm.contentProtection.hwnd) -OutJson (Join-Path $outDir 'A-03-p2-win32.json') -ExpectPid $electronPid
  node (Join-Path $here 'cdp-client.mjs') --full --phase=a03-p2-stream
  if ($LASTEXITCODE -ne 0) { throw 'A-03 p2 stream failed' }

  # Verdict: offline, JSON only (exit 0=PASS 1=FAIL 2=INCONCLUSIVE)
  node (Join-Path $here 'cdp-client.mjs') --full --phase=a03-verdict
  $script:A03Exit = $LASTEXITCODE
  foreach ($n in $a03Files) { Copy-Out $n }
  Write-Host "A-03 verdict exit=$($script:A03Exit) (0=PASS 1=FAIL 2=INCONCLUSIVE)"
  Write-Host "Full run artifacts under $outDir"
}
finally {
  # Always write a FRESH cleanup-log for THIS run (overwrite), with runId/timestamp first.
  $cleanupNotes.Insert(0, "cleanupAt=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
  $cleanupNotes.Insert(0, "runId=$($script:DeskR1RunId)")
  $cleanupNotes.Insert(0, "=== desk-r1-A cleanup log ===")

  # Close explorer window we opened (by Location path), never kill explorer.exe shell
  if ($openedExplorerPath) {
    try {
      $sh = New-Object -ComObject Shell.Application
      foreach ($w in @($sh.Windows())) {
        try {
          if ([string]$w.Document.Folder.Self.Path -eq $openedExplorerPath) {
            $cleanupNotes.Add("Quit explorer HWND=$($w.HWND) path=$openedExplorerPath")
            $w.Quit()
          }
        } catch { $cleanupNotes.Add("explorer Quit error: $($_.Exception.Message)") }
      }
    } catch { $cleanupNotes.Add("Shell.Application error: $($_.Exception.Message)") }
  }

  if ($electronPid) {
    $still = Get-Process -Id $electronPid -ErrorAction SilentlyContinue
    if ($still) {
      $cleanupNotes.Add("taskkill /PID $electronPid /T /F")
      $tk = cmd /c "taskkill /PID $electronPid /T /F" 2>&1 | Out-String
      $cleanupNotes.Add("taskkill output: $tk")
      # Electron tree can linger briefly after taskkill SUCCESS; poll instead of single 1s check.
      Start-Sleep -Milliseconds 500
    } else {
      $cleanupNotes.Add("electron pid $electronPid already gone before taskkill")
    }
    $gone = $false
    for ($vi = 0; $vi -lt 10; $vi++) {
      $verify = Get-Process -Id $electronPid -ErrorAction SilentlyContinue
      if (-not $verify) { $gone = $true; break }
      try {
        Stop-Process -Id $electronPid -Force -ErrorAction SilentlyContinue
        cmd /c "taskkill /PID $electronPid /T /F" 2>&1 | Out-Null
      } catch {}
      Start-Sleep -Milliseconds 400
    }
    if (-not $gone) {
      $cleanupNotes.Add("VERIFY FAIL: pid $electronPid still present after retries")
      try { Stop-Process -Id $electronPid -Force -ErrorAction Stop; $cleanupNotes.Add('Stop-Process forced (final)') } catch { $cleanupNotes.Add("Stop-Process error: $($_.Exception.Message)") }
      Start-Sleep -Milliseconds 800
      $verify2 = Get-Process -Id $electronPid -ErrorAction SilentlyContinue
      if ($verify2) { $cleanupNotes.Add("VERIFY STILL FAIL: pid $electronPid alive (may be Access Denied / ghost)") }
      else { $cleanupNotes.Add("VERIFY OK after final Stop-Process: pid $electronPid gone") }
    } else {
      $cleanupNotes.Add("VERIFY OK: pid $electronPid gone")
    }
  }

  try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/version" -UseBasicParsing -TimeoutSec 1
    $cleanupNotes.Add("VERIFY WARN: CDP port $CdpPort still responding")
  } catch {
    $cleanupNotes.Add("VERIFY OK: CDP port $CdpPort closed")
  }

  $cleanupNotes | Out-File -FilePath $cleanupLog -Encoding ascii
  if ($reportDir) {
    Copy-Item $cleanupLog $reportDir -Force
    if ($consoleLog -and (Test-Path $consoleLog)) { Copy-Item $consoleLog (Join-Path $reportDir 'fullrun-console.txt') -Force }
    if (Test-Path (Join-Path $outDir 'launch-record.txt')) { Copy-Item (Join-Path $outDir 'launch-record.txt') $reportDir -Force }
  }
  Write-Host "cleanup log -> $cleanupLog"
  try { Stop-Transcript | Out-Null } catch {}
}
# A-03 verdict exit code (0=PASS 1=FAIL 2=INCONCLUSIVE); a thrown error exits 1 before this line.
if ($null -ne $script:A03Exit) { exit $script:A03Exit }
