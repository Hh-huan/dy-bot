param(
  [ValidateSet('playpause', 'next', 'prev', 'stop')]
  [string]$Action = 'playpause'
)

$source = @'
using System;
using System.Runtime.InteropServices;

public static class DshMediaKeys
{
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    public static void Press(byte vk)
    {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, 2, UIntPtr.Zero);
    }
}
'@

Add-Type -TypeDefinition $source -ErrorAction Stop
$keys = @{ playpause = 0xB3; next = 0xB0; prev = 0xB1; stop = 0xB2 }
[DshMediaKeys]::Press([byte]$keys[$Action])
