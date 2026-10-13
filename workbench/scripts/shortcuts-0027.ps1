# Desktop and Start menu shortcuts for the fixed launcher.
# InstallRoot, DesktopDir, and StartMenuDir are all required.
# Never falls back to the real desktop or Start menu.
# ASCII only: Windows PowerShell 5.1 reads a BOM-less UTF-8 file as GBK.
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$DesktopDir,
  [Parameter(Mandatory = $true)][string]$StartMenuDir
)

$ErrorActionPreference = 'Stop'

# Display name is SHORTCUT_NAME (seven Han characters), built from code points below.
$name = -join @(
  [char]0x672C, [char]0x5730, [char]0x77E5, [char]0x8BC6,
  [char]0x5DE5, [char]0x4F5C, [char]0x53F0
)
$target = Join-Path $InstallRoot 'launcher\kb-launch.exe'
$shell = New-Object -ComObject WScript.Shell

function Write-KbShortcut([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $lnk = Join-Path $dir ($name + '.lnk')
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = $target
  $sc.WorkingDirectory = $InstallRoot
  # 1 = normal window. Do not use 7 (minimized) or /MIN.
  $sc.WindowStyle = 1
  $sc.Description = $name
  $sc.Save()
}

Write-KbShortcut $DesktopDir
Write-KbShortcut $StartMenuDir
