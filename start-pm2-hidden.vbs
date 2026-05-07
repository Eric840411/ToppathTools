Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d ""C:\Users\user\Desktop\Toppath tools"" && pm2 resurrect", 0, False
