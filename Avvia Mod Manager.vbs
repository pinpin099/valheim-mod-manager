Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
d = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = d
n = d & "\node.exe"
If Not fso.FileExists(n) Then n = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If fso.FileExists(n) And fso.FileExists(d & "\server.js") Then
  sh.Run """" & n & """ server.js", 0, False
Else
  MsgBox "Estrai prima tutta la cartella dallo zip, poi riprova.", 48, "Valheim Mod Manager"
End If
