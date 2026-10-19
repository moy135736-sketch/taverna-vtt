; Установщик Таверны для Windows (NSIS 3). Собирается scripts/build-exe.mjs:
;   makensis -INPUTCHARSET UTF8 -DVERSION=1.2.1 -DSTAGE=<папка с Taverna.exe> -DOUTFILE=<файл> desktop/installer.nsi
; Ставит программу в папку пользователя (без прав администратора), создаёт ярлыки и запускает её.
; 64-битный установщик: сама программа (Node.js x64) работает только на 64-битной Windows
Target amd64-unicode
SetCompressor /SOLID lzma
SetCompressorDictSize 64
ManifestDPIAware true

!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif

Name "Таверна"
Caption "Таверна ${VERSION} — установка"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Taverna"
InstallDirRegKey HKCU "Software\Taverna" "InstallDir"
RequestExecutionLevel user
BrandingText "Таверна ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1049 "ProductName" "Таверна"
VIAddVersionKey /LANG=1049 "FileDescription" "Установка Таверны — виртуального стола для НРИ"
VIAddVersionKey /LANG=1049 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1049 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1049 "CompanyName" "Taverna VTT"
VIAddVersionKey /LANG=1049 "LegalCopyright" "MIT; Node.js (c) OpenJS Foundation and contributors"

!define MUI_ICON "${STAGE}\taverna.ico"
!define MUI_UNICON "${STAGE}\taverna.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${STAGE}\wizard.bmp"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Таверна ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Виртуальный стол для настольных ролевых игр: карта, токены, туман войны, листы персонажей Roll20, кубики и голосовой чат.$\r$\n$\r$\nПрограмма ставится в вашу папку пользователя, права администратора не нужны. Данные хранятся рядом с ней, в папке taverna-data.$\r$\n$\r$\nЕсли Таверна уже установлена и запущена — закройте её окно перед обновлением."
!define MUI_FINISHPAGE_RUN "$INSTDIR\Taverna.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Запустить Таверну"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\Как запустить.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Открыть инструкцию"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Taverna"

; Работающую программу нельзя заменить — просим закрыть её окно
Function CloseRunning
  IfFileExists "$INSTDIR\Taverna.exe" 0 done
  retry:
    ClearErrors
    FileOpen $0 "$INSTDIR\Taverna.exe" a
    IfErrors 0 free
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Таверна сейчас запущена. Закройте окно сервера Таверны и нажмите «Повторить»." /SD IDCANCEL IDRETRY retry
    Abort
  free:
    FileClose $0
  done:
FunctionEnd

Section "Таверна" SecMain
  SectionIn RO
  Call CloseRunning
  SetOutPath "$INSTDIR"
  File "${STAGE}\Taverna.exe"
  File "${STAGE}\Как запустить.txt"
  SetOutPath "$INSTDIR\licenses"
  File "${STAGE}\licenses\*.*"
  SetOutPath "$INSTDIR"
  CreateDirectory "$INSTDIR\taverna-data"
  WriteUninstaller "$INSTDIR\Удалить Таверну.exe"

  CreateShortcut "$DESKTOP\Таверна.lnk" "$INSTDIR\Taverna.exe" "" "$INSTDIR\Taverna.exe" 0 SW_SHOWNORMAL "" "Запустить Таверну"
  CreateDirectory "$SMPROGRAMS\Таверна"
  CreateShortcut "$SMPROGRAMS\Таверна\Таверна.lnk" "$INSTDIR\Taverna.exe" "" "$INSTDIR\Taverna.exe" 0
  CreateShortcut "$SMPROGRAMS\Таверна\Папка с данными.lnk" "$INSTDIR\taverna-data"
  CreateShortcut "$SMPROGRAMS\Таверна\Как запустить.lnk" "$INSTDIR\Как запустить.txt"
  CreateShortcut "$SMPROGRAMS\Таверна\Удалить Таверну.lnk" "$INSTDIR\Удалить Таверну.exe"

  WriteRegStr HKCU "Software\Taverna" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Таверна"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Taverna VTT"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\Taverna.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Удалить Таверну.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" 92000
SectionEnd

Section "Uninstall"
  retry:
    ClearErrors
    Delete "$INSTDIR\Taverna.exe"
    IfErrors 0 removed
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Таверна сейчас запущена. Закройте окно сервера Таверны и нажмите «Повторить»." /SD IDCANCEL IDRETRY retry
    Abort
  removed:
  Delete "$INSTDIR\Как запустить.txt"
  RMDir /r "$INSTDIR\licenses"
  Delete "$DESKTOP\Таверна.lnk"
  RMDir /r "$SMPROGRAMS\Таверна"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\Taverna"
  IfFileExists "$INSTDIR\taverna-data\taverna.db" 0 nodata
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Удалить и данные Таверны — столы, персонажей, загруженные картинки и музыку?$\r$\n$\r$\nЕсли не уверены, нажмите «Нет»: папка taverna-data останется, и при новой установке всё вернётся." /SD IDNO IDNO keepdata
    RMDir /r "$INSTDIR\taverna-data"
  nodata:
    RMDir "$INSTDIR\taverna-data"
    Delete "$INSTDIR\Удалить Таверну.exe"
    RMDir "$INSTDIR"
    Goto finish
  keepdata:
    Delete "$INSTDIR\Удалить Таверну.exe"
  finish:
SectionEnd
