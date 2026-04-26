param(
    [string]$DeviceName,
    [switch]$GetCurrent
)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int NotImpl1();
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    int NotImpl2();
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    [PreserveSig] int Activate(ref Guid id, int clsCtx, IntPtr activationParams, out object inter);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore props);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int NotImpl1();
}

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetAt(int prop, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    int NotImpl1();
    int NotImpl2();
}

[StructLayout(LayoutKind.Sequential)]
public struct PropertyKey {
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Explicit)]
public struct PropVariant {
    [FieldOffset(0)] public short vt;
    [FieldOffset(8)] public IntPtr pointerVal;
    [FieldOffset(8)] public byte byteVal;
    [FieldOffset(8)] public long longVal;
    [FieldOffset(8)] public short boolVal;
}

[ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
    int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4();
    int NotImpl5(); int NotImpl6(); int NotImpl7(); int NotImpl8();
    int NotImpl9(); int NotImpl10();
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string devId, int role);
    int NotImpl11();
}

[ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
class CPolicyConfigClient {}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator {}

public class AudioRouter {
    static Guid PKEY_Device_FriendlyName_Guid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
    const int PKEY_Device_FriendlyName_Pid = 14;
    const int eRender = 0, eCapture = 1, eAll = 2;
    const int DEVICE_STATE_ACTIVE = 1;

    public static string GetDefaultOutputDevice() {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        enumerator.GetDefaultAudioEndpoint(eRender, 0, out device);
        string id; device.GetId(out id);
        return id;
    }

    public static string FindDeviceByName(string name) {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDeviceCollection col;
        enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col);
        int count; col.GetCount(out count);
        for (int i = 0; i < count; i++) {
            IMMDevice d; col.Item(i, out d);
            IPropertyStore ps; d.OpenPropertyStore(0, out ps);
            var key = new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
            PropVariant val; ps.GetValue(ref key, out val);
            if (val.pointerVal != IntPtr.Zero) {
                string label = Marshal.PtrToStringUni(val.pointerVal);
                if (label != null && label.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0) {
                    string id; d.GetId(out id); return id;
                }
            }
        }
        return null;
    }

    public static void SetDefaultOutput(string devId) {
        var config = (IPolicyConfig)new CPolicyConfigClient();
        for (int role = 0; role <= 2; role++) config.SetDefaultEndpoint(devId, role);
    }
}
'@

if ($GetCurrent) {
    Write-Output ([AudioRouter]::GetDefaultOutputDevice())
} else {
    $devId = [AudioRouter]::FindDeviceByName($DeviceName)
    if ($devId) {
        [AudioRouter]::SetDefaultOutput($devId)
        Write-Output "OK:$devId"
    } else {
        Write-Output "NOTFOUND"
    }
}
