# r11-E：修后性能重测脚本（交给试金石在 Win11 真机跑）。本脚本不编造数字。
# 用法（安装包目录或仓库根）：
#   powershell -ExecutionPolicy Bypass -File scripts/win-measure-r11.ps1 -Exe "$env:LOCALAPPDATA\Programs\LocalKnowledgeWorkbench\LocalKnowledgeWorkbench.exe" -SampleRoot "D:\path\to\sample"
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$SampleRoot,
  [string]$OutDir = ".\verify\r11-win-measure",
  [int]$Runs = 3
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$results = @()
for ($i = 1; $i -le $Runs; $i++) {
  $ud = Join-Path $OutDir ("userdata-{0}" -f $i)
  if (Test-Path $ud) { Remove-Item -Recurse -Force $ud }
  New-Item -ItemType Directory -Force -Path $ud | Out-Null
  $env:KB_USER_DATA = $ud
  $env:KB_STARTUP_TRACE = "1"
  $p = Start-Process -FilePath $Exe -ArgumentList @() -PassThru
  $trace = Join-Path $ud "startup-trace.json"
  $deadline = (Get-Date).AddMinutes(3)
  while (-not (Test-Path $trace) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 400 }
  Start-Sleep -Seconds 8
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
  $row = @{ run = $i; trace = $null; logHint = "see $ud" }
  if (Test-Path $trace) { $row.trace = Get-Content -Raw $trace | ConvertFrom-Json }
  $results += $row
  Copy-Item $trace (Join-Path $OutDir ("startup-trace-{0}.json" -f $i)) -ErrorAction SilentlyContinue
}
$out = Join-Path $OutDir "summary.json"
$results | ConvertTo-Json -Depth 8 | Set-Content -Path $out -Encoding UTF8
Write-Host "Wrote $out — 请把数字对照 r10 性能组 REPORT，勿手填假数据。"
