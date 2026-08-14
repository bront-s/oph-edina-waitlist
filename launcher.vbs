' Silent launcher for the OPH Edina waitlist collector (no console window).
' The collector itself exits if another instance is already running (lockfile).
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Program Files\nodejs\node.exe"" ""C:\ucs-pipeline-data\oph-edina-waitlist\collector.mjs""", 0, False
