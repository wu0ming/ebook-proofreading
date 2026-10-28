Option Explicit

Dim fso, sh, root, serverJs, nodeExe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
serverJs = fso.BuildPath(root, "server.js")
nodeExe = "C:\Users\12196\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

If Not fso.FileExists(nodeExe) Then
    nodeExe = "C:\Program Files\nodejs\node.exe"
End If

If Not fso.FileExists(nodeExe) Then
    MsgBox "Node.js not found.", 16, "小说校对工作台"
    WScript.Quit 1
End If

If Not fso.FileExists(serverJs) Then
    MsgBox "server.js not found:" & vbCrLf & serverJs, 16, "小说校对工作台"
    WScript.Quit 1
End If

sh.Run """" & nodeExe & """ """ & serverJs & """", 0, False
WScript.Sleep 1200
sh.Run "http://127.0.0.1:3210", 1, False

Set sh = Nothing
Set fso = Nothing
