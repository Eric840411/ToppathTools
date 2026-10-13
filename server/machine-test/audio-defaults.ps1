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
# -SimulateHr: test hook only (see probe). 0 = normal run.
param([int]$SimulateHr = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AudioDefaults {
  // [PreserveSig]: the int return is the native HRESULT (without it .NET rewrites the signature and the int is not an HRESULT).
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr p, out IntPtr ppv);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out int c);
    [PreserveSig] int GetAt(int i, out PropertyKey k);
    [PreserveSig] int GetValue(ref PropertyKey k, out PropVariant v);
  }
  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid fmtid; public int pid; }
  // Full PROPVARIANT: vt (2) + 3 reserved WORDs (6) + 16-byte union = 24 bytes on x64 (16 on x86). The union is padded
  // with two pointer-sized fields so GetValue never writes past the struct.
  [StructLayout(LayoutKind.Sequential)] struct PropVariant { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant v);

  static void Check(int hr, string what) { if (hr != 0) throw new Exception(what + " HRESULT 0x" + hr.ToString("X8")); }

  // Returns "friendlyName<TAB>id", or "" when there is no default endpoint
  // simulateHr: test hook only (0 = real call). Lets the probe check that a non-E_NOTFOUND failure keeps its HRESULT.
  public static string Get(int flow, int simulateHr) {
    IMMDevice d = null;
    int hr;
    if (simulateHr != 0) { hr = simulateHr; }
    else { IMMDeviceEnumerator e = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom(); hr = e.GetDefaultAudioEndpoint(flow, 0, out d); }
    // Only E_NOTFOUND (0x80070490) means "there is no default endpoint". Any other failure also leaves d == null,
    // so check hr BEFORE looking at d, otherwise e.g. E_OUTOFMEMORY would be reported as "no default endpoint".
    if (hr == unchecked((int)0x80070490)) return "";
    Check(hr, "GetDefaultAudioEndpoint");
    if (d == null) throw new Exception("GetDefaultAudioEndpoint returned S_OK but no device");
    string id;
    Check(d.GetId(out id), "GetId");
    IPropertyStore s;
    Check(d.OpenPropertyStore(0, out s), "OpenPropertyStore");
    PropertyKey k = new PropertyKey();
    k.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
    k.pid = 14;
    PropVariant v = new PropVariant();
    Check(s.GetValue(ref k, out v), "GetValue");
    string name = null;
    try { if (v.vt == 31) name = Marshal.PtrToStringUni(v.p); } finally { PropVariantClear(ref v); }
    return (name == null ? "" : name) + "\t" + id;
  }
}
'@
function Read-Default([int]$flow) {
  try {
    $r = [AudioDefaults]::Get($flow, $SimulateHr)
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
