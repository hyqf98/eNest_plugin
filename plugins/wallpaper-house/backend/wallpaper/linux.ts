import { spawn, type ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import type { CurrentWallpaper, DisplayInfo, SetWallpaperResult, WallpaperFit } from '@backend/contracts'
import { trackProcess, untrackProcess } from '@backend/runtime'
import { fail } from '@backend/util'
import { execFile } from '../exec'

export interface LinuxSession {
  desktop: string
  wayland: boolean
  kind: 'gnome' | 'cinnamon' | 'mate' | 'kde' | 'xfce' | 'wlroots' | 'x11' | 'unknown'
  label: string
}

export function detectLinuxSession(env: NodeJS.ProcessEnv = process.env): LinuxSession {
  const desktop = `${env.XDG_CURRENT_DESKTOP || ''} ${env.DESKTOP_SESSION || ''}`.toLowerCase()
  const wayland = Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === 'wayland'
  const wlroots = Boolean(env.SWAYSOCK || env.HYPRLAND_INSTANCE_SIGNATURE) || /sway|hyprland/.test(desktop)
  let kind: LinuxSession['kind'] = 'unknown'
  if (/gnome|unity/.test(desktop)) kind = 'gnome'
  else if (/cinnamon/.test(desktop)) kind = 'cinnamon'
  else if (/mate/.test(desktop)) kind = 'mate'
  else if (/kde|plasma/.test(desktop)) kind = 'kde'
  else if (/xfce/.test(desktop)) kind = 'xfce'
  else if (wlroots) kind = 'wlroots'
  else if (env.DISPLAY) kind = 'x11'
  return {
    desktop: desktop.trim(),
    wayland,
    kind,
    label: `${kind === 'unknown' ? '未知桌面' : kind} (${wayland ? 'Wayland' : 'X11'})`,
  }
}

const GNOME_FITS: Record<WallpaperFit, string> = {
  fill: 'zoom',
  fit: 'scaled',
  stretch: 'stretched',
  center: 'centered',
  tile: 'wallpaper',
  span: 'spanned',
}

export function gnomeCommands(path: string, fit: WallpaperFit, dark: boolean): Array<{ command: string; args: string[] }> {
  const uri = pathToFileURL(path).toString()
  const schema = dark ? 'org.gnome.desktop.background' : 'org.gnome.desktop.background'
  return [
    { command: 'gsettings', args: ['set', schema, 'picture-uri', uri] },
    { command: 'gsettings', args: ['set', schema, 'picture-uri-dark', uri] },
    { command: 'gsettings', args: ['set', schema, 'picture-options', GNOME_FITS[fit]] },
  ]
}

export function cinnamonCommands(path: string, fit: WallpaperFit): Array<{ command: string; args: string[] }> {
  const uri = pathToFileURL(path).toString()
  return [
    { command: 'gsettings', args: ['set', 'org.cinnamon.desktop.background', 'picture-uri', uri] },
    { command: 'gsettings', args: ['set', 'org.cinnamon.desktop.background', 'picture-options', GNOME_FITS[fit]] },
  ]
}

export function mateCommands(path: string, fit: WallpaperFit): Array<{ command: string; args: string[] }> {
  return [
    { command: 'gsettings', args: ['set', 'org.mate.background', 'picture-filename', path] },
    { command: 'gsettings', args: ['set', 'org.mate.background', 'picture-options', GNOME_FITS[fit]] },
  ]
}

export function fehArgs(fit: WallpaperFit, path: string): string[] {
  const flag = fit === 'fit' ? '--bg-max' : fit === 'stretch' ? '--bg-scale' : fit === 'center' ? '--bg-center' : fit === 'tile' ? '--bg-tile' : '--bg-fill'
  return [flag, path]
}

export function swaybgArgs(path: string, fit: WallpaperFit): string[] {
  const mode = fit === 'fit' ? 'fit' : fit === 'stretch' ? 'stretch' : fit === 'center' ? 'center' : fit === 'tile' ? 'tile' : 'fill'
  return ['-i', path, '-m', mode]
}

export function xfceImageStyle(fit: WallpaperFit): string {
  return fit === 'fit' ? '2' : fit === 'stretch' ? '3' : fit === 'center' ? '1' : fit === 'tile' ? '0' : fit === 'span' ? '5' : '4'
}

export class LinuxWallpaperService {
  private swaybg: ChildProcess | null = null

  session(): LinuxSession {
    return detectLinuxSession()
  }

  capabilities(): { supported: boolean; fits: WallpaperFit[]; reason?: string } {
    const session = this.session()
    if (session.kind === 'unknown') return { supported: false, fits: [], reason: '无法识别桌面环境，请手动设置壁纸或安装 feh/gsettings' }
    const all: WallpaperFit[] = ['fill', 'fit', 'stretch', 'center', 'tile', 'span']
    if (session.kind === 'kde') return { supported: true, fits: ['fill'], reason: 'KDE 通过 plasma-apply-wallpaperimage 设置，填充方式由系统决定' }
    if (session.kind === 'wlroots') return { supported: true, fits: all.filter(fit => fit !== 'span') }
    return { supported: true, fits: all }
  }

  async listDisplays(): Promise<DisplayInfo[]> {
    const session = this.session()
    try {
      if (session.kind === 'wlroots' && process.env.SWAYSOCK) {
        const { stdout } = await execFile('swaymsg', ['-t', 'get_outputs'], { timeoutMs: 10_000 })
        const outputs = JSON.parse(stdout) as Array<{ name?: string; rect?: { width?: number; height?: number }; active?: boolean }>
        return outputs.filter(output => output.active !== false).map((output, index) => ({
          id: output.name || String(index),
          index,
          name: output.name || `输出 ${index + 1}`,
          width: Number(output.rect?.width) || 0,
          height: Number(output.rect?.height) || 0,
          primary: index === 0,
        }))
      }
      if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
        const { stdout } = await execFile('hyprctl', ['monitors', '-j'], { timeoutMs: 10_000 })
        const outputs = JSON.parse(stdout) as Array<{ name?: string; width?: number; height?: number; focused?: boolean }>
        return outputs.map((output, index) => ({
          id: output.name || String(index),
          index,
          name: output.name || `输出 ${index + 1}`,
          width: Number(output.width) || 0,
          height: Number(output.height) || 0,
          primary: output.focused === true || index === 0,
        }))
      }
      if (!session.wayland) {
        const { stdout } = await execFile('xrandr', ['--query'], { timeoutMs: 10_000 })
        const rows = stdout.split(/\r?\n/).filter(line => / connected/.test(line))
        return rows.map((line, index) => {
          const match = /^(\S+)\s+connected(?:\s+primary)?\s+(\d+)x(\d+)/.exec(line)
          return {
            id: match?.[1] || String(index),
            index,
            name: match?.[1] || `输出 ${index + 1}`,
            width: Number(match?.[2]) || 0,
            height: Number(match?.[3]) || 0,
            primary: / primary /.test(line) || index === 0,
          }
        })
      }
    } catch {
      // 回退到单显示器描述。
    }
    return [{ id: 'all', index: 0, name: '全部显示器', width: 0, height: 0, primary: true }]
  }

  async setStatic(path: string, fit: WallpaperFit): Promise<SetWallpaperResult> {
    const session = this.session()
    try {
      switch (session.kind) {
        case 'gnome':
          await this.runCommands(gnomeCommands(path, fit, true))
          break
        case 'cinnamon':
          await this.runCommands(cinnamonCommands(path, fit))
          break
        case 'mate':
          await this.runCommands(mateCommands(path, fit))
          break
        case 'kde':
          await execFile('plasma-apply-wallpaperimage', [path], { timeoutMs: 20_000 })
          break
        case 'xfce':
          await this.setXfce(path, fit)
          break
        case 'wlroots':
          await this.setWlroots(path, fit)
          break
        case 'x11':
          await this.setX11(path, fit)
          break
        default:
          fail('WALLPAPER_UNSUPPORTED', '当前 Linux 桌面环境不受支持')
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('WALLPAPER_')) throw error
      fail('WALLPAPER_SET_FAILED', `Linux 壁纸设置失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const displays = await this.listDisplays().catch(() => [])
    return { ok: true, applied: displays.map(display => ({ displayId: display.id, path })) }
  }

  async current(): Promise<CurrentWallpaper[]> {
    const session = this.session()
    try {
      if (session.kind === 'gnome' || session.kind === 'cinnamon' || session.kind === 'mate') {
        const schema = session.kind === 'cinnamon' ? 'org.cinnamon.desktop.background' : session.kind === 'mate' ? 'org.mate.background' : 'org.gnome.desktop.background'
        const key = session.kind === 'mate' ? 'picture-filename' : 'picture-uri'
        const { stdout } = await execFile('gsettings', ['get', schema, key], { timeoutMs: 10_000 })
        const path = stdout.trim().replace(/^'|'$/g, '').replace(/^file:\/\//, '')
        return [{ displayId: 'all', path }]
      }
      if (session.kind === 'xfce') {
        const { stdout } = await execFile('xfconf-query', ['-c', 'xfce4-desktop', '-l'], { timeoutMs: 10_000 })
        const property = stdout.split(/\r?\n/).find(line => line.endsWith('/last-image'))
        if (!property) return []
        const value = await execFile('xfconf-query', ['-c', 'xfce4-desktop', '-p', property], { timeoutMs: 10_000 })
        return [{ displayId: 'all', path: value.stdout.trim() }]
      }
    } catch {
      // 读取当前壁纸是可选能力。
    }
    return []
  }

  async dispose(): Promise<void> {
    if (this.swaybg) {
      const child = this.swaybg
      this.swaybg = null
      child.kill('SIGTERM')
      if (child.pid) await untrackProcess(child.pid)
    }
  }

  private async runCommands(commands: Array<{ command: string; args: string[] }>): Promise<void> {
    for (const entry of commands) await execFile(entry.command, entry.args, { timeoutMs: 20_000 })
  }

  private async setXfce(path: string, fit: WallpaperFit): Promise<void> {
    const { stdout } = await execFile('xfconf-query', ['-c', 'xfce4-desktop', '-l'], { timeoutMs: 10_000 })
    const properties = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.endsWith('/last-image'))
    if (!properties.length) fail('WALLPAPER_SET_FAILED', 'XFCE 没有找到壁纸属性')
    for (const property of properties) {
      await execFile('xfconf-query', ['-c', 'xfce4-desktop', '-p', property, '-s', path], { timeoutMs: 10_000 })
      const styleProperty = property.replace(/last-image$/, 'image-style')
      await execFile('xfconf-query', ['-c', 'xfce4-desktop', '-p', styleProperty, '-s', xfceImageStyle(fit)], { timeoutMs: 10_000 }).catch(() => {})
    }
  }

  private async setX11(path: string, fit: WallpaperFit): Promise<void> {
    try {
      await execFile('feh', fehArgs(fit, path), { timeoutMs: 20_000 })
      return
    } catch {
      // 继续尝试其它 X11 工具。
    }
    try {
      const nitrogenFlag = fit === 'fit' ? '--set-zoom-fill' : fit === 'stretch' ? '--set-scaled' : fit === 'center' ? '--set-centered' : fit === 'tile' ? '--set-tiled' : '--set-zoom-fill'
      await execFile('nitrogen', [nitrogenFlag, path], { timeoutMs: 20_000 })
      return
    } catch {
      // 继续尝试 xwallpaper。
    }
    const xwallpaperFlag = fit === 'fit' ? '--max' : fit === 'stretch' ? '--stretch' : fit === 'center' ? '--center' : fit === 'tile' ? '--tile' : '--zoom'
    await execFile('xwallpaper', [xwallpaperFlag, path], { timeoutMs: 20_000 })
  }

  private async setWlroots(path: string, fit: WallpaperFit): Promise<void> {
    if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
      await execFile('hyprctl', ['hyprpaper', 'preload', path], { timeoutMs: 20_000 })
      await execFile('hyprctl', ['hyprpaper', 'wallpaper', `,${path},${fit === 'span' ? 'fill' : fit}`], { timeoutMs: 20_000 })
      return
    }
    if (process.env.SWAYSOCK) {
      try {
        await execFile('swww', ['img', path, '--resize', fit === 'span' ? 'fill' : fit], { timeoutMs: 20_000 })
        return
      } catch {
        await this.startSwaybg(path, fit)
        return
      }
    }
    await this.startSwaybg(path, fit)
  }

  private async startSwaybg(path: string, fit: WallpaperFit): Promise<void> {
    if (this.swaybg) {
      const old = this.swaybg
      this.swaybg = null
      old.kill('SIGTERM')
      if (old.pid) await untrackProcess(old.pid)
    }
    const child = spawn('swaybg', swaybgArgs(path, fit), { stdio: 'ignore', windowsHide: true })
    this.swaybg = child
    if (child.pid) await trackProcess(child.pid)
    child.once('error', () => { if (this.swaybg === child) this.swaybg = null })
    child.once('exit', () => { if (this.swaybg === child) this.swaybg = null })
  }
}
