' Silent: dashboard + auto-start wait worker
Option Explicit
Dim sh, fso, root, bat
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
bat = root & "\Start-Indus-With-Worker.bat"
If Not fso.FileExists(bat) Then
  MsgBox "Launcher not found:" & vbCrLf & bat, vbCritical, "Indus Web Reviewer"
  WScript.Quit 1
End If
sh.CurrentDirectory = fso.GetParentFolderName(root)
sh.Run """" & bat & """", 0, False
