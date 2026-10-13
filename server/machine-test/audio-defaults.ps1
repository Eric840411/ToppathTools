# Read the current Windows default playback / recording devices (v5.50.0, osm-qa-agent spec #11: recording diagnostics).
# Read-only, changes nothing. Prints one JSON line: {"render":{"name","id","why"},"capture":{...}}.
# Anything that cannot be read is null plus "why" -- never guessed.
#
# Why both: record-spin.ps1 records the DEFAULT RECORDING device via MCI. Switching playback to CABLE Input is only
# half of it; if the default recording device is not CABLE Output, the recording comes from somewhere else
# (e.g. a microphone) and a whole -70 dB take looks exactly like "the machine is silent".
# Uses Core Audio (IMMDeviceEnumerator.GetDefaultAudioEndpoint, role eConsole). The registry Role:0 values are
# not present on newer Windows (verified on this PC).
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a BOM-less .ps1 as the ANSI code page (cp950 here);
# a non-ASCII comment inside the C# block got mangled and swallowed the next line, so the type failed to compile.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AudioDefaults {
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr p, out IntPtr ppv);
    int OpenPropertyStore(int access, out IPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out int c);
    int GetAt(int i, out PropertyKey k);
    int GetValue(ref PropertyKey k, out PropVariant v);
  }
  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit)] struct PropVariant { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }

  // Returns "friendlyName<TAB>id", or "" when there is no default endpoint
  public static string Get(int flow) {
    IMMDeviceEnumerator e = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
    IMMDevice d;
    int hr = e.GetDefaultAudioEndpoint(flow, 0, out d);
    if (hr != 0 || d == null) return "";
    string id;
    d.GetId(out id);
    IPropertyStore s;
    d.OpenPropertyStore(0, out s);
    PropertyKey k = new PropertyKey();
    k.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
    k.pid = 14;
    PropVariant v;
    s.GetValue(ref k, out v);
    string name = (v.vt == 31) ? Marshal.PtrToStringUni(v.p) : null;
    return (name == null ? "" : name) + "\t" + id;
  }
}
'@
function Read-Default([int]$flow) {
  try {
    $r = [AudioDefaults]::Get($flow)
    if (-not $r) { return @{ name = $null; id = $null; why = 'no default endpoint' } }
    $parts = $r -split "`t", 2
    $n = $null
    if ($parts[0]) { $n = $parts[0] }
    return @{ name = $n; id = $parts[1]; why = $null }
  } catch {
    $m = ($_.Exception.Message -replace '\s+', ' ')
    return @{ name = $null; id = $null; why = $m.Substring(0, [Math]::Min(120, $m.Length)) }
  }
}
# dataFlow: 0 = eRender (playback), 1 = eCapture (recording)
Write-Output (ConvertTo-Json @{ render = (Read-Default 0); capture = (Read-Default 1) } -Compress)
