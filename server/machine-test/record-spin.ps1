param(
    [string]$OutFile = "C:\Users\user\AppData\Local\Temp\spinaudio.wav",
    [int]$DurationMs = 2500
)

# Record from default input device (CABLE Output when VB-Cable is set as default output)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WM {
    [DllImport("winmm.dll", CharSet=CharSet.Auto)]
    public static extern int mciSendString(string cmd, StringBuilder ret, int retLen, IntPtr hwnd);
}
'@

$sb = New-Object System.Text.StringBuilder 256
[WM]::mciSendString('open new Type waveaudio Alias rec', $sb, 256, [IntPtr]::Zero) | Out-Null
[WM]::mciSendString('set rec channels 2 bitspersample 16 samplespersec 44100', $sb, 256, [IntPtr]::Zero) | Out-Null
[WM]::mciSendString('record rec', $sb, 256, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds $DurationMs
[WM]::mciSendString('stop rec', $sb, 256, [IntPtr]::Zero) | Out-Null
$ret = [WM]::mciSendString("save rec `"$OutFile`"", $sb, 256, [IntPtr]::Zero)
[WM]::mciSendString('close rec', $sb, 256, [IntPtr]::Zero) | Out-Null

if ($ret -eq 0 -and (Test-Path $OutFile)) {
    Write-Output ("OK:" + $OutFile + ":" + (Get-Item $OutFile).Length)
} else {
    Write-Output ("FAIL:" + $ret)
}
