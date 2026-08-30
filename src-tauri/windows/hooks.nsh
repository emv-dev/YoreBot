; YoreBot — NSIS installer hooks
; Extends the default Tauri uninstaller to:
;   1. Kill helper processes that hold file locks BEFORE removing files.
;   2. Clean application data directories that live outside the Tauri-managed
;      bundle ID path when the user opts in to "Delete app data".
;
; On Windows the app stores data in three locations:
;   1. %APPDATA%\app.yorebot.desktop\           — Tauri-internal store +
;                                                 settings.json (new installs).
;                                                 Cleaned by Tauri default.
;   2. %APPDATA%\YoreBot\                       — User data folder
;                                                 (models, threads, backends,
;                                                 logs, store.json,
;                                                 mcp_config.json).
;                                                 NOT cleaned by Tauri default.
;   3. %LOCALAPPDATA%\app.yorebot.desktop\EBWebView — WebView2 cache + localStorage.
;                                                 Cleaned by Tauri default,
;                                                 but on perUser/passive
;                                                 installs lockfiles can be
;                                                 left behind, so we redo it.
;
; A custom data_folder set by the user via "Change data folder location"
; is NOT covered by these hooks — the user is responsible for cleaning it.

!macro YOREBOT_STOP_OWNED_PROCESSES
  ; Invoke the one helper that Tauri bundles under its Windows resources
  ; directory. It first stops only the exact installed main executable, then
  ; exact-name helpers whose canonical executable path is equal to or below
  ; the exact install/data roots. Prefix siblings remain untouched.
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\stop-yorebot-owned-processes.ps1" -InstallRoot "$INSTDIR" -DataRoot "$APPDATA\YoreBot" -MainExecutable "$INSTDIR\${MAINBINARYNAME}.exe"'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != 0
    DetailPrint "YoreBot could not safely stop its local processes."
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Reap a backend left by an older uninstaller after the helper is installed
  ; and before the install-success hook can launch the new app.
  !insertmacro YOREBOT_STOP_OWNED_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop the exact installed main process before its helpers so it cannot
  ; restart a backend while the uninstaller removes their owning files.
  !insertmacro YOREBOT_STOP_OWNED_PROCESSES

  ; msedgewebview2.exe is shared with other Edge-based apps on the system —
  ; we must only kill instances that belong to *our* WebView2 user data
  ; directory (%LOCALAPPDATA%\app.yorebot.desktop). PowerShell filters by the
  ; process MainModule path. -EA SilentlyContinue + try/catch so we never
  ; abort uninstall if PowerShell is missing or a process exits mid-query.
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Where-Object { try { $_.MainModule.FileName -like \"*app.yorebot.desktop*\" } catch { $false } } | Stop-Process -Force -ErrorAction SilentlyContinue"'
  Pop $0

  ; Give the kernel a moment to release file handles after TerminateProcess.
  Sleep 1500
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    ; Clean the user data folder (models, backends, threads, logs, ...).
    RmDir /r "$APPDATA\YoreBot"
    ; Tauri default already removes %LOCALAPPDATA%\app.yorebot.desktop, but
    ; perUser/passive uninstalls sometimes leave EBWebView lockfiles behind.
    ; Redo it idempotently — no-op if the directory is already gone.
    RmDir /r "$LOCALAPPDATA\app.yorebot.desktop"
    ; Drop the per-user AUMID registration used by Toast notifications in dev builds.
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\app.yorebot.desktop"
  ${EndIf}
!macroend
