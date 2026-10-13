; electron-builder NSIS 自定义脚本（package.json build.nsis.include）
; 卸载时询问是否同时删除用户数据；默认（直接回车 / 静默卸载 / 升级覆盖安装）保留。
; 用户数据位置见 docs：%LOCALAPPDATA%\LocalKnowledgeWorkbench（第八轮起），旧版本在 %APPDATA%\LocalKnowledgeWorkbench。
; 注意：只删除工作台自己的数据（元数据库、工作区、插件、网页会话），从不触碰用户注册的根目录中的文件。

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除本地知识工作台的用户数据？$\r$\n$\r$\n包括：工作区布局、收藏、索引、插件及其授权与存储、网页面板的网站数据。$\r$\n你的文件（已注册的根目录）不会被删除。$\r$\n$\r$\n选择“否”将保留数据，重新安装后可继续使用。" /SD IDNO IDYES kbDeleteData IDNO kbKeepData
    kbDeleteData:
      RMDir /r "$LOCALAPPDATA\LocalKnowledgeWorkbench"
      RMDir /r "$APPDATA\LocalKnowledgeWorkbench"
      Goto kbDone
    kbKeepData:
    kbDone:
  ${endIf}
!macroend

; 进程检查不走 CIM。单次探测由 build/kb-proc-check.ps1 限制在 4 秒。
; 退出码 10 = 安装目录内正在运行，11 = 没有，2 = 超时（视为没在运行）。
Var /GLOBAL kbProbeCode
Var /GLOBAL kbProbeKind

; 卸载器单独编译时不会插入下面的宏。变量若声明了却没被赋值，NSIS 会把 warning 6001 当成错误。
!ifndef BUILD_UNINSTALLER
Var /GLOBAL kbShadowKey
Var /GLOBAL kbShadowOn
!endif

; HKEY_CURRENT_USER = 0x80000001，KEY_ALL_ACCESS = 0xF003F。
; 只在 KB_NSIS_INSTDIR 非空时把本进程 HKCU 指到空影子键，让 uninstallOldVersion 读不到已注册的卸载项。
; 不删除 UninstallString / QuietUninstallString。句柄在恢复前不关闭。
; 0.2.3 拉起安装器时 argv 固定是 /S --updated，不会带 /LOG=。环境变量仍会传到本进程，
; 所以门禁日志改由安装器自己追加到 KB_UPDATE_INSTALL_LOG。
!macro kbAppendEnvLog LINE
  !define KB_LOG_ID ${__COUNTER__}
  Push $2
  Push $3
  ReadEnvStr $2 "KB_UPDATE_INSTALL_LOG"
  StrCmp $2 "" kbAppendEnvLogDone_${KB_LOG_ID}
  ClearErrors
  FileOpen $3 "$2" a
  IfErrors kbAppendEnvLogDone_${KB_LOG_ID}
  FileSeek $3 0 END
  FileWrite $3 "${LINE}$\r$\n"
  FileClose $3
  kbAppendEnvLogDone_${KB_LOG_ID}:
  Pop $3
  Pop $2
  !undef KB_LOG_ID
!macroend

!macro kbRedirectHkcuShadow
  Push $0
  Push $1
  ReadRegStr $0 HKCU "Software\173de95e-f638-560d-b657-f1331a82173e" "InstallLocation"
  DetailPrint "kb-foreign-install: $0"
  !insertmacro kbAppendEnvLog "kb-foreign-install: $0"
  ClearErrors
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\173de95e-f638-560d-b657-f1331a82173e" "UninstallString"
  DetailPrint "kb-foreign-uninstall: $0"
  !insertmacro kbAppendEnvLog "kb-foreign-uninstall: $0"
  ClearErrors
  System::Call 'advapi32::RegCreateKeyEx(p 0x80000001, t "Software\kb-nsis-shadow", i 0, p 0, i 0, i 0xF003F, p 0, *p .r1, p 0) i.r0'
  ${if} ${errors}
  ${orIf} $0 != 0
    Goto kbShadowOpenFailed
  ${endIf}
  StrCpy $kbShadowKey $1
  ClearErrors
  System::Call 'advapi32::RegOverridePredefKey(p 0x80000001, p r1) i.r0'
  ${if} ${errors}
  ${orIf} $0 != 0
    Goto kbShadowOpenFailed
  ${endIf}
  StrCpy $kbShadowOn "1"
  DetailPrint "kb-reg-shadow: HKCU redirected"
  !insertmacro kbAppendEnvLog "kb-reg-shadow: HKCU redirected"
  Pop $1
  Pop $0
  Goto kbShadowRedirectDone
  kbShadowOpenFailed:
    Pop $1
    Pop $0
    DetailPrint "kb-reg-shadow: open failed"
    !insertmacro kbAppendEnvLog "kb-reg-shadow: open failed"
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法隔离注册表，安装已退出。" /SD IDOK
    Quit
  kbShadowRedirectDone:
!macroend

; 可重入。customInstall 与 .onInstFailed 共用。仅影子键生效时恢复。
!macro kbRestoreHkcuShadow
  StrCmp $kbShadowOn "1" 0 kbShadowRestoreDone
  Push $0
  Push $1
  StrCpy $1 $kbShadowKey
  System::Call 'advapi32::RegOverridePredefKey(p 0x80000001, p 0) i.r0'
  System::Call 'advapi32::RegCloseKey(p r1) i.r0'
  Pop $1
  Pop $0
  StrCpy $kbShadowOn ""
  DeleteRegKey HKCU "Software\kb-nsis-shadow"
  DetailPrint "kb-reg-shadow: restored"
  !insertmacro kbAppendEnvLog "kb-reg-shadow: restored"
  kbShadowRestoreDone:
!macroend

!macro customInit
  Push $0
  ReadEnvStr $0 "KB_NSIS_INSTDIR"
  ${if} $0 != ""
    StrCpy $INSTDIR $0
    DetailPrint "kb-instdir: using KB_NSIS_INSTDIR"
    Pop $0
    !insertmacro kbRedirectHkcuShadow
  ${else}
    Pop $0
  ${endIf}
!macroend

!ifndef BUILD_UNINSTALLER
!macro customInstall
  !insertmacro kbRestoreHkcuShadow
!macroend

Function .onInstFailed
  !insertmacro kbRestoreHkcuShadow
FunctionEnd
!endif

!macro kbProbeApp
  InitPluginsDir
  File /oname=$PLUGINSDIR\kb-proc-check.ps1 "${BUILD_RESOURCES_DIR}\kb-proc-check.ps1"
  System::Call 'kernel32::SetEnvironmentVariable(t "KB_PROC_INSTDIR", t "$INSTDIR")'
  nsExec::Exec `"$PowerShellPath" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\kb-proc-check.ps1"`
  Pop $kbProbeCode
!macroend

!macro kbClassify
  ${if} $kbProbeCode == "2"
    DetailPrint "process check timed out, assume not running"
    StrCpy $kbProbeKind "timeout"
  ${elseIf} $kbProbeCode == "10"
    StrCpy $kbProbeKind "running"
  ${elseIf} $kbProbeCode == "11"
    DetailPrint "kb-proc: not running"
    StrCpy $kbProbeKind "clear"
  ${else}
    DetailPrint "kb-proc: probe failed, assume not running"
    StrCpy $kbProbeKind "clear"
  ${endIf}
!macroend

!macro customCheckAppRunning
  System::Call 'kernel32::SetEnvironmentVariable(t "KB_PROC_MODE", t "check")'
  !insertmacro kbProbeApp
  !insertmacro kbClassify
  ${if} $kbProbeKind != "running"
    Goto kbProcDone
  ${endIf}
  DetailPrint "kb-proc: running under install dir"
  ${if} ${isUpdated}
    Sleep 300
    System::Call 'kernel32::SetEnvironmentVariable(t "KB_PROC_MODE", t "check")'
    !insertmacro kbProbeApp
    !insertmacro kbClassify
    ${if} $kbProbeKind != "running"
      Goto kbProcDone
    ${endIf}
    Sleep 1000
    System::Call 'kernel32::SetEnvironmentVariable(t "KB_PROC_MODE", t "check")'
    !insertmacro kbProbeApp
    !insertmacro kbClassify
    ${if} $kbProbeKind != "running"
      Goto kbProcDone
    ${endIf}
    System::Call 'kernel32::SetEnvironmentVariable(t "KB_PROC_MODE", t "stop")'
    !insertmacro kbProbeApp
    System::Call 'kernel32::SetEnvironmentVariable(t "KB_PROC_MODE", t "check")'
    !insertmacro kbClassify
    ${if} $kbProbeKind != "running"
      Goto kbProcDone
    ${endIf}
  ${endIf}
  StrCpy $R1 0
  kbProcAsk:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "本地知识工作台正在安装目录中运行。请先关闭它，然后重试。取消将退出安装。" /SD IDCANCEL IDRETRY kbProcRetry
    Quit
    kbProcRetry:
      IntOp $R1 $R1 + 1
      Sleep 1000
      System::Call 'kernel32::SetEnvironmentVariable(t "KB_PROC_MODE", t "stop")'
      !insertmacro kbProbeApp
      System::Call 'kernel32::SetEnvironmentVariable(t "KB_PROC_MODE", t "check")'
      !insertmacro kbClassify
      ${if} $kbProbeKind != "running"
        Goto kbProcDone
      ${endIf}
      ${if} $R1 > 2
        MessageBox MB_OK|MB_ICONEXCLAMATION "安装目录中的本地知识工作台仍在运行。安装已退出。" /SD IDOK
        Quit
      ${endIf}
      Goto kbProcAsk
  kbProcDone:
!macroend
