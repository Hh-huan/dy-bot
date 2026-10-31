' Hidden watchdog: keep the DY live companion bridge alive.
' Launched from the Windows Startup folder at login.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Do
  sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\start-bridge.ps1""", 0, True
  WScript.Sleep 60000
Loop
