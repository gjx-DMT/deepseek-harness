' launch.vbs - DeepSeek Harness GUI launcher
' Invokes launch.ps1 via PowerShell with no console window.
' The PowerShell script sets up PATH and starts Electron (GUI app, no console).

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' Resolve paths
guiDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript = guiDir & "\launch.ps1"

' Launch PowerShell hidden, no window, no wait
' -NoProfile: skip profile loading (faster)
' -ExecutionPolicy Bypass: allow running unsigned scripts
' -WindowStyle Hidden: no console window
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """", 0, False

Set shell = Nothing
Set fso = Nothing
