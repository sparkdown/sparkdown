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
