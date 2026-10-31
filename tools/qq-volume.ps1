# Read or set QQ Music app volume via Windows Core Audio session (does not affect other apps).
# Usage:
#   powershell -File tools/qq-volume.ps1 -Action get
#   powershell -File tools/qq-volume.ps1 -Action set -Volume 40
# Output: current volume percent on success; NO_SESSION when QQ Music has no audio session.
param(
  [ValidateSet('get', 'set')][string]$Action = 'get',
  [int]$Volume = -1
)

$ErrorActionPreference = 'Stop'

Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class QQVolume
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorComObject { }

    private enum EDataFlow { eRender = 0, eCapture, eAll }
    private enum ERole { eConsole = 0, eMultimedia, eCommunications }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, int dwStateMask, out IntPtr ppDevices);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr audioSessionGuid, int streamFlags, out IntPtr sessionControl);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr audioSessionGuid, int streamFlags, out IntPtr audioVolume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int sessionCount, out IAudioSessionControl session);
    }

    [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(out IntPtr name);
        [PreserveSig] int SetDisplayName(IntPtr name, ref Guid eventContext);
        [PreserveSig] int GetIconPath(out IntPtr path);
        [PreserveSig] int SetIconPath(IntPtr path, ref Guid eventContext);
        [PreserveSig] int GetGroupingParam(out Guid groupingParam);
        [PreserveSig] int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr newNotifications);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr newNotifications);
    }

    // Fully declare IAudioSessionControl2 vtable (base control methods + its own 5 methods)
    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(out IntPtr name);
        [PreserveSig] int SetDisplayName(IntPtr name, ref Guid eventContext);
        [PreserveSig] int GetIconPath(out IntPtr path);
        [PreserveSig] int SetIconPath(IntPtr path, ref Guid eventContext);
        [PreserveSig] int GetGroupingParam(out Guid groupingParam);
        [PreserveSig] int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr newNotifications);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr newNotifications);
        [PreserveSig] int GetSessionIdentifier(out IntPtr id);
        [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
        [PreserveSig] int GetProcessId(out uint processId);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference(bool optOut);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, ref Guid eventContext);
        [PreserveSig] int GetMasterVolume(out float level);
    }

    private static bool IsQQMusic(uint pid)
    {
        if (pid == 0) return false;
        try
        {
            return Process.GetProcessById((int)pid).ProcessName.Equals("QQMusic", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static IAudioSessionEnumerator GetSessions()
    {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device) != 0) return null;
        var iid = typeof(IAudioSessionManager2).GUID;
        object managerObject;
        if (device.Activate(ref iid, 0, IntPtr.Zero, out managerObject) != 0) return null;
        var manager = (IAudioSessionManager2)managerObject;
        IAudioSessionEnumerator sessions;
        if (manager.GetSessionEnumerator(out sessions) != 0) return null;
        return sessions;
    }

    public static int Get()
    {
        var sessions = GetSessions();
        if (sessions == null) return -1;
        int count;
        if (sessions.GetCount(out count) != 0) return -1;
        for (int i = 0; i < count; i++)
        {
            IAudioSessionControl control;
            if (sessions.GetSession(i, out control) != 0) continue;
            var control2 = (IAudioSessionControl2)control;
            uint pid;
            if (control2.GetProcessId(out pid) != 0 || !IsQQMusic(pid)) continue;
            var volume = (ISimpleAudioVolume)control;
            float level;
            if (volume.GetMasterVolume(out level) != 0) continue;
            return (int)Math.Round(level * 100);
        }
        return -1;
    }

    public static int Set(int percent)
    {
        var sessions = GetSessions();
        if (sessions == null) return -1;
        int count;
        if (sessions.GetCount(out count) != 0) return -1;
        float level = Math.Max(0, Math.Min(100, percent)) / 100f;
        var context = Guid.Empty;
        int changed = 0;
        for (int i = 0; i < count; i++)
        {
            IAudioSessionControl control;
            if (sessions.GetSession(i, out control) != 0) continue;
            var control2 = (IAudioSessionControl2)control;
            uint pid;
            if (control2.GetProcessId(out pid) != 0 || !IsQQMusic(pid)) continue;
            var volume = (ISimpleAudioVolume)control;
            if (volume.SetMasterVolume(level, ref context) == 0) changed++;
        }
        if (changed == 0) return -1;
        return (int)Math.Round(level * 100);
    }
}
"@

if ($Action -eq 'get') {
  $value = [QQVolume]::Get()
  if ($value -lt 0) {
    Write-Output 'NO_SESSION'
    exit 1
  }
  Write-Output $value
  exit 0
}

if ($Volume -lt 0) {
  Write-Output 'INVALID'
  exit 1
}

$value = [QQVolume]::Set($Volume)
if ($value -lt 0) {
  Write-Output 'NO_SESSION'
  exit 1
}
Write-Output $value
