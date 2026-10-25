;=====================================================
;  群崽 QunZai · 安装程序 (NSIS Unicode)
;  编译: 先 node precheck-package.js（隐私闸门，必须 exit 0）
;        再 makensis.exe setup.nsi   (在项目根目录执行)
;  默认安装到 D:\群崽，服务启停与 DeepSeek 内嵌均由桌面宿主管理
;=====================================================
Unicode true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define APPNAME "群崽 QunZai"
!define REGKEY "Software\QunZai"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\QunZai"
!ifndef VERSION
  !define VERSION "1.4.13"
!endif

Name "${APPNAME}"
OutFile "..\releases\群崽QunZai安装包-v${VERSION}.exe"
InstallDir "D:\群崽"
InstallDirRegKey HKCU "${REGKEY}" "InstallDir"
RequestExecutionLevel user
Icon "dist\assets\icon.ico"
!define MUI_ICON "dist\assets\icon.ico"
!define MUI_UNICON "dist\assets\icon.ico"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=0 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=0 "FileDescription" "群崽 QunZai 安装程序"
VIAddVersionKey /LANG=0 "FileVersion" "${VERSION}.0"
VIAddVersionKey /LANG=0 "CompanyName" "QunZai"
VIAddVersionKey /LANG=0 "LegalCopyright" "Copyright (c) 2026 QunZai contributors"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\desktop\QunZaiHost.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 群崽（桌面窗口，内置 DeepSeek）"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Section "主程序" SecMain
  SetOutPath "$INSTDIR"
  File "..\LICENSE"

  ; 自动更新会从正在运行的 Node 服务里拉起安装器：
  ; 先留出时间让 HTTP 响应发回页面，再结束旧宿主和旧服务。
  Sleep 1000

  ; 覆盖安装前先结束旧桌面宿主，否则 exe 被占用会导致复制失败
  nsExec::Exec 'taskkill /IM QunZaiHost.exe /F'
  Pop $0

  ; 只结束 QunZaiHost 不够：Node 服务是独立进程，会继续跑旧代码。
  ; 用安装器自带的停止脚本，不再依赖旧版 launcher.ps1 —— 旧版 -Stop 会
  ; 逐个扫描 60 个端口，自动更新时可能卡几十秒。
  InitPluginsDir
  File /oname=$PLUGINSDIR\stop-service.ps1 "stop-service.ps1"
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-service.ps1" -Root "$INSTDIR"' $0

  ; ---------- Node.js 检测（22+；网页驱动依赖内置 WebSocket） ----------
  ; 安装包里带了内置监视器（含 node.exe）时就不用再要求用户装 Node。
  ; 注意：这里必须是编译期判断（!if），运行期 $INSTDIR 里还没有解出文件。
  !if /FileExists "dist\engine\napcat\node.exe"
    StrCpy $0 "0"
  !else
    !if /FileExists "dist\engine\snowluma\node.exe"
      StrCpy $0 "0"
    !else
      nsExec::ExecToStack 'cmd /c node -e "process.exit(parseInt(process.versions.node, 10) >= 22 ? 0 : 1)"'
      Pop $0
      Pop $1
    !endif
  !endif
  StrCmp $0 "0" nodeOk 0
  MessageBox MB_ICONEXCLAMATION|MB_YESNO \
    "未检测到 Node.js 22+（本程序需要 Node.js 22 或更高版本才能运行）。$\r$\n建议先到 https://nodejs.org 安装 LTS 版，再安装本程序。$\r$\n仍要继续安装吗？" \
    IDYES nodeOk
  Abort
  nodeOk:

  ; ---------- 保护用户数据：重装不覆盖聊天记录 / 配置 / DeepSeek 登录态 ----------
  StrCpy $R9 "0"
  IfFileExists "$INSTDIR\data\store.json" 0 noData
    RMDir /r "$INSTDIR\data_preserve"
    Rename "$INSTDIR\data" "$INSTDIR\data_preserve"
    StrCpy $R9 "1"
  noData:
  StrCpy $R8 "0"
  IfFileExists "$INSTDIR\config.json" 0 noCfg
    CopyFiles /SILENT "$INSTDIR\config.json" "$TEMP"
    StrCpy $R8 "1"
  noCfg:

  ; ---------- 复制程序文件 ----------
  ; 两行都写：覆盖带扩展名 / 无扩展名文件（Cookies、Local State 等）
  ; 安全底线：改成「显式打包清单」，绝不使用 File /r "dist\*"
  ; —— 之前 /r 会把 dist\data 里的浏览器配置（含 DeepSeek 登录 Cookie）
  ;    和真实聊天记录 store.json 一起打进安装包，等于公开发布用户隐私。
  CreateDirectory "$INSTDIR\data"
  ; 注意：目录用 /r "dir"（不带通配）才会保留目录结构；带 * 会把文件拍平到根目录
  File /r "dist\server"
  File /r "dist\public"
  File /r "dist\assets"
  File /r "dist\desktop"
  ; 内置 QQ 监视器（NapCat 等）：存在才打进去，瘦包这里没有 dist\engine
  !if /FileExists "dist\engine"
    File /r "dist\engine"
  !endif
  ; 旧版独立的开启/关闭入口已合并进桌面宿主，升级时清理
  Delete "$INSTDIR\开启.bat"
  Delete "$INSTDIR\关闭.bat"
  File /nonfatal "dist\launcher.ps1"
  File /nonfatal "dist\config.json"
  ; 不再打包 dist\setup.nsi：那是打包脚本自己，用户拿到没用，
  ; 而且旧副本里还留着 File /r "dist\*" 这种会连隐私一起打进去的写法，纯属误导
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; ---------- 还原用户数据（包内 data 只是全新安装的种子） ----------
  StrCmp $R9 "0" keepSeed
    RMDir /r "$INSTDIR\data"
    Rename "$INSTDIR\data_preserve" "$INSTDIR\data"
  keepSeed:
  StrCmp $R8 "0" keepCfg
    CopyFiles /SILENT "$TEMP\config.json" "$INSTDIR"
    Delete "$TEMP\config.json"
  keepCfg:

  ; ---------- 注册表 ----------
  WriteRegStr HKCU "${REGKEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\assets\icon.ico"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "QunZai"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}.0"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1

  ; ---------- 快捷方式 ----------
  ; 桌面只保留主入口：服务启停已经整合进桌面宿主右上角。
  ; 先清掉旧版本创建的独立开启/关闭入口，再创建主快捷方式。
  Delete "$DESKTOP\群崽-开启.lnk"
  Delete "$DESKTOP\群崽-关闭.lnk"
  CreateShortCut "$DESKTOP\群崽 QunZai.lnk" "$INSTDIR\desktop\QunZaiHost.exe" "" "$INSTDIR\assets\icon.ico" 0

  ; 开始菜单只保留主程序与卸载
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  Delete "$SMPROGRAMS\${APPNAME}\开启 ${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\关闭 ${APPNAME}.lnk"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\启动 ${APPNAME}.lnk" "$INSTDIR\desktop\QunZaiHost.exe" "" "$INSTDIR\assets\icon.ico" 0
  CreateShortCut "$SMPROGRAMS\${APPNAME}\卸载 ${APPNAME}.lnk" "$INSTDIR\uninstall.exe" "" \
    "$INSTDIR\assets\icon.ico" 0

  ; 静默安装没有完成页，装完直接拉起新版本；交互安装仍由完成页启动。
  IfSilent 0 noAutoStart
    Exec '"$INSTDIR\desktop\QunZaiHost.exe"'
  noAutoStart:
SectionEnd

Section "Uninstall"
  ; 停掉正在跑的桌面宿主和服务
  nsExec::Exec 'taskkill /IM QunZaiHost.exe /F'
  Pop $0
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\launcher.ps1" -Stop' $0

  Delete "$DESKTOP\${APPNAME}.lnk"   ; 旧版应用快捷方式
  Delete "$DESKTOP\群崽 QunZai.lnk"
  Delete "$DESKTOP\群崽-开启.lnk"
  Delete "$DESKTOP\群崽-关闭.lnk"
  RMDir /r "$SMPROGRAMS\${APPNAME}"

  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "${REGKEY}"
SectionEnd






