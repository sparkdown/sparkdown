; SparkDown NSIS installer hooks (tauri.conf.json:
; bundle.windows.nsis.installerHooks). Tauri !includes this file near the
; top of its stock installer.nsi, after MUI2/FileFunc/LogicLib and before
; the installer pages.
;
; Upgrading over a pre-0.3.1 install (sparkdown/sparkdown#17)
; -----------------------------------------------------------
; Tauri's "already installed" page runs the previous uninstaller as
;   ExecWait '<UninstallString> _?=<dir>'
; reading <dir> from HKCU\Software\<MANUFACTURER>\<PRODUCTNAME>. MANUFACTURER
; is bundle.publisher, else the 2nd part of the identifier. v0.3.1 is the
; first build with publisher "PearTree Forge LLC"; older builds registered
; their folder under Software\sparkdown\SparkDown. v0.3.1 found nothing
; there, ran the old uninstaller with an empty "_?=", and it failed
; ("unable to uninstall"), so the user had to uninstall by hand.
; Template: https://github.com/tauri-apps/tauri/blob/%40tauri-apps/cli-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
;
; Fix: before the first page (MUI .onGUIInit), if the current key is
; missing but an uninstall entry exists, recover the old install folder and
; write it where the stock template reads it. Sources, in order: the legacy
; Software\sparkdown\SparkDown key, the uninstall entry's InstallLocation,
; then the folder of its UninstallString (quotes stripped). A folder is only
; accepted when <folder>\uninstall.exe exists. Silent (/S) installs show no
; pages, so neither the reinstall page nor this hook runs there.
;
; SD_PRODUCTNAME / SD_PUBLISHER must match tauri.conf.json (productName,
; bundle.publisher); main.rs `nsis_hooks_match_bundle_config` checks it.

!include LogicLib.nsh
!include FileFunc.nsh

!define SD_PRODUCTNAME "SparkDown"
!define SD_PUBLISHER "PearTree Forge LLC"
!define SD_LEGACY_MANUFACTURER "sparkdown"
!define SD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SD_PRODUCTNAME}"
!define SD_MANUPRODUCTKEY "Software\${SD_PUBLISHER}\${SD_PRODUCTNAME}"
!define SD_LEGACY_MANUPRODUCTKEY "Software\${SD_LEGACY_MANUFACTURER}\${SD_PRODUCTNAME}"

!ifdef MUI_CUSTOMFUNCTION_GUIINIT
  !error "hooks.nsh: MUI_CUSTOMFUNCTION_GUIINIT is already defined; chain SdRecoverPreviousInstallDir from it"
!endif
!define MUI_CUSTOMFUNCTION_GUIINIT SdRecoverPreviousInstallDir

; Stack: in "path" (maybe "quoted") -> out path without surrounding quotes
; or a trailing backslash.
Function SdCleanPath
  Exch $0
  Push $1
  StrCpy $1 $0 1
  ${If} $1 == '"'
    StrCpy $0 $0 "" 1
  ${EndIf}
  StrCpy $1 $0 "" -1
  ${If} $1 == '"'
    StrCpy $0 $0 -1
  ${EndIf}
  StrCpy $1 $0 "" -1
  ${If} $1 == "\"
    StrCpy $0 $0 -1
  ${EndIf}
  Pop $1
  Exch $0
FunctionEnd

Function SdRecoverPreviousInstallDir
  Push $R0
  Push $R1

  ; Current key present: the stock template handles everything.
  ReadRegStr $R0 SHCTX "${SD_MANUPRODUCTKEY}" ""
  StrCmp $R0 "" 0 sd_done
  ; No previous install registered: nothing to uninstall.
  ReadRegStr $R1 SHCTX "${SD_UNINSTKEY}" "UninstallString"
  StrCmp $R1 "" sd_done

  ; 1. The folder a pre-0.3.1 build registered under its default manufacturer.
  ReadRegStr $R0 SHCTX "${SD_LEGACY_MANUPRODUCTKEY}" ""
  Push $R0
  Call SdCleanPath
  Pop $R0
  StrCmp $R0 "" +2
  IfFileExists "$R0\uninstall.exe" sd_found

  ; 2. The uninstall entry's InstallLocation (Tauri writes it quoted).
  ReadRegStr $R0 SHCTX "${SD_UNINSTKEY}" "InstallLocation"
  Push $R0
  Call SdCleanPath
  Pop $R0
  StrCmp $R0 "" +2
  IfFileExists "$R0\uninstall.exe" sd_found

  ; 3. The folder of the (quoted) UninstallString.
  Push $R1
  Call SdCleanPath
  Pop $R1
  ${GetParent} "$R1" $R0
  StrCmp $R0 "" sd_done
  IfFileExists "$R0\uninstall.exe" sd_found sd_done

  sd_found:
    WriteRegStr SHCTX "${SD_MANUPRODUCTKEY}" "" "$R0"
    ; Same as Tauri's RestorePreviousInstallLocation would have done with
    ; the key present: default the install dir to the previous one.
    StrCpy $INSTDIR "$R0"

  sd_done:
  Pop $R1
  Pop $R0
FunctionEnd


; ---------------------------------------------------------------------------
; #160: add sparkdown to the user PATH (on by default), remove on uninstall.
; Tauri's finish page already owns MUI_FINISHPAGE_SHOWREADME for the desktop
; shortcut checkbox, so we cannot reuse that slot. PATH is added in
; NSIS_HOOK_POSTINSTALL for every install (UI and silent) unless /SDNOPATH.
; The console shim ships as $INSTDIR\sparkdown-shim.exe (externalBin). We copy
; it to $INSTDIR\bin\sparkdown.exe and put $INSTDIR\bin on PATH — not $INSTDIR
; itself — because Windows is case-insensitive and SparkDown.exe would collide
; with sparkdown.exe in the same folder.
; Uses ${StrLoc} (initialized by Tauri's installer.nsi before hooks).
; ---------------------------------------------------------------------------

Var SdOldPath
Var SdNewPath
Var SdPathNeedle
Var SdPathIdx
Var SdPathLeft
Var SdPathRight
Var SdPathLen

!define SD_PATH_REGKEY "Environment"
!define SD_PATH_BIN "$INSTDIR\bin"

Function SdInstallPathShim
  ; Place a case-safe sparkdown.exe on PATH ($INSTDIR\bin), sourced from the
  ; distinctly named externalBin next to the GUI.
  CreateDirectory "${SD_PATH_BIN}"
  IfFileExists "$INSTDIR\sparkdown-shim.exe" 0 sd_shim_missing
    CopyFiles /SILENT "$INSTDIR\sparkdown-shim.exe" "${SD_PATH_BIN}\sparkdown.exe"
    Return
  sd_shim_missing:
    DetailPrint "sparkdown-shim.exe missing; PATH entry skipped"
FunctionEnd

Function SdAppendUserPath
  StrCpy $SdPathNeedle "${SD_PATH_BIN}"
  ReadRegStr $SdOldPath HKCU "${SD_PATH_REGKEY}" "Path"
  ; Already present? Search ;path; form.
  StrCpy $0 ";$SdOldPath;"
  ${StrLoc} $SdPathIdx "$0" ";$SdPathNeedle;" ">"
  ${If} $SdPathIdx != ""
    Return
  ${EndIf}
  ${If} $SdOldPath == ""
    StrCpy $SdNewPath "$SdPathNeedle"
  ${Else}
    StrCpy $SdNewPath "$SdOldPath;$SdPathNeedle"
  ${EndIf}
  WriteRegExpandStr HKCU "${SD_PATH_REGKEY}" "Path" "$SdNewPath"
  WriteRegStr HKCU "${SD_UNINSTKEY}" "SdPathDir" "$SdPathNeedle"
  System::Call 'user32::SendMessageTimeout(i 0xffff, i 0x1A, i 0, t "Environment", i 0, i 5000, *i .r0)'
FunctionEnd

Function SdRemoveUserPath
  ReadRegStr $SdPathNeedle HKCU "${SD_UNINSTKEY}" "SdPathDir"
  ${If} $SdPathNeedle == ""
    Return
  ${EndIf}
  ReadRegStr $SdOldPath HKCU "${SD_PATH_REGKEY}" "Path"
  ${If} $SdOldPath == $SdPathNeedle
    StrCpy $SdNewPath ""
  ${Else}
    ; Prefer removing ";dir" then "dir;" then bare "dir".
    StrCpy $SdNewPath "$SdOldPath"
    StrCpy $0 ";$SdPathNeedle"
    ${StrLoc} $SdPathIdx "$SdNewPath" "$0" ">"
    ${If} $SdPathIdx != ""
      StrLen $SdPathLen "$0"
      StrCpy $SdPathLeft "$SdNewPath" $SdPathIdx
      IntOp $SdPathIdx $SdPathIdx + $SdPathLen
      StrCpy $SdPathRight "$SdNewPath" "" $SdPathIdx
      StrCpy $SdNewPath "$SdPathLeft$SdPathRight"
    ${Else}
      StrCpy $0 "$SdPathNeedle;"
      ${StrLoc} $SdPathIdx "$SdNewPath" "$0" ">"
      ${If} $SdPathIdx != ""
        StrLen $SdPathLen "$0"
        StrCpy $SdPathLeft "$SdNewPath" $SdPathIdx
        IntOp $SdPathIdx $SdPathIdx + $SdPathLen
        StrCpy $SdPathRight "$SdNewPath" "" $SdPathIdx
        StrCpy $SdNewPath "$SdPathLeft$SdPathRight"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  WriteRegExpandStr HKCU "${SD_PATH_REGKEY}" "Path" "$SdNewPath"
  DeleteRegValue HKCU "${SD_UNINSTKEY}" "SdPathDir"
  System::Call 'user32::SendMessageTimeout(i 0xffff, i 0x1A, i 0, t "Environment", i 0, i 5000, *i .r0)'
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  ; Always stage bin\sparkdown.exe when the shim is present (even if PATH is
  ; opted out — a later Repair can still add PATH).
  Call SdInstallPathShim
  ; Default-on PATH for UI and silent installs; /SDNOPATH opts out.
  ; (Cannot use MUI_FINISHPAGE_SHOWREADME — Tauri already uses it for desktop.)
  ClearErrors
  ${GetParameters} $0
  ${GetOptions} $0 "/SDNOPATH" $1
  IfErrors 0 sd_path_done
    Call SdAppendUserPath
  sd_path_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Call SdRemoveUserPath
!macroend
