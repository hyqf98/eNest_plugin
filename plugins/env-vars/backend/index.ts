/**
 * env-vars backend entry: 环境变量读取 / 写入 / 删除 / 备份管理。
 * 通过 Electron utility message port 与渲染层 RPC：
 *   snapshot / setVar / deleteVar / getSettings / setSettings /
 *   listBackups / restoreBackup / pathParts / openManagedFolder
 * 设置由前端持久化（enest.storage），写操作每次把 settings 作为参数传入。
 */
import { exec } from './exec'
import { parentPort } from './parentPort'
import * as linux from './platforms/linux'
import * as mac from './platforms/mac'
import * as win from './platforms/win'
import type { PluginSettings } from './types'

const port = parentPort
if (!port) throw new Error('env-vars service requires an Electron utility parent')

const isDarwin = process.platform === 'darwin'
const isWindows = process.platform === 'win32'
const isLinux = process.platform === 'linux'
// Linux 统一走 linux 实现（~/.profile 受管块）；其余冷门平台不暴露持久写入。

type Unknown = Record<string, unknown>

function requireObject(input: unknown, label: string): Unknown {
  if (input === undefined || input === null) throw new Error(`${label} 参数无效`)
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label} 参数无效`)
  return input as Unknown
}

function requireName(input: unknown): string {
  if (typeof input !== 'string') throw new Error('变量名无效')
  const name = input.trim()
  if (!name) throw new Error('变量名不能为空')
  if (isWindows) {
    if (!win.WIN_NAME_RE.test(name)) throw new Error('变量名仅允许字母、数字、下划线、括号、点、空格、连字符，且以字母或下划线开头')
  } else {
    // macOS 与 Linux 同为 POSIX shell 变量名规则。
    if (!mac.MAC_NAME_RE.test(name)) throw new Error('变量名仅允许字母、数字、下划线，且以字母或下划线开头')
  }
  return name
}

function requireScope(input: unknown): string {
  if (typeof input !== 'string') throw new Error('范围参数无效')
  return input
}

function settingsFrom(input: unknown): PluginSettings {
  return isDarwin ? mac.parseSettings(input) : linux.parseSettings(input)
}

const methods: Record<string, (...args: never[]) => unknown> = {
  snapshot: () => {
    if (isWindows) return win.snapshot()
    if (isDarwin) return mac.snapshot()
    return linux.snapshot()
  },
  setVar: (...args: never[]) => {
    const raw = requireObject(args[0], 'setVar')
    const name = requireName(raw.name)
    if (typeof raw.value !== 'string') throw new Error('变量值无效')
    const scope = requireScope(raw.scope)
    const settings = settingsFrom(raw.settings)
    if (isWindows) {
      if (scope !== 'user' && scope !== 'machine') throw new Error('Windows 仅支持 user / machine 范围')
      return win.setVar(name, raw.value, scope, raw.elevate === true)
    }
    if (isDarwin || isLinux) {
      if (scope !== 'persistent') {
        throw new Error(isDarwin ? 'macOS 持久写入仅支持 persistent 范围' : 'Linux 持久写入仅支持 persistent 范围')
      }
      return isDarwin ? mac.setVar(name, raw.value, settings) : linux.setVar(name, raw.value)
    }
    throw new Error('当前平台不支持写入环境变量')
  },
  deleteVar: (...args: never[]) => {
    const raw = requireObject(args[0], 'deleteVar')
    const name = requireName(raw.name)
    const scope = requireScope(raw.scope)
    const settings = settingsFrom(raw.settings)
    if (isWindows) {
      if (scope !== 'user' && scope !== 'machine') throw new Error('Windows 仅支持 user / machine 范围')
      return win.deleteVar(name, scope, raw.elevate === true)
    }
    if (isDarwin || isLinux) {
      if (scope !== 'persistent') {
        throw new Error(isDarwin ? 'macOS 持久删除仅支持 persistent 范围' : 'Linux 持久删除仅支持 persistent 范围')
      }
      return isDarwin ? mac.deleteVar(name, settings) : linux.deleteVar(name)
    }
    throw new Error('当前平台不支持删除环境变量')
  },
  getSettings: () => (isDarwin ? mac.defaultSettings() : linux.defaultSettings()),
  setSettings: (...args: never[]) => {
    const raw = requireObject(args[0], 'setSettings')
    return isDarwin ? mac.parseSettings(raw) : linux.parseSettings(raw)
  },
  listBackups: () => {
    if (isDarwin) return mac.listBackups()
    if (isLinux) return linux.listBackups()
    return [] // Windows 写注册表，无文件备份
  },
  restoreBackup: (...args: never[]) => {
    if (!isDarwin && !isLinux) throw new Error('备份恢复仅支持 macOS 与 Linux')
    const file: unknown = args[0]
    if (typeof file !== 'string' || !file.trim()) throw new Error('备份文件参数无效')
    return isDarwin ? mac.restoreBackup(file) : linux.restoreBackup(file)
  },
  pathParts: () => {
    if (!isDarwin) throw new Error('PATH 来源视图仅支持 macOS')
    return mac.pathParts()
  },
  openManagedFolder: (...args: never[]) => {
    const raw = requireObject(args[0], 'openManagedFolder')
    const filePath = typeof raw.path === 'string' ? raw.path : ''
    const home = requireHome()
    if (isDarwin) {
      if (!filePath) return exec('/usr/bin/open', [home])
      if (!filePath.startsWith(home + '/')) throw new Error('路径超出允许范围')
      return exec('/usr/bin/open', ['-R', filePath])
    }
    if (isWindows) return exec('explorer.exe', ['shell:Downloads'])
    if (isLinux) {
      // xdg-open 只开目录：受管/备份文件统一打开其所在目录（home）。
      if (filePath) {
        if (!filePath.startsWith(home + '/')) throw new Error('路径超出允许范围')
        const base = filePath.slice(home.length + 1)
        if (base !== '.profile' && !/^\.profile(\.enest-backup-\d{8}-\d{6}|\.enest-tmp)?$/.test(base)) {
          throw new Error('路径超出允许范围')
        }
      }
      return exec('xdg-open', [home])
    }
    throw new Error('当前平台不支持打开文件夹')
  }
}

function requireHome(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  return os.homedir()
}

port.on('message', async ({ data: raw }) => {
  const data = raw as { id?: unknown; pluginId?: unknown; method?: unknown; args?: unknown; proxy?: Record<string, unknown> } | undefined
  const { id, pluginId, method, args = [], proxy } = data ?? {}
  if (!Number.isInteger(id) || typeof pluginId !== 'string' || typeof method !== 'string' || !Object.hasOwn(methods, method) || !Array.isArray(args)) return
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    if (typeof proxy?.[key] === 'string') process.env[key] = proxy[key]
    else delete process.env[key]
  }
  try {
    const result = await methods[method]!(...args as never[])
    // Keep IPC messages bounded.
    const bytes = Buffer.byteLength(JSON.stringify(result) ?? '')
    if (bytes > 8 * 1024 * 1024) throw new Error('env-vars result exceeds 8 MiB')
    port.postMessage({ id, ok: true, data: result })
  } catch (error) {
    port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
