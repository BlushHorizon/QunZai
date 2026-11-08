Option Explicit
Dim fso, sh, base, nodeExe, nodePath, cmdLine, url, alive, http, dbg, q
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
q   = Chr(34)
base = fso.GetParentFolderName(WScript.ScriptFullName)
url  = "http://127.0.0.1:8899/"
dbg  = False
If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "noopen" Then dbg = True
End If

' ---- already running? ServerXMLHTTP bypasses the IE/WinINET proxy ----
alive = False
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
If Err.Number <> 0 Then
  Err.Clear
  Set http = CreateObject("MSXML2.ServerXMLHTTP")
End If
If Err.Number = 0 Then
  http.SetTimeouts 1000, 1000, 1000, 4000
  http.Open "GET", url & "api/state", False
  http.SetRequestHeader "Cache-Control", "no-cache"
  http.Send
  If Err.Number = 0 Then
    If http.Status >= 200 And http.Status < 400 Then alive = True
  End If
End If
Err.Clear
On Error GoTo 0

If alive Then
  If Not dbg Then sh.Run "cmd /c start " & q & q & " " & q & url & q, 0, False
  WScript.Quit 0
End If

' ---- locate node.exe ----
nodeExe = ""
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
  nodeExe = "C:\Program Files\nodejs\node.exe"
ElseIf fso.FileExists("C:\Program Files (x86)\nodejs\node.exe") Then
  nodeExe = "C:\Program Files (x86)\nodejs\node.exe"
Else
  nodePath = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe"
  If fso.FileExists(nodePath) Then nodeExe = nodePath
End If
If nodeExe = "" Then
  MsgBox "node.exe not found." & vbCrLf & vbCrLf & _
         "Install Node.js from https://nodejs.org first, then run this again.", _
         16, "QunZai Site Admin"
  WScript.Quit 1
End If

' ---- start the server hidden (no console window) ----
cmdLine = q & nodeExe & q & " " & q & base & "\server.js" & q & " --no-open"
sh.CurrentDirectory = base
sh.Run cmdLine, 0, False
WScript.Sleep 1500
If Not dbg Then sh.Run "cmd /c start " & q & q & " " & q & url & q, 0, False
