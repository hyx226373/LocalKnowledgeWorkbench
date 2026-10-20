# startup-ready-race cold-start harness. Isolated KB_USER_DATA per run; no UI automation (never clicks/focuses);
# judges only from startup-trace.json marks + blank-window-diag.json + process logs.
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$Exe = "",
  [string]$OutDir,
  [int]$Runs = 10,
  [int]$DelayMs = 0,
  [int]$WaitSec = 45,
  [string]$App = "",
  [switch]$KeepUserData,
  [string]$SharedUserData = "",
  [string]$SeedUserData = ""
)
$ErrorActionPreference = "Continue"
if (-not $Exe) { $Exe = Join-Path $Root "node_modules\electron\dist\electron.exe"; $appArgs = @("`"$Root`"") } else { $appArgs = @() }
if ($App) { $appArgs = @("`"$App`"") }
if (-not (Test-Path $Exe)) { throw "exe not found: $Exe" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$rows = @()
for ($i = 1; $i -le $Runs; $i++) {
  $ud = Join-Path $OutDir ("userdata-{0:d2}" -f $i)
  if ($SharedUserData) { $ud = $SharedUserData } elseif (Test-Path $ud) { Remove-Item -Recurse -Force $ud }
  New-Item -ItemType Directory -Force -Path $ud | Out-Null
  if ($SeedUserData) { Copy-Item -Recurse -Force (Join-Path $SeedUserData "*") $ud }
  Remove-Item -Force (Join-Path $ud "startup-trace.json"),(Join-Path $ud "blank-window-diag.json") -ErrorAction SilentlyContinue
  $env:KB_STALL_LOG = Join-Path $OutDir ("stall-{0:d2}.log" -f $i)
  $env:KB_USER_DATA = $ud; $env:KB_STARTUP_TRACE = "1"; $env:KB_TEST_PLANE_READY_DELAY_MS = "$DelayMs"
  $log = Join-Path $OutDir ("run-{0:d2}.log" -f $i)
  $t0 = Get-Date
  $sp = @{ FilePath = $Exe; PassThru = $true }; if ($appArgs.Count) { $sp.ArgumentList = $appArgs }
  $p = Start-Process @sp -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $trace = Join-Path $ud "startup-trace.json"; $diag = Join-Path $ud "blank-window-diag.json"
  $verdict = "TIMEOUT-NO-TRACE"; $names = @()
  while (((Get-Date) - $t0).TotalSeconds -lt $WaitSec) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $diag) { $verdict = "FAIL-BLANK-DIAG"; break }
    if (Test-Path $trace) {
      try { $raw = Get-Content -Raw $trace; if (Test-Path $env:KB_STALL_LOG) { $raw += "`n" + ((Get-Content $env:KB_STALL_LOG | Select-String " mark \d+ renderer (\S+)" | ForEach-Object { "`"name`":`"" + $_.Matches[0].Groups[1].Value + "`"" }) -join "`n") } } catch { continue }  # trace is finalized at visible-content-loaded; later renderer marks only reach the stall log
      $has = { param($n) $raw -match [regex]::Escape($n) }
      if (& $has 'renderer:visible-content-timeout') { $verdict = "FAIL-VISIBLE-TIMEOUT"; break }
      if ($SeedUserData -and (& $has 'renderer:image-error')) { $verdict = "FAIL-IMAGE-ERROR"; break }
      $imgOk = (-not $SeedUserData) -or (& $has 'renderer:image-loaded') -or (& $has 'renderer:image-retry-loaded')
      if ((& $has 'renderer:sidebar-ready') -and (& $has 'renderer:visible-content-loaded') -and $imgOk) { $verdict = "PASS"; break }
    }
  }
  Start-Sleep -Seconds 1
  if (Test-Path $diag) { $verdict = "FAIL-BLANK-DIAG" }
  & taskkill /T /F /PID $p.Id *> $null
  $exePath = (Resolve-Path $Exe).Path; for ($w = 0; $w -lt 30; $w++) { $left = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exePath }); if (-not $left.Count) { break }; $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500 }
  Start-Sleep -Seconds 2
  if (Test-Path $trace) { Copy-Item $trace (Join-Path $OutDir ("startup-trace-{0:d2}.json" -f $i)) }
  if (Test-Path $diag) { Copy-Item $diag (Join-Path $OutDir ("blank-window-diag-{0:d2}.json" -f $i)) }
  $tr = if (Test-Path $trace) { Get-Content -Raw $trace } else { "" }; if (Test-Path $env:KB_STALL_LOG) { $tr += (Get-Content $env:KB_STALL_LOG | Select-String " mark \d+ (\w+) (\S+)" | ForEach-Object { "`n`"" + $_.Matches[0].Groups[2].Value + "`"" }) -join "" }
  $row = [ordered]@{ run = $i; verdict = $verdict; imageRetry = ([regex]::Matches($tr, "renderer:image-retry`"")).Count; imageRetryLoaded = $tr.Contains("renderer:image-retry-loaded"); imageLoaded = $tr.Contains("renderer:image-loaded"); imageError = $tr.Contains("renderer:image-error"); protocolRegistered = $tr.Contains("main:protocol-registered"); secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1); delayMs = $DelayMs; userData = $ud }
  $rows += [pscustomobject]$row
  Write-Host ("run {0:d2}: {1} ({2}s)" -f $i, $verdict, $row.secs)
}
$rows | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $OutDir "summary.json")
$pass = ($rows | Where-Object verdict -eq "PASS").Count
Write-Host "PASS $pass / $Runs"
