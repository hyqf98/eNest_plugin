import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { existsSync } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  DynamicSpec,
  EngineCapabilities,
  EngineDescriptor,
  EngineDetection,
  EngineDiagnostics,
  EngineInstallResult,
  EngineSession,
  EngineSettings,
  EngineStatus,
} from '@backend/contracts'
import { acquireActivity, postEvent, trackProcess, untrackProcess } from '@backend/runtime'
import { ensurePluginPaths } from '@backend/paths'
import { helperFileName, helperPathCandidates, helperTarget, resolveExistingHelper } from '@backend/paths'
import { libraryStore, loadSettings } from '@backend/store'
import { errorMessage, fail, isHttpUrl, newId } from '@backend/util'
import type { EngineAdapter, EngineInstallContext } from './types'

interface BuiltinSession {
  id: string
  child: ChildProcess
  socket: Socket
  configPath: string
  releaseActivity: () => Promise<void>
  status: EngineStatus
}

export class BuiltinEngine implements EngineAdapter {
  readonly descriptor: EngineDescriptor
  private session: BuiltinSession | null = null

  constructor(descriptor: EngineDescriptor) {
    this.descriptor = descriptor
  }

  capabilities(): EngineCapabilities {
    return {
      mediaTypes: ['image', 'video', 'gif', 'web'],
      multipleMonitors: true,
      perMonitorContent: false,
      fpsLimit: true,
      pauseOnFullscreen: process.platform !== 'linux',
      pauseOnBattery: true,
      webContent: true,
      requiresHelper: true,
      notes: process.platform === 'linux'
        ? ['动态内容覆盖所有显示器；静态壁纸仍支持逐屏。', 'Linux 内置引擎支持电池与锁屏暂停（锁屏检测依赖桌面提供的 ScreenSaver 接口）；全屏检测由合成器决定，暂不启用。']
        : ['动态内容覆盖所有显示器；静态壁纸仍支持逐屏。'],
    }
  }

  async detect(): Promise<EngineDetection> {
    const target = helperTarget()
    if (!target) return { supported: false, installed: false, detected: false, reason: `不支持的平台：${process.platform}-${process.arch}` }
    const helper = resolveExistingHelper(target)
    if (!helper) {
      return {
        supported: true,
        installed: false,
        detected: false,
        reason: '当前构建未包含内置 helper；发布包会按平台携带。',
        installMethod: 'bundled',
      }
    }
    const version = await readHelperVersion(helper)
    return { supported: true, installed: true, detected: true, version, executable: helper, installMethod: 'bundled' }
  }

  async install(_context: EngineInstallContext): Promise<EngineInstallResult> {
    const detection = await this.detect()
    if (detection.installed) return { ok: true, version: detection.version, path: detection.executable }
    fail('ENGINE_NOT_INSTALLED', detection.reason || '内置 helper 未包含在此构建中')
  }

  async start(spec: DynamicSpec): Promise<EngineSession> {
    const detection = await this.detect()
    if (!detection.supported) fail('ENGINE_UNSUPPORTED', detection.reason || '内置引擎不支持当前平台')
    if (!detection.installed || !detection.executable) fail('ENGINE_NOT_INSTALLED', detection.reason || '内置 helper 未安装')
    if (this.session) await this.stop()
    const content = await resolveContent(spec)
    const paths = await ensurePluginPaths()
    const sessionId = newId('engine')
    const token = newId('token')
    const configPath = join(paths.cache, `${sessionId}.json`)
    const settings = spec.settings
    await writeFile(configPath, JSON.stringify({
      token,
      parentPid: process.pid,
      dataDir: join(paths.cache, 'webview2'),
      content,
      settings,
    }), 'utf8')
    const child = spawn(detection.executable, ['--config', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    })
    const stderr: string[] = []
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', chunk => {
      const text = String(chunk).trim()
      if (text) stderr.push(text.slice(0, 2000))
    })
    try {
      const port = await waitForReadyPort(child, 20_000)
      const socket = await connectAndAuthorize(port, token, 10_000)
      if (!child.pid) throw new Error('helper 没有 PID')
      await trackProcess(child.pid)
      const releaseActivity = await acquireActivity('dynamic wallpaper')
      const session: BuiltinSession = {
        id: sessionId,
        child,
        socket,
        configPath,
        releaseActivity,
        status: { state: 'running', engineId: this.descriptor.id, sessionId, since: Date.now(), pid: child.pid, fps: settings.fpsLimit },
      }
      this.session = session
      let statusBuffer = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        statusBuffer += chunk
        const lines = statusBuffer.split(/\r?\n/)
        statusBuffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const message = JSON.parse(line) as Record<string, unknown>
            if (message.event === 'attached') {
              session.status = { ...session.status, message: '已附着桌面' }
            } else if (message.event === 'paused') {
              session.status = { ...session.status, state: 'paused', pauseReason: typeof message.reason === 'string' ? message.reason : 'paused' }
            } else if (message.event === 'resumed') {
              session.status = { ...session.status, state: 'running', pauseReason: undefined }
            } else if (message.event === 'error') {
              session.status = { ...session.status, state: 'error', message: typeof message.message === 'string' ? message.message : 'helper error' }
            } else {
              continue
            }
            postEvent('engine.status', session.status)
          } catch {
            // 忽略非 JSON 输出。
          }
        }
      })
      socket.on('close', () => {
        if (this.session !== session) return
        this.session = null
        session.status = { state: 'stopped', engineId: this.descriptor.id, sessionId, message: 'helper 控制连接已关闭' }
        postEvent('engine.status', session.status)
        void session.releaseActivity()
      })
      child.once('exit', code => {
        if (this.session !== session) return
        this.session = null
        session.status = { state: 'error', engineId: this.descriptor.id, sessionId, message: `helper 退出（${code ?? 'unknown'}）${stderr.at(-1) ? `：${stderr.at(-1)}` : ''}` }
        postEvent('engine.status', session.status)
        void session.releaseActivity()
        void rm(configPath, { force: true }).catch(() => {})
        if (child.pid) void untrackProcess(child.pid)
      })
      postEvent('engine.status', session.status)
      return { sessionId, engineId: this.descriptor.id, startedAt: session.status.since ?? Date.now(), status: session.status }
    } catch (error) {
      child.kill('SIGTERM')
      await rm(configPath, { force: true }).catch(() => {})
      if (child.pid) await untrackProcess(child.pid)
      fail('ENGINE_START_FAILED', `内置引擎启动失败：${errorMessage(error)}${stderr.at(-1) ? `（${stderr.at(-1)}）` : ''}`)
    }
  }

  async stop(): Promise<void> {
    const session = this.session
    if (!session) return
    this.session = null
    try {
      session.socket.write(JSON.stringify({ cmd: 'stop' }) + '\n')
    } catch {
      // 连接已断开时直接终止进程。
    }
    await waitForExit(session.child, 900)
    if (session.child.exitCode == null) session.child.kill('SIGTERM')
    session.socket.destroy()
    if (session.child.pid) await untrackProcess(session.child.pid)
    await session.releaseActivity()
    await rm(session.configPath, { force: true }).catch(() => {})
    postEvent('engine.status', { state: 'stopped', engineId: this.descriptor.id, sessionId: session.id })
  }

  status(): EngineStatus {
    return this.session?.status ?? { state: 'stopped', engineId: this.descriptor.id }
  }

  async applySettings(settings: EngineSettings): Promise<void> {
    const session = this.session
    if (!session) return
    session.socket.write(JSON.stringify({ cmd: 'settings', settings }) + '\n')
    session.status = { ...session.status, fps: settings.fpsLimit }
  }

  async diagnostics(): Promise<EngineDiagnostics> {
    const detection = await this.detect()
    const lines: string[] = []
    const target = helperTarget()
    lines.push(`platform: ${process.platform}-${process.arch}`)
    lines.push(`helper target: ${target ?? 'unsupported'}`)
    lines.push(`helper: ${detection.executable ?? 'missing'}`)
    if (target) lines.push(`candidates: ${helperPathCandidates(target).join(', ')}`)
    lines.push(`state: ${this.status().state}`)
    return {
      engineId: this.descriptor.id,
      supported: detection.supported,
      installed: detection.installed,
      executable: detection.executable,
      version: detection.version,
      helperTarget: target ?? undefined,
      lines,
    }
  }

  async dispose(): Promise<void> {
    await this.stop()
  }
}

async function resolveContent(spec: DynamicSpec): Promise<{ type: string; url: string; title: string }> {
  const settings = await loadSettings()
  if (spec.libraryId) {
    await libraryStore.load()
    const item = libraryStore.get(spec.libraryId)
    if (!item) fail('LIBRARY_FILE_MISSING', '动态壁纸不在本地库中')
    if (!settings.libraryPath) fail('LIBRARY_NOT_CONFIGURED', '请先设置壁纸库目录')
    const path = join(settings.libraryPath, item.fileName)
    if (!existsSync(path)) fail('LIBRARY_FILE_MISSING', '动态壁纸文件已丢失')
    const type = item.mediaType === 'video' ? 'video' : item.mediaType === 'gif' ? 'gif' : item.mediaType === 'web' ? 'web' : 'image'
    return { type, url: pathToFileURL(path).toString(), title: item.item.title }
  }
  if (spec.url && isHttpUrl(spec.url)) {
    const lower = spec.url.toLowerCase()
    const type = /\.(mp4|webm)(\?|$)/.test(lower) ? 'video' : /\.gif(\?|$)/.test(lower) ? 'gif' : 'web'
    return { type, url: spec.url, title: type === 'web' ? 'Web 壁纸' : type === 'video' ? '视频壁纸' : 'GIF 壁纸' }
  }
  fail('INVALID_ARGUMENT', '动态壁纸需要本地库项目或 http(s) URL')
}

async function readHelperVersion(helper: string): Promise<string | undefined> {
  const manifestPath = join(dirname(helper), 'helper.json')
  try {
    const text = (await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, '')
    const raw = JSON.parse(text) as Record<string, unknown>
    return typeof raw.version === 'string' ? raw.version : undefined
  } catch {
    return undefined
  }
}

function waitForReadyPort(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('等待 helper 启动超时'))
    }, timeoutMs)
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        const match = /^READY\s+(\d{2,5})\s*$/.exec(line.trim())
        if (match) {
          cleanup()
          resolve(Number(match[1]))
          return
        }
        const errorMatch = /^ERROR\s+(.+)$/.exec(line.trim())
        if (errorMatch) {
          cleanup()
          reject(new Error(errorMatch[1] || 'helper 启动失败'))
          return
        }
      }
    }
    const onExit = (code: number | null) => {
      cleanup()
      reject(new Error(`helper 在就绪前退出（${code ?? 'unknown'}）`))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

function connectAndAuthorize(port: number, token: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(new Error('helper 控制连接超时'))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const message = JSON.parse(line) as Record<string, unknown>
          if (message.event === 'ready') {
            cleanup()
            resolve(socket)
            return
          }
          if (message.event === 'error') {
            cleanup()
            socket.destroy()
            reject(new Error(typeof message.message === 'string' ? message.message : 'helper 拒绝连接'))
            return
          }
        } catch {
          // 忽略非 JSON 日志行。
        }
      }
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('helper 在授权前断开连接'))
    }
    socket.once('connect', () => {
      socket.write(JSON.stringify({ token }) + '\n')
    })
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode != null) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve()
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', onExit)
  })
}

export async function builtinHelperExists(): Promise<boolean> {
  const target = helperTarget()
  if (!target) return false
  const helper = resolveExistingHelper(target)
  if (!helper) return false
  const info = await stat(helper).catch(() => null)
  return Boolean(info?.isFile())
}

export function builtinHelperName(): string | null {
  const target = helperTarget()
  return target ? helperFileName(target) : null
}
