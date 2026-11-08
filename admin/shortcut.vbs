Option Explicit
' QunZai Site Admin - create a desktop shortcut pointing to start.vbs
' Keep this file pure ASCII: WSH reads .vbs as ANSI, not UTF-8.
Dim sh, fso, adminDir, rootDir, vbsTarget, ico, desk, lnk, nm
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
adminDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir  = fso.GetParentFolderName(adminDir)
vbsTarget = adminDir & "\start.vbs"
ico = rootDir & "\app\assets\icon.ico"
desk = sh.SpecialFolders("Desktop")
' Chinese shortcut name: 群崽官网后台
nm = ChrW(&H7FA4) & ChrW(&H5D3D) & ChrW(&H5B98) & ChrW(&H7F51) & ChrW(&H540E) & ChrW(&H53F0)
Set lnk = sh.CreateShortcut(desk & "\" & nm & ".lnk")
lnk.TargetPath = vbsTarget
lnk.WorkingDirectory = adminDir
If fso.FileExists(ico) Then lnk.IconLocation = ico & ",0"
lnk.Description = "QunZai Site Admin - edit site content and publish"
lnk.Save
WScript.Echo "OK: " & desk & "\" & nm & ".lnk"
