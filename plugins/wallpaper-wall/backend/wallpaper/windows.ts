import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CurrentWallpaper, DisplayInfo, SetWallpaperResult, WallpaperFit } from '@backend/contracts'
import { ensurePluginPaths } from '@backend/paths'
import { fail } from '@backend/util'
import { execFile } from '../exec'

/** PowerShell 脚本只接收请求文件路径，壁纸路径与参数不拼接进命令行。 */
export const WINDOWS_SET_SCRIPT = String.raw`
param([Parameter(Mandatory = $true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("C2CF3110-460C-4FB1-B8D6-7C79F94BB203"), ClassInterface(ClassInterfaceType.None)]
public class DesktopWallpaperClass { }

[ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDesktopWallpaper {
    [PreserveSig] int SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
    [PreserveSig] int GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] out string wallpaper);
    [PreserveSig] int GetMonitorDevicePathAt(uint monitorIndex, [MarshalAs(UnmanagedType.LPWStr)] out string monitorID);
    [PreserveSig] int GetMonitorDevicePathCount(out uint count);
    [PreserveSig] int GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID, out RECT displayRect);
    [PreserveSig] int SetBackgroundColor(uint color);
    [PreserveSig] int GetBackgroundColor(out uint color);
    [PreserveSig] int SetPosition(int position);
    [PreserveSig] int GetPosition(out int position);
}

public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

public static class WallpaperApi {
    public static string[] List() {
        var dw = (IDesktopWallpaper)new DesktopWallpaperClass();
        uint count;
        int hr = dw.GetMonitorDevicePathCount(out count);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        var rows = new string[count];
        for (uint i = 0; i < count; i++) {
            string id;
            hr = dw.GetMonitorDevicePathAt(i, out id);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            RECT rect;
            dw.GetMonitorRECT(id, out rect);
            rows[i] = i + "|" + id + "|" + rect.Left + "|" + rect.Top + "|" + rect.Right + "|" + rect.Bottom;
        }
        return rows;
    }

    public static string Set(string path, int position, int monitorIndex) {
        var dw = (IDesktopWallpaper)new DesktopWallpaperClass();
        int hr = dw.SetPosition(position);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        uint count;
        hr = dw.GetMonitorDevicePathCount(out count);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        if (count == 0) throw new InvalidOperationException("没有可用的显示器");
        if (monitorIndex >= 0) {
            if ((uint)monitorIndex >= count) throw new ArgumentOutOfRangeException("monitorIndex");
            string id;
            hr = dw.GetMonitorDevicePathAt((uint)monitorIndex, out id);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            hr = dw.SetWallpaper(id, path);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        } else {
            for (uint i = 0; i < count; i++) {
                string id;
                hr = dw.GetMonitorDevicePathAt(i, out id);
                if (hr != 0) Marshal.ThrowExceptionForHR(hr);
                hr = dw.SetWallpaper(id, path);
                if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            }
        }
        return "ok";
    }

    public static string Get(int monitorIndex) {
        var dw = (IDesktopWallpaper)new DesktopWallpaperClass();
        string id;
        int hr = dw.GetMonitorDevicePathAt((uint)monitorIndex, out id);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        string path;
        hr = dw.GetWallpaper(id, out path);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        return path ?? "";
    }
}
'@
$path = [System.IO.Path]::GetFullPath([string]$request.path)
if (-not [System.IO.File]::Exists($path)) { throw "壁纸文件不存在: $path" }
$position = switch ([string]$request.fit) {
  'center' { 0 }
  'tile' { 1 }
  'stretch' { 2 }
  'fit' { 3 }
  'span' { 5 }
  default { 4 }
}
$monitor = if ($null -eq $request.monitorIndex) { -1 } else { [int]$request.monitorIndex }
try {
  $result = [WallpaperApi]::Set($path, $position, $monitor)
  @{ ok = $true; result = $result; monitors = @([WallpaperApi]::List()) } | ConvertTo-Json -Depth 4 -Compress
} catch {
  $comError = $_.Exception.Message
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class NativeWallpaper {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
'@
  $style = switch ([string]$request.fit) {
    'center' { @{ style = '0'; tile = '0' } }
    'tile' { @{ style = '0'; tile = '1' } }
    'stretch' { @{ style = '2'; tile = '0' } }
    'fit' { @{ style = '6'; tile = '0' } }
    'span' { @{ style = '22'; tile = '0' } }
    default { @{ style = '10'; tile = '0' } }
  }
  Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name WallpaperStyle -Value $style.style
  Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name TileWallpaper -Value $style.tile
  $ok = [NativeWallpaper]::SystemParametersInfo(0x0014, 0, $path, 3) -ne 0
  if (-not $ok) {
    @{ ok = $false; error = $comError } | ConvertTo-Json -Depth 3 -Compress
    exit 1
  }
  @{ ok = $true; result = 'fallback'; fallback = $true; monitors = @(); note = 'IDesktopWallpaper 不可用，已用 SystemParametersInfo 应用到全部显示器' } | ConvertTo-Json -Depth 4 -Compress
}
`

export const WINDOWS_LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("C2CF3110-460C-4FB1-B8D6-7C79F94BB203"), ClassInterface(ClassInterfaceType.None)]
public class DesktopWallpaperClass { }
[ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDesktopWallpaper {
    [PreserveSig] int SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
    [PreserveSig] int GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] out string wallpaper);
    [PreserveSig] int GetMonitorDevicePathAt(uint monitorIndex, [MarshalAs(UnmanagedType.LPWStr)] out string monitorID);
    [PreserveSig] int GetMonitorDevicePathCount(out uint count);
    [PreserveSig] int GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID, out RECT displayRect);
    [PreserveSig] int SetBackgroundColor(uint color);
    [PreserveSig] int GetBackgroundColor(out uint color);
    [PreserveSig] int SetPosition(int position);
    [PreserveSig] int GetPosition(out int position);
}
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public static class WallpaperApi {
    public static string[] List() {
        var dw = (IDesktopWallpaper)new DesktopWallpaperClass();
        uint count;
        int hr = dw.GetMonitorDevicePathCount(out count);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        var rows = new string[count];
        for (uint i = 0; i < count; i++) {
            string id;
            hr = dw.GetMonitorDevicePathAt(i, out id);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            RECT rect;
            dw.GetMonitorRECT(id, out rect);
            rows[i] = i + "|" + id + "|" + rect.Left + "|" + rect.Top + "|" + rect.Right + "|" + rect.Bottom;
        }
        return rows;
    }
    public static string Get(int monitorIndex) {
        var dw = (IDesktopWallpaper)new DesktopWallpaperClass();
        string id;
        int hr = dw.GetMonitorDevicePathAt((uint)monitorIndex, out id);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        string path;
        hr = dw.GetWallpaper(id, out path);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        return path ?? "";
    }
}
'@
`

export const WINDOWS_SCREEN_LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$index = 0
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
  $bounds = $screen.Bounds
  Write-Output ("{0}|{1}|{2}|{3}|{4}|{5}" -f $index, $screen.DeviceName, $bounds.Left, $bounds.Top, $bounds.Right, $bounds.Bottom)
  $index++
}
`

export const WINDOWS_CURRENT_FALLBACK_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$value = (Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name Wallpaper -ErrorAction SilentlyContinue).Wallpaper
if ($value) { Write-Output ("0|" + $value) }
`

export function buildWindowsSetRequest(path: string, fit: WallpaperFit, monitorIndex: number | null): string {
  return JSON.stringify({ path, fit, monitorIndex })
}

export async function runPowerShell(script: string, extraArgs: string[] = [], timeoutMs = 30_000): Promise<string> {
  const paths = await ensurePluginPaths()
  const scriptFile = join(paths.cache, `wallpaper-wall-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`)
  await writeFile(scriptFile, `\uFEFF${script}`, 'utf8')
  try {
    const { stdout } = await execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptFile,
      ...extraArgs,
    ], { timeoutMs, maxBuffer: 2 * 1024 * 1024 })
    return stdout
  } finally {
    await rm(scriptFile, { force: true }).catch(() => {})
  }
}

export async function windowsListDisplays(): Promise<DisplayInfo[]> {
  try {
    const stdout = await runPowerShell(`${WINDOWS_LIST_SCRIPT}\n[WallpaperApi]::List()`)
    const displays = parseWindowsMonitorLines(stdout)
    if (displays.length) return displays
    throw new Error('IDesktopWallpaper 没有返回显示器')
  } catch {
    const stdout = await runPowerShell(WINDOWS_SCREEN_LIST_SCRIPT)
    return parseWindowsMonitorLines(stdout)
  }
}

export async function windowsSetStatic(path: string, fit: WallpaperFit, monitorIndex: number | null): Promise<SetWallpaperResult> {
  const paths = await ensurePluginPaths()
  const requestFile = join(paths.cache, `wallpaper-request-${process.pid}-${Date.now()}.json`)
  await writeFile(requestFile, buildWindowsSetRequest(path, fit, monitorIndex), 'utf8')
  try {
    const stdout = await runPowerShell(WINDOWS_SET_SCRIPT, ['-RequestPath', requestFile])
    const parsed = parseWindowsResult(stdout)
    if (!parsed.ok) fail('WALLPAPER_SET_FAILED', parsed.error || 'Windows 壁纸设置失败')
    const displays = parsed.monitors.length ? parseWindowsMonitorLines(parsed.monitors.join('\n')) : await windowsListDisplays()
    const selected = monitorIndex == null ? displays : displays.filter(display => display.index === monitorIndex)
    return {
      ok: true,
      applied: (selected.length ? selected : displays).map(display => ({
        displayId: String(display.index),
        path,
      })),
      message: parsed.note,
    }
  } finally {
    await rm(requestFile, { force: true }).catch(() => {})
  }
}

export async function windowsCurrentWallpapers(): Promise<CurrentWallpaper[]> {
  let stdout: string
  try {
    stdout = await runPowerShell(WINDOWS_LIST_SCRIPT + String.raw`
$rows = [WallpaperApi]::List()
foreach ($row in $rows) {
  $parts = $row -split '\|'
  $path = [WallpaperApi]::Get([int]$parts[0])
  Write-Output ("{0}|{1}" -f $parts[0], $path)
}
`)
  } catch {
    stdout = await runPowerShell(WINDOWS_CURRENT_FALLBACK_SCRIPT)
  }
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [displayId, ...rest] = line.split('|')
      return { displayId: displayId || '', path: rest.join('|') }
    })
}

export function parseWindowsMonitorLines(output: string): DisplayInfo[] {
  const rows = typeof output === 'string' ? output.split(/\r?\n/) : []
  return rows
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [indexText, deviceId, leftText, topText, rightText, bottomText] = line.split('|')
      const index = Number(indexText)
      const left = Number(leftText)
      const top = Number(topText)
      const right = Number(rightText)
      const bottom = Number(bottomText)
      if (!Number.isSafeInteger(index) || !Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) return null
      const width = Math.max(0, right - left)
      const height = Math.max(0, bottom - top)
      return {
        id: String(index),
        index,
        name: `显示器 ${index + 1}`,
        width,
        height,
        primary: left === 0 && top === 0,
        ...(deviceId ? { deviceId } : {}),
      } as DisplayInfo & { deviceId?: string }
    })
    .filter((display): display is DisplayInfo & { deviceId?: string } => Boolean(display))
}

function parseWindowsResult(output: string): { ok: boolean; error?: string; note?: string; monitors: string[] } {
  const trimmed = output.trim()
  const start = trimmed.indexOf('{')
  if (start < 0) return { ok: false, error: trimmed.slice(0, 500), monitors: [] }
  try {
    const parsed = JSON.parse(trimmed.slice(start)) as { ok?: boolean; error?: string; note?: string; monitors?: unknown }
    return {
      ok: parsed.ok === true,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      note: typeof parsed.note === 'string' ? parsed.note : undefined,
      monitors: Array.isArray(parsed.monitors) ? parsed.monitors.filter((row): row is string => typeof row === 'string') : [],
    }
  } catch {
    return { ok: false, error: trimmed.slice(0, 500), monitors: [] }
  }
}
