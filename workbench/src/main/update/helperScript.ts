import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** ASCII only. Windows PowerShell 5.1 reads this without a code page mismatch. */
const HELPER = `
$ErrorActionPreference = 'Continue'
function Log($m) {
  if ($env:KB_HELPER_LOG) { Add-Content -Encoding ascii -Path $env:KB_HELPER_LOG -Value $m }
}
Log 'helper-start'
$pidToWait = 0
[void][int]::TryParse($env:KB_HELPER_PID, [ref]$pidToWait)
$deadline = (Get-Date).AddMinutes(3)
while ($pidToWait -gt 0) {
  $alive = Get-Process -Id $pidToWait -ErrorAction SilentlyContinue
  if (-not $alive) { break }
  if ((Get-Date) -gt $deadline) { Log 'wait-timeout'; break }
  Start-Sleep -Milliseconds 200
}
function Copy-Tree($src, $dst) {
  if (-not $src -or $src -eq '-' -or -not (Test-Path -LiteralPath $src)) { return }
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  & robocopy $src $dst /E /R:5 /W:1 /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  Log ("copied " + $src)
}
$mode = $env:KB_HELPER_MODE
if ($mode -eq 'apply') {
  $destDir = $env:KB_HELPER_INSTALL_DIR
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  Copy-Item -Force -LiteralPath $env:KB_HELPER_PAYLOAD -Destination (Join-Path $destDir 'payload.bin')
  Set-Content -Encoding ascii -Path (Join-Path $destDir 'version.txt') -Value $env:KB_HELPER_VERSION
  Log 'apply-done'
} elseif ($mode -eq 'rollback') {
  Copy-Tree $env:KB_HELPER_INSTALL_SRC $env:KB_HELPER_INSTALL_DST
  Log 'rollback-done'
}
if ($env:KB_HELPER_DONE) { Set-Content -Encoding ascii -Path $env:KB_HELPER_DONE -Value 'ok' }
if ($env:KB_HELPER_RELAUNCH -and $env:KB_HELPER_RELAUNCH -ne '-') { Start-Process -FilePath $env:KB_HELPER_RELAUNCH }
exit 0
`.trimStart();

export async function writeHelperScript(): Promise<string> {
  const file = path.join(os.tmpdir(), 'kb-update-helper.ps1');
  await fs.writeFile(file, HELPER.replace(/^\uFEFF/, ''), 'ascii');
  return file;
}

export function powershellExe(): string {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
