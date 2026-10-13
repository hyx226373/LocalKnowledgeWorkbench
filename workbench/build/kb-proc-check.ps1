# ASCII only. Bounded process check for the NSIS installer.
# Exit 10: LocalKnowledgeWorkbench is running under KB_PROC_INSTDIR.
# Exit 11: not running there.
# Exit 2: the probe did not finish inside 4 seconds. Caller treats that as not running.
$ErrorActionPreference = 'Stop'
$script:Sw = [Diagnostics.Stopwatch]::StartNew()
$BudgetMs = 4000
$stamp = $env:KB_PROC_STAMP
$mode = $env:KB_PROC_MODE
if ([string]::IsNullOrWhiteSpace($mode)) { $mode = 'check' }

function Write-Stamp([string]$line) {
  if ([string]::IsNullOrWhiteSpace($script:stamp)) { return }
  $dir = Split-Path -Parent $script:stamp
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  Add-Content -LiteralPath $script:stamp -Value $line -Encoding Ascii
}

function LeftMs {
  $left = $BudgetMs - [int]$script:Sw.ElapsedMilliseconds
  if ($left -lt 1) { return 0 }
  return $left
}

function Finish([int]$code) {
  Write-Stamp ("end " + [DateTime]::UtcNow.ToString('o') + " exit " + $code)
  exit $code
}

Write-Stamp ("start " + [DateTime]::UtcNow.ToString('o') + " mode " + $mode)

try {
  $inst = $env:KB_PROC_INSTDIR
  if ([string]::IsNullOrWhiteSpace($inst)) { Finish 11 }
  $inst = $inst.TrimEnd('\')

  $innerPath = Join-Path $env:TEMP ("kb-proc-inner-" + $PID + ".ps1")
  @'
$ErrorActionPreference = "SilentlyContinue"
$inst = $env:KB_PROC_INSTDIR
if ([string]::IsNullOrWhiteSpace($inst)) { exit 11 }
$inst = $inst.TrimEnd("\")
$rootPrefix = $inst + "\"
$mode = $env:KB_PROC_MODE
if ([string]::IsNullOrWhiteSpace($mode)) { $mode = "check" }
function Under-Ids([string]$rootPrefix) {
  $procs = @(Get-Process -Name "LocalKnowledgeWorkbench" -ErrorAction SilentlyContinue)
  foreach ($proc in $procs) {
    $path = $null
    try { $path = $proc.Path } catch {}
    if (-not $path) {
      try { $path = $proc.MainModule.FileName } catch {}
    }
    if ($path -and $path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      Write-Output ([int]$proc.Id)
    }
  }
}
$ids = @(Under-Ids $rootPrefix)
if ($mode -eq "stop") {
  foreach ($id in $ids) {
    try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch {}
  }
  Start-Sleep -Milliseconds 400
  $leftIds = @(Under-Ids $rootPrefix)
  if ($leftIds.Count -gt 0) { exit 10 } else { exit 11 }
}
if ($ids.Count -gt 0) { exit 10 } else { exit 11 }
'@ | Set-Content -LiteralPath $innerPath -Encoding Ascii

  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $ps)) { $ps = 'powershell.exe' }
  $wait = LeftMs
  if ($wait -lt 200) { Finish 2 }
  $child = Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $innerPath) -PassThru -WindowStyle Hidden
  $done = $child.WaitForExit($wait)
  if (-not $done) {
    try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch {}
    Finish 2
  }
  $code = [int]$child.ExitCode
  if ($code -eq 10 -or $code -eq 11) { Finish $code }

  $left = LeftMs
  if ($left -lt 200) { Finish 2 }
  $tl = Join-Path $env:SystemRoot 'System32\tasklist.exe'
  $out = Join-Path $env:TEMP ("kb-tasklist-" + $PID + ".txt")
  $err = Join-Path $env:TEMP ("kb-tasklist-" + $PID + ".err")
  $listed = Start-Process -FilePath $tl -ArgumentList @('/FI', 'IMAGENAME eq LocalKnowledgeWorkbench.exe', '/FO', 'CSV', '/NH') -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
  $listedDone = $listed.WaitForExit($left)
  if (-not $listedDone) {
    try { Stop-Process -Id $listed.Id -Force -ErrorAction SilentlyContinue } catch {}
    Finish 2
  }
  $text = ''
  if (Test-Path -LiteralPath $out) { $text = [IO.File]::ReadAllText($out) }
  if ($text -match 'LocalKnowledgeWorkbench\.exe') { Finish 2 }
  Finish 11
} catch {
  Write-Stamp ("end " + [DateTime]::UtcNow.ToString('o') + " exit 11")
  exit 11
}
