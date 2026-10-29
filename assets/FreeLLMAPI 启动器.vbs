' FreeLLMAPI launcher (desktop entry)
' Double-click -> runs launcher.ps1 with a hidden PowerShell window -> control panel pops up.
' This copy is bundled into the novel proofreading workbench.
Option Explicit

Dim fso, sh, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

ps1 = sh.ExpandEnvironmentStrings("%USERPROFILE%\freellmapi\launcher.ps1")

If Not fso.FileExists(ps1) Then
    MsgBox "Launcher script not found:" & vbCrLf & ps1, 16, "FreeLLMAPI"
    WScript.Quit 1
End If

sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -NonInteractive -File """ & ps1 & """", 0, False
Set sh = Nothing
Set fso = Nothing
