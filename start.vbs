Option Explicit

Dim shell, files, appDir, distFile, electronExe, viteCmd, buildCommand, launchCommand, exitCode
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")

appDir = files.GetParentFolderName(WScript.ScriptFullName)
distFile = files.BuildPath(appDir, "dist\index.html")
electronExe = files.BuildPath(appDir, "node_modules\electron\dist\electron.exe")
viteCmd = files.BuildPath(appDir, "node_modules\.bin\vite.cmd")
shell.CurrentDirectory = appDir

If Not files.FileExists(electronExe) Then
  MsgBox "Electron wurde nicht gefunden. Bitte zuerst npm install ausführen.", 16, "Agent Teams"
  WScript.Quit 1
End If

If Not files.FileExists(distFile) Then
  buildCommand = "cmd.exe /d /s /c " & Chr(34) & Chr(34) & viteCmd & Chr(34) & " build" & Chr(34)
  exitCode = shell.Run(buildCommand, 0, True)
  If exitCode <> 0 Then
    MsgBox "Der Production-Build ist fehlgeschlagen.", 16, "Agent Teams"
    WScript.Quit exitCode
  End If
End If

If WScript.Arguments.Named.Exists("check") Then
  WScript.Echo "Agent Teams starter: OK"
  WScript.Quit 0
End If

launchCommand = Chr(34) & electronExe & Chr(34) & " " & Chr(34) & appDir & Chr(34)
' WScript itself has no console window. Electron must use a normal window style;
' style 0 would also hide the app's BrowserWindow.
shell.Run launchCommand, 1, False
