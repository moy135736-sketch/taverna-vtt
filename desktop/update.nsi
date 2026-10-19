; Обновление Таверны для Windows (NSIS 3). Собирается scripts/build-exe.mjs:
;   makensis -INPUTCHARSET UTF8 -DVERSION=1.2.1 -DVNUM=1002001 -DSTAGE=<папка с Taverna.exe> -DOUTFILE=<файл> desktop/update.nsi
; Находит Таверну — установленную или переносную — и заменяет только саму программу.
; Папку taverna-data (столы, персонажи, картинки, музыка, настройки) не трогает.
; Без вопросов: Taverna-<версия>-update.exe /S [/D=папка с Taverna.exe]; код выхода 0 — обновлено.
Target amd64-unicode
SetCompressor /SOLID lzma
SetCompressorDictSize 64
ManifestDPIAware true

!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VNUM
  !define VNUM 0
!endif

Name "Таверна"
Caption "Таверна — обновление до ${VERSION}"
OutFile "${OUTFILE}"
; где искать: /D=папка, иначе путь из реестра (ставил установщик), иначе папка по умолчанию
InstallDir "$LOCALAPPDATA\Programs\Taverna"
InstallDirRegKey HKCU "Software\Taverna" "InstallDir"
RequestExecutionLevel user
BrandingText "Таверна ${VERSION}"
InstallButtonText "Обновить"
SpaceTexts none

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1049 "ProductName" "Таверна"
VIAddVersionKey /LANG=1049 "FileDescription" "Обновление Таверны до версии ${VERSION}"
VIAddVersionKey /LANG=1049 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1049 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1049 "CompanyName" "Taverna VTT"
VIAddVersionKey /LANG=1049 "LegalCopyright" "MIT; Node.js (c) OpenJS Foundation and contributors"

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Taverna"

Var Found    ; 1 — Taverna.exe найдена без вопросов
Var OldVer   ; версия найденной программы, «1.2.0»
Var OldNum   ; она же числом: 1002000
Var Intro    ; текст первой страницы

!define MUI_ICON "${STAGE}\taverna.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${STAGE}\wizard.bmp"
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Прервать обновление? Таверна останется прежней версии."
!define MUI_WELCOMEPAGE_TITLE "Обновление Таверны до ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "$Intro"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW WelcomeShow
!insertmacro MUI_PAGE_WELCOME

!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipDirIfFound
!define MUI_PAGE_HEADER_TEXT "Где лежит Таверна"
!define MUI_PAGE_HEADER_SUBTEXT "Папка, в которой лежит Taverna.exe"
!define MUI_DIRECTORYPAGE_TEXT_TOP "Укажите папку, в которой лежит Taverna.exe. Обновится только программа — папка taverna-data рядом с ней останется как есть.$\r$\n$\r$\nКнопка «Обновить» станет доступна, когда в выбранной папке найдётся Taverna.exe."
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Папка с Таверной"
!insertmacro MUI_PAGE_DIRECTORY

!define MUI_PAGE_HEADER_TEXT "Обновление"
!define MUI_PAGE_HEADER_SUBTEXT "Заменяю программу; столы, персонажи и настройки не трогаю."
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "Обновление завершено"
!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "Таверна ${VERSION} на месте."
!define MUI_INSTFILESPAGE_ABORTHEADER_TEXT "Обновление не выполнено"
!define MUI_INSTFILESPAGE_ABORTHEADER_SUBTEXT "Таверна осталась прежней версии, данные не тронуты."
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "Таверна обновлена"
!define MUI_FINISHPAGE_TEXT "Готово: Таверна ${VERSION}, столы и персонажи на месте.$\r$\n$\r$\nЧто нового: «Режим чайника» в главном меню —$\r$\nвсё работает, но без тяжёлой анимации. И без него$\r$\nТаверна бережёт видеокарту: оформление в покое,$\r$\nпогода и эффекты токенов — в разы легче."
!define MUI_FINISHPAGE_TEXT_LARGE
!define MUI_FINISHPAGE_RUN "$INSTDIR\Taverna.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Запустить Таверну"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "Russian"

; Версия Taverna.exe из её сведений о файле → $OldVer, $OldNum
Function ReadOldVersion
  StrCpy $OldVer ""
  StrCpy $OldNum 0
  ClearErrors
  GetDLLVersion "$INSTDIR\Taverna.exe" $R0 $R1
  ${IfNot} ${Errors}
    IntOp $R2 $R0 >> 16
    IntOp $R2 $R2 & 0xFFFF
    IntOp $R3 $R0 & 0xFFFF
    IntOp $R4 $R1 >> 16
    IntOp $R4 $R4 & 0xFFFF
    StrCpy $OldVer "$R2.$R3.$R4"
    IntOp $OldNum $R2 * 1000000
    IntOp $R5 $R3 * 1000
    IntOp $OldNum $OldNum + $R5
    IntOp $OldNum $OldNum + $R4
  ${EndIf}
FunctionEnd

Function .onInit
  StrCpy $Found 0
  ; файл обновления положили рядом с переносной Taverna.exe — обновляем её, если папку не указали явно (/D=)
  ReadRegStr $R0 HKCU "Software\Taverna" "InstallDir"
  ${If} $R0 == ""
    StrCpy $R0 "$LOCALAPPDATA\Programs\Taverna"
  ${EndIf}
  ${If} $INSTDIR == $R0
  ${AndIf} ${FileExists} "$EXEDIR\Taverna.exe"
    StrCpy $INSTDIR "$EXEDIR"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\Taverna.exe"
    StrCpy $Found 1
    Call ReadOldVersion
  ${EndIf}

  ${If} $Found == 1
  ${AndIf} $OldNum > ${VNUM}
    MessageBox MB_OK|MB_ICONINFORMATION "В папке $INSTDIR уже стоит Таверна $OldVer — она новее, чем это обновление (${VERSION})." /SD IDOK
    SetErrorLevel 3
    Quit
  ${EndIf}

  ${If} $Found == 1
    ${If} $OldNum = ${VNUM}
      StrCpy $Intro "Таверна ${VERSION} уже стоит в папке:$\r$\n$INSTDIR$\r$\n$\r$\nМожно записать программу заново — столы, персонажи, картинки, музыка и настройки (папка taverna-data) останутся как есть."
    ${Else}
      ${If} $OldVer == ""
        StrCpy $OldVer "прежней версии"
      ${EndIf}
      StrCpy $Intro "Найдена Таверна $OldVer:$\r$\n$INSTDIR$\r$\n$\r$\nОбновление заменит только саму программу. Столы, персонажи, картинки, музыка и настройки (папка taverna-data) останутся как есть.$\r$\n$\r$\nЕсли Таверна запущена, закройте окно её сервера, затем нажмите «Обновить»."
    ${EndIf}
  ${Else}
    StrCpy $Intro "Таверна не нашлась там, куда её ставит установщик.$\r$\n$\r$\nНа следующем шаге укажите папку, в которой лежит Taverna.exe. Или положите этот файл рядом с Taverna.exe и запустите снова.$\r$\n$\r$\nСтолы, персонажи и настройки (папка taverna-data) обновление не трогает."
  ${EndIf}
FunctionEnd

; Таверна нашлась — на первой странице сразу «Обновить» (выбор папки пропускается)
Function WelcomeShow
  ${If} $Found == 1
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Обновить"
  ${EndIf}
FunctionEnd

Function SkipDirIfFound
  ${If} $Found == 1
    Abort
  ${EndIf}
FunctionEnd

; «Обновить» доступна, только если в выбранной папке есть Taverna.exe
Function .onVerifyInstDir
  ${IfNot} ${FileExists} "$INSTDIR\Taverna.exe"
    Abort
  ${EndIf}
FunctionEnd

; Работающую программу нельзя заменить — просим закрыть её окно
Function CloseRunning
  retry:
    ClearErrors
    FileOpen $0 "$INSTDIR\Taverna.exe" a
    IfErrors 0 free
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Таверна сейчас запущена. Закройте окно сервера Таверны и нажмите «Повторить»." /SD IDCANCEL IDRETRY retry
    SetErrorLevel 4
    Abort "Таверна запущена — обновление отменено."
  free:
    FileClose $0
FunctionEnd

Section "Обновление"
  SetDetailsPrint both
  ${IfNot} ${FileExists} "$INSTDIR\Taverna.exe"
    MessageBox MB_OK|MB_ICONEXCLAMATION "В папке $INSTDIR нет Taverna.exe — обновлять нечего." /SD IDOK
    SetErrorLevel 5
    Abort "Taverna.exe не найдена."
  ${EndIf}
  Call ReadOldVersion
  ${If} $OldNum > ${VNUM}
    MessageBox MB_OK|MB_ICONINFORMATION "В папке $INSTDIR уже стоит Таверна $OldVer — она новее, чем это обновление (${VERSION})." /SD IDOK
    SetErrorLevel 3
    Abort "Обновление не нужно."
  ${EndIf}
  Call CloseRunning

  ${If} $OldVer == ""
    DetailPrint "Обновляю Таверну до ${VERSION}: $INSTDIR"
  ${Else}
    DetailPrint "Обновляю Таверну $OldVer → ${VERSION}: $INSTDIR"
  ${EndIf}
  SetOverwrite on
  SetOutPath "$INSTDIR"
  File "${STAGE}\Taverna.exe"
  ; установлена установщиком — инструкция и сведения в «Приложениях»; переносная — своя инструкция
  ${If} ${FileExists} "$INSTDIR\Удалить Таверну.exe"
    File "/oname=Как запустить.txt" "${STAGE}\howto-installed.txt"
    ReadRegStr $R0 HKCU "${UNINST_KEY}" "InstallLocation"
    ${If} $R0 == $INSTDIR
      WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
    ${EndIf}
  ${Else}
    File "/oname=Как запустить.txt" "${STAGE}\howto-portable.txt"
  ${EndIf}
  SetOutPath "$INSTDIR\licenses"
  File "${STAGE}\licenses\*.*"
  SetOutPath "$INSTDIR"
  DetailPrint "Готово. Данные в $INSTDIR\taverna-data не тронуты."
SectionEnd
