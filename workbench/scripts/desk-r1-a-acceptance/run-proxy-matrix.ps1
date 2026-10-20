param(
  [int]$CdpPort = 9222,
  [string]$Worktree = ""
)
$ErrorActionPreference = "Continue"
if (-not $Worktree) { $Worktree = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
if (-not (Test-Path (Join-Path $Worktree "package.json"))) {
  $Worktree = "D:\STUDY MATERIAL\项目\知识库\kb-wt-desk-r1-A"
}
Set-Location $Worktree
$electron = Join-Path $Worktree "node_modules\electron\dist\electron.exe"
$probe = Join-Path $Worktree "scripts\desk-r1-a-acceptance\cdp-probe.mjs"
$outDir = Join-Path $Worktree "out\acceptance\cdp-probe"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$log = Join-Path $outDir "proxy-matrix-$stamp.log"
$reportJson = Join-Path $outDir "proxy-matrix-$stamp.json"

function FreeMB { [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024,0) }
function Log($m) { $line = "[$(Get-Date -Format 'HH:mm:ss')] $m"; Write-Host $line; Add-Content -Path $log -Value $line -Encoding UTF8 }

if (-not (Test-Path $electron)) { throw "electron missing: $electron" }
if (-not (Test-Path $probe)) { throw "probe missing: $probe" }

# Ensure 9222 free
$busy = netstat -ano | findstr ":$CdpPort "
if ($busy) { Log "WARN port $CdpPort busy:`n$busy"; throw "port $CdpPort not free" }

$matrix = [ordered]@{}
$ramLaunchBefore = FreeMB
Log "RAM_BEFORE_LAUNCH_MB=$ramLaunchBefore"
Log "Launching Electron: $electron --remote-debugging-port=$CdpPort --remote-allow-origins=*"

$proc = Start-Process -FilePath $electron -ArgumentList @(".", "--remote-debugging-port=$CdpPort", "--remote-allow-origins=*") -PassThru -WorkingDirectory $Worktree
$electronPid = $proc.Id
Log "electronPid=$electronPid"
Start-Sleep -Seconds 2
# track child processes for WS
$ourPids = @($electronPid)

try {
  $ready = $false
  $jsonList = $null
  for ($i=0; $i -lt 45; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/list" -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200 -and $r.Content -match "webSocketDebuggerUrl") {
        $jsonList = $r.Content
        $ready = $true
        break
      }
    } catch {}
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw "CDP not ready on $CdpPort" }
  Start-Sleep -Seconds 2

  # Also version
  $jsonVersion = $null
  try { $jsonVersion = (Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/version" -UseBasicParsing -TimeoutSec 3).Content } catch {}

  $listPath = Join-Path $outDir "json-list-$stamp.json"
  $verPath = Join-Path $outDir "json-version-$stamp.json"
  Set-Content -Path $listPath -Value $jsonList -Encoding UTF8
  if ($jsonVersion) { Set-Content -Path $verPath -Value $jsonVersion -Encoding UTF8 }

  Log "=== /json/list FULL ==="
  Log $jsonList
  Log "=== /json/version ==="
  Log $jsonVersion

  # Parse WS URLs for hostname analysis
  $wsUrls = [regex]::Matches($jsonList, 'ws://[^\s"]+') | ForEach-Object { $_.Value }
  Log "WS_URLS_FOUND=$($wsUrls -join ' | ')"
  foreach ($u in $wsUrls) {
    if ($u -match 'ws://([^/:]+)') {
      $hostPart = $Matches[1]
      $inNoProxy = ($hostPart -eq '127.0.0.1' -or $hostPart -eq 'localhost' -or $hostPart -eq '[::1]' -or $hostPart -eq '::1')
      Log "WS_HOST=$hostPart inNO_PROXY_literals=$inNoProxy full=$u"
    }
  }

  # Electron WorkingSet
  $ep = Get-Process -Id $electronPid -ErrorAction SilentlyContinue
  $wsMB = if ($ep) { [math]::Round($ep.WorkingSet64/1MB,0) } else { -1 }
  # include children
  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $electronPid }
  foreach ($c in $children) { $ourPids += $c.ProcessId }
  $totalWS = 0
  foreach ($pidX in ($ourPids | Select-Object -Unique)) {
    $p = Get-Process -Id $pidX -ErrorAction SilentlyContinue
    if ($p) { $totalWS += $p.WorkingSet64 }
  }
  $totalWS_MB = [math]::Round($totalWS/1MB,0)
  Log "ELECTRON_MAIN_WS_MB=$wsMB TOTAL_TREE_WS_MB=$totalWS_MB PIDS=$($ourPids -join ',')"

  function RunProbe($label, $backend, $clearProxy) {
    $ramB = FreeMB
    Log "--- MATRIX $label backend=$backend clearProxy=$clearProxy RAM_BEFORE=$ramB ---"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "node"
    $psi.Arguments = "`"$probe`" --port $CdpPort --backend $backend --out `"$outDir`""
    $psi.WorkingDirectory = $Worktree
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    # inherit env then optionally clear proxy
    # ProcessStartInfo.EnvironmentVariables is case-insensitive on Windows
    $proxyKeys = @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')
    if ($clearProxy) {
      foreach ($k in $proxyKeys) {
        if ($psi.EnvironmentVariables.ContainsKey($k)) { $psi.EnvironmentVariables.Remove($k) }
      }
      # also set empty as belt-and-suspenders for some libs
      foreach ($k in $proxyKeys) { $psi.EnvironmentVariables[$k] = "" }
      Log "proxy CLEARED in child process only"
    } else {
      Log "proxy INHERITED: HTTP_PROXY=$($env:HTTP_PROXY)"
    }
    # keep NO_PROXY
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    $null = $p.Start()
    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()
    $p.WaitForExit(60000) | Out-Null
    $code = $p.ExitCode
    $ramA = FreeMB
    Log "STDOUT:`n$stdout"
    Log "STDERR:`n$stderr"
    Log "EXIT=$code RAM_AFTER=$ramA"
    return [pscustomobject]@{
      label = $label
      backend = $backend
      clearProxy = $clearProxy
      exitCode = $code
      ok = ($code -eq 0)
      stdout = $stdout
      stderr = $stderr
      ramBeforeMB = $ramB
      ramAfterMB = $ramA
    }
  }

  # A) undici with proxy
  $matrix['A_undici_proxy'] = RunProbe 'A' 'undici' $false
  # B) undici proxy cleared
  $matrix['B_undici_noproxy'] = RunProbe 'B' 'undici' $true
  # C) ws proxy cleared
  $matrix['C_ws_noproxy'] = RunProbe 'C' 'ws' $true
  # D) ws with proxy (optional)
  $matrix['D_ws_proxy'] = RunProbe 'D' 'ws' $false

} finally {
  Log "Cleanup OUR pids: $($ourPids -join ',')"
  foreach ($pidX in ($ourPids | Select-Object -Unique)) {
    try { Stop-Process -Id $pidX -Force -ErrorAction SilentlyContinue } catch {}
    try { taskkill /PID $pidX /T /F 2>$null | Out-Null } catch {}
  }
  Start-Sleep -Seconds 2
  $left = netstat -ano | findstr ":$CdpPort "
  Log "PORT_AFTER_CLEANUP: $(if ($left) { $left } else { 'FREE' })"
  $ramEnd = FreeMB
  Log "RAM_END_MB=$ramEnd"
}

# Write JSON summary
$summary = [ordered]@{
  stamp = $stamp
  electronPid = $electronPid
  ramLaunchBeforeMB = $ramLaunchBefore
  wsUrls = @($wsUrls)
  matrix = $matrix
}
($summary | ConvertTo-Json -Depth 8) | Set-Content -Path $reportJson -Encoding UTF8
Log "WROTE $reportJson"
Log "DONE"
# Print concise result table
Write-Host "`n=== MATRIX RESULTS ==="
foreach ($k in $matrix.Keys) {
  $m = $matrix[$k]
  Write-Host "$k ok=$($m.ok) exit=$($m.exitCode)"
}
