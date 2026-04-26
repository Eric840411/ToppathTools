param(
    [string]$OutFile = "C:\Users\user\AppData\Local\Temp\spinaudio.wav",
    [int]$DurationMs = 3000
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MCI {
    [DllImport("winmm.dll", CharSet=CharSet.Auto)]
    public static extern int mciSendString(string cmd, StringBuilder ret, int retLen, IntPtr hwnd);
}
'@

$sb = New-Object System.Text.StringBuilder 256
[MCI]::mciSendString('open new Type waveaudio Alias rec', $sb, 256, [IntPtr]::Zero) | Out-Null
[MCI]::mciSendString('set rec channels 2 bitspersample 16 samplespersec 44100', $sb, 256, [IntPtr]::Zero) | Out-Null
[MCI]::mciSendString('record rec', $sb, 256, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds $DurationMs
[MCI]::mciSendString('stop rec', $sb, 256, [IntPtr]::Zero) | Out-Null
$ret = [MCI]::mciSendString("save rec `"$OutFile`"", $sb, 256, [IntPtr]::Zero)
[MCI]::mciSendString('close rec', $sb, 256, [IntPtr]::Zero) | Out-Null

if ($ret -eq 0 -and (Test-Path $OutFile)) {
    Write-Output "OK:$OutFile"
} else {
    Write-Output "FAIL:$ret"
}
