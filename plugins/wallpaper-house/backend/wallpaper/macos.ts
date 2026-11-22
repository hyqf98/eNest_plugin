import type { CurrentWallpaper, DisplayInfo, SetWallpaperResult, WallpaperFit } from '@backend/contracts'
import { fail } from '@backend/util'
import { execFile } from '../exec'

const LIST_SCRIPT = String.raw`
function run() {
  try {
    ObjC.import('AppKit');
    const screens = $.NSScreen.screens;
    const rows = [];
    for (let i = 0; i < screens.count; i++) {
      const frame = screens.objectAtIndex(i).frame;
      rows.push({ index: i, width: Number(frame.size.width), height: Number(frame.size.height), primary: i === 0 });
    }
    return JSON.stringify({ ok: true, screens: rows });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}
`

const SET_SCRIPT = String.raw`
function run(argv) {
  const path = argv[0];
  const fit = argv[1] || 'fill';
  const monitor = argv[2] || 'all';
  try {
    if (fit === 'tile' || fit === 'span') throw new Error('macOS 不支持 ' + fit + ' 填充方式');
    ObjC.import('AppKit');
    const ws = $.NSWorkspace.sharedWorkspace;
    const screens = $.NSScreen.screens;
    const options = $.NSMutableDictionary.dictionary;
    try {
      const scaling = fit === 'fit' ? 0 : fit === 'stretch' ? 1 : fit === 'center' ? 3 : 2;
      if ($.NSWorkspaceDesktopImageScalingKey) {
        options.setObjectForKey($.NSNumber.numberWithInteger(scaling), $.NSWorkspaceDesktopImageScalingKey);
      }
      if ($.NSWorkspaceDesktopImageAllowClippingKey) {
        const clip = fit !== 'fit' && fit !== 'center';
        options.setObjectForKey($.NSNumber.numberWithBool(clip), $.NSWorkspaceDesktopImageAllowClippingKey);
      }
    } catch (_) {}
    const url = $.NSURL.fileURLWithPath(path);
    let count = 0;
    for (let i = 0; i < screens.count; i++) {
      if (monitor !== 'all' && String(i) !== String(monitor)) continue;
      const screen = screens.objectAtIndex(i);
      const ok = ws.setDesktopImageURLForScreenOptionsError(url, screen, options, null);
      if (!ok) throw new Error('设置显示器 ' + (i + 1) + ' 失败');
      count++;
    }
    return JSON.stringify({ ok: true, count: count });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}
`

const CURRENT_SCRIPT = String.raw`
function run() {
  try {
    ObjC.import('AppKit');
    const ws = $.NSWorkspace.sharedWorkspace;
    const screens = $.NSScreen.screens;
    const rows = [];
    for (let i = 0; i < screens.count; i++) {
      const screen = screens.objectAtIndex(i);
      const url = ws.desktopImageURLForScreen(screen);
      const path = url && url.path ? ObjC.unwrap(url.path) : '';
      rows.push({ index: i, path: path });
    }
    return JSON.stringify({ ok: true, rows: rows });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}
`

export async function macosListDisplays(): Promise<DisplayInfo[]> {
  const result = await runJxa(LIST_SCRIPT)
  const screens = Array.isArray(result.screens) ? result.screens : []
  return screens.map((screen, index) => {
    const record = screen && typeof screen === 'object' ? screen as Record<string, unknown> : {}
    return {
      id: String(index),
      index,
      name: `显示器 ${index + 1}`,
      width: Number(record.width) || 0,
      height: Number(record.height) || 0,
      primary: record.primary === true,
    }
  })
}

export async function macosSetStatic(path: string, fit: WallpaperFit, monitorIndex: number | null): Promise<SetWallpaperResult> {
  const result = await runJxa(SET_SCRIPT, [path, fit, monitorIndex == null ? 'all' : String(monitorIndex)])
  if (result.ok !== true) fail('WALLPAPER_SET_FAILED', typeof result.error === 'string' ? result.error : 'macOS 壁纸设置失败')
  const displays = await macosListDisplays().catch(() => [])
  const applied = monitorIndex == null ? displays : displays.filter(display => display.index === monitorIndex)
  return {
    ok: true,
    applied: (applied.length ? applied : [{ id: String(monitorIndex ?? 0), index: monitorIndex ?? 0, name: '', width: 0, height: 0, primary: false }])
      .map(display => ({ displayId: display.id, path })),
  }
}

export async function macosCurrentWallpapers(): Promise<CurrentWallpaper[]> {
  const result = await runJxa(CURRENT_SCRIPT)
  const rows = Array.isArray(result.rows) ? result.rows : []
  return rows.map((row, index) => {
    const record = row && typeof row === 'object' ? row as Record<string, unknown> : {}
    return { displayId: String(record.index ?? index), path: typeof record.path === 'string' ? record.path : '' }
  })
}

async function runJxa(script: string, args: string[] = []): Promise<Record<string, unknown>> {
  const { stdout } = await execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, '--', ...args], {
    timeoutMs: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  const trimmed = stdout.trim()
  const start = trimmed.indexOf('{')
  if (start < 0) fail('WALLPAPER_SET_FAILED', trimmed.slice(0, 500) || 'osascript 没有返回结果')
  try {
    return JSON.parse(trimmed.slice(start)) as Record<string, unknown>
  } catch {
    fail('WALLPAPER_SET_FAILED', trimmed.slice(0, 500) || 'osascript 返回结果无法解析')
  }
}
