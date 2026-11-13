/**
 * gif.ts —— webm → gif 转码（ffmpeg 外部进程）
 * 输入：私有文件 ID 分块读出的完整 webm 字节（写入临时文件）。
 * 输出：gif 字节（内存返回，由前端经 files.stream 写回私有文件区）。
 * ffmpeg 缺失时给出可读错误；全程 execFile 数组参数，不进 shell。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_GIF_BYTES = 64 * 1024 * 1024
const FFMPEG_TIMEOUT_MS = 120_000

function run(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const hint = /ENOENT/.test(String(error)) ? `${command} 未安装` : (stderr || error.message || String(error)).slice(0, 500)
        reject(new Error(`${command} 执行失败：${hint}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/** 探测本机 ffmpeg（PATH 优先）。返回 null 表示不可用，前端据此禁用 GIF 按钮。 */
export async function gifAvailable(): Promise<{ ok: boolean; version?: string }> {
  try {
    const { stdout } = await run('ffmpeg', ['-version'], 8_000)
    const version = stdout.split('\n')[0]?.trim().slice(0, 120)
    return { ok: true, version }
  } catch {
    return { ok: false }
  }
}

export interface GifConvertOptions {
  /** 目标帧率（2–15） */
  fps?: number
  /** 输出最大宽度（像素，偶数；等比缩放，0 = 原尺寸） */
  width?: number
  /** 起始/结束偏移（毫秒，0 = 不裁剪） */
  startMs?: number
  endMs?: number
}

export async function convertToGif(webm: ArrayBuffer, options: GifConvertOptions = {}): Promise<{ bytes: ArrayBuffer; size: number }> {
  if (!(webm instanceof ArrayBuffer) || webm.byteLength === 0) throw new Error('录制内容为空')
  if (webm.byteLength > 512 * 1024 * 1024) throw new Error('录制文件过大（超过 512 MB），不适合直接转 GIF')
  const fps = Math.max(2, Math.min(15, Math.floor(options.fps ?? 10)))
  const width = options.width === undefined ? 0 : Math.max(0, Math.floor(options.width))
  const start = Math.max(0, Math.floor(options.startMs ?? 0))
  const end = Math.max(0, Math.floor(options.endMs ?? 0))

  const directory = await mkdtemp(join(tmpdir(), 'enest-gif-'))
  try {
    const input = join(directory, 'in.webm'), output = join(directory, 'out.gif')
    await writeFile(input, Buffer.from(webm))
    const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y']
    if (start > 0) args.push('-ss', (start / 1000).toFixed(3))
    if (end > start) args.push('-t', ((end - start) / 1000).toFixed(3))
    args.push('-i', input)
    // 调色板两步法合成单命令：palettegen/paletteuse 保证质量与体积的平衡；
    // fps 滤镜先统一恒定帧率，输出端不再叠 -r（与 -fps_mode 冲突）。
    const scale = width > 0 ? `scale=${width}:-2:flags=lanczos` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos'
    const filter = `[0:v]fps=${fps},${scale},split[s0][s1];[s0]palettegen=max_colors=${fps >= 12 ? 256 : 192}[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`
    args.push('-vf', filter, '-loop', '0', output)
    await run('ffmpeg', args, FFMPEG_TIMEOUT_MS)
    const bytes = await readFile(output)
    if (bytes.byteLength === 0) throw new Error('转码结果为空，请重试')
    if (bytes.byteLength > MAX_GIF_BYTES) throw new Error(`GIF 超过 ${Math.round(MAX_GIF_BYTES / 1024 / 1024)} MB 上限，可降低帧率或宽度后重试`)
    return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, size: bytes.byteLength }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
