/**
 * File actions for Anything: open with the system handler, reveal in the
 * file manager, move to the OS trash, and bounded reads for the preview pane.
 * All commands run without a shell (execFile with an args array).
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { FileInfo } from './types'

const COMMAND_TIMEOUT_MS = 10000
const TRASH_TIMEOUT_MS = 20000
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'heic', 'tiff'])
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon', heic: 'image/heic', tiff: 'image/tiff'
}

function run(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, error => {
      if (error) reject(new Error(`${command} 失败：${error.message}`))
      else resolve()
    })
  })
}

function assertSafePath(input: unknown): string {
  if (typeof input !== 'string') throw new Error('路径参数无效')
  const value = input.trim()
  if (!value || value.includes('\0') || !path.isAbsolute(value)) throw new Error('需要绝对路径')
  return value
}

function mustExist(filePath: string): fs.Stats {
  const stats = fs.statSync(filePath)
  return stats
}

export async function openPath(input: unknown): Promise<boolean> {
  const filePath = assertSafePath(input)
  mustExist(filePath)
  if (process.platform === 'darwin') await run('open', [filePath])
  else if (process.platform === 'win32') await run('explorer.exe', [filePath])
  else await run('xdg-open', [filePath])
  return true
}

export async function revealPath(input: unknown): Promise<boolean> {
  const filePath = assertSafePath(input)
  const stats = mustExist(filePath)
  if (process.platform === 'darwin') await run('open', ['-R', filePath])
  else if (process.platform === 'win32') await run('explorer.exe', [`/select,${filePath}`])
  else await run('xdg-open', [stats.isDirectory() ? filePath : path.dirname(filePath)])
  return true
}

function appleScriptEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** 跨平台移入系统废纸篓：Finder (darwin) / PowerShell Shell.Application (win32) / gio|trash-put (linux)。 */
export async function trashPath(input: unknown): Promise<boolean> {
  const filePath = assertSafePath(input)
  const stats = mustExist(filePath)
  if (process.platform === 'darwin') {
    await run('osascript', ['-e', `tell application "Finder" to delete POSIX file "${appleScriptEscape(filePath)}"`], TRASH_TIMEOUT_MS)
    return true
  }
  if (process.platform === 'win32') {
    const method = stats.isDirectory() ? 'DeleteDirectory' : 'DeleteFile'
    const script = [
      'Add-Type -AssemblyName Microsoft.VisualBasic',
      `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${filePath.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`
    ].join('; ')
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], TRASH_TIMEOUT_MS)
    return true
  }
  for (const command of ['gio', 'trash-put', 'kioclient']) {
    const args = command === 'gio' ? ['trash', filePath] : command === 'kioclient' ? ['move', filePath, `trash:/`] : [filePath]
    try {
      await run(command, args, TRASH_TIMEOUT_MS)
      return true
    } catch {
      // try the next trash implementation
    }
  }
  throw new Error('未找到可用的废纸篓命令（gio / trash-put / kioclient）')
}

export function statPath(input: unknown): FileInfo {
  const filePath = assertSafePath(input)
  const stats = mustExist(filePath)
  return {
    path: filePath,
    name: path.basename(filePath),
    dir: path.dirname(filePath),
    ext: path.extname(filePath).slice(1).toLowerCase(),
    isDirectory: stats.isDirectory(),
    size: stats.size,
    mtimeMs: Math.round(stats.mtimeMs)
  }
}

function decodeText(buffer: Buffer): { content: string; encoding: string } {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { content: new TextDecoder('utf-8').decode(buffer.subarray(3)), encoding: 'utf-8' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { content: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'utf-16le' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { content: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'utf-16be' }
  }
  for (const encoding of ['utf-8', 'gb18030']) {
    try {
      return { content: new TextDecoder(encoding, { fatal: true }).decode(buffer), encoding }
    } catch {
      // fall through to the next candidate
    }
  }
  return { content: new TextDecoder('latin1').decode(buffer), encoding: 'latin1' }
}

const BINARY_SNIFF_BYTES = 4096

export function readTextFile(input: unknown, maxBytesInput?: unknown): { content: string; encoding: string; truncated: boolean; size: number } {
  const filePath = assertSafePath(input)
  const maxBytes = Math.max(1024, Math.min(Number(maxBytesInput) || 131072, 1048576))
  const stats = mustExist(filePath)
  if (stats.isDirectory()) throw new Error('目录无法预览为文本')
  const handle = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(maxBytes, stats.size))
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0)
    const slice = buffer.subarray(0, read)
    let binary = false
    for (const byte of slice.subarray(0, Math.min(read, BINARY_SNIFF_BYTES))) {
      if (byte === 0) { binary = true; break }
    }
    if (binary) throw new Error('二进制文件，暂不支持预览')
    const { content, encoding } = decodeText(slice)
    return { content, encoding, truncated: stats.size > read, size: stats.size }
  } finally {
    fs.closeSync(handle)
  }
}

export function readImageFile(input: unknown, maxBytesInput?: unknown): { dataUrl: string; size: number } {
  const filePath = assertSafePath(input)
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (!IMAGE_EXTS.has(ext)) throw new Error('不是受支持的图片格式')
  const stats = mustExist(filePath)
  if (stats.isDirectory()) throw new Error('目录无法作为图片预览')
  const maxBytes = Math.max(64 * 1024, Math.min(Number(maxBytesInput) || 3 * 1024 * 1024, 6 * 1024 * 1024))
  if (stats.size > maxBytes) throw new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)} MB，暂不预览`)
  const mime = IMAGE_MIME[ext] ?? 'application/octet-stream'
  if (ext === 'heic' || ext === 'tiff') {
    // Chromium 不解码 HEIC/TIFF，提示而不是渲染破图
    throw new Error('该格式需系统预览打开（HEIC/TIFF 不在 webview 内渲染）')
  }
  const data = fs.readFileSync(filePath)
  return { dataUrl: `data:${mime};base64,${data.toString('base64')}`, size: stats.size }
}
