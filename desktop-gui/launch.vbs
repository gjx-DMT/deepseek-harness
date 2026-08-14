' launch.vbs - DeepSeek Harness GUI launcher
' Avoids batch file encoding issues with Unicode paths.
' Uses WScript.Shell to set up environment and launch Electron.

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' Resolve paths relative to this script
guiDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(guiDir)
parentDir = fso.GetParentFolderName(rootDir)

portableNodeDir = parentDir & "\node-v22.19.0-win-x64"
portableGitDir = parentDir & "\portablegit\cmd"

' Build PATH: portable node + portable git + system PATH
currentPath = shell.Environment("Process").Item("PATH")
newPath = ""
If fso.FileExists(portableNodeDir & "\node.exe") Then
    newPath = portableNodeDir
End If
If fso.FileExists(portableGitDir & "\git.exe") Then
    If Len(newPath) > 0 Then newPath = newPath & ";"
    newPath = newPath & portableGitDir
End If
If Len(newPath) > 0 Then
    newPath = newPath & ";" & currentPath
Else
    newPath = currentPath
End If

shell.Environment("Process").Item("PATH") = newPath

' Verify Node.js exists
nodeExe = "node"
If fso.FileExists(portableNodeDir & "\node.exe") Then
    nodeExe = Chr(34) & portableNodeDir & "\node.exe" & Chr(34)
End If

' Verify Electron is installed
electronCli = guiDir & "\node_modules\electron\cli.js"
If Not fso.FileExists(electronCli) Then
    ' Try to install Electron
    shell.CurrentDirectory = guiDir
    shell.Run nodeExe & " """ & portableNodeDir & "\node_modules\npm\bin\npm-cli.js"" install electron", 1, True
End If

' Launch Electron
shell.CurrentDirectory = guiDir
shell.Run nodeExe & " """ & electronCli & """ .", 1, False

Set shell = Nothing
Set fso = Nothing
