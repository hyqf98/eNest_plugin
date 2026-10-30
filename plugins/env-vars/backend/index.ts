/**
 * env-vars backend entry: 环境变量读取 / 写入 / 删除 / 备份管理。
 * 通过 Electron utility message port 与渲染层 RPC：
 *   snapshot / setVar / deleteVar / getSettings / setSettings /
 *   listBackups / restoreBackup / pathParts / openManagedFolder
 * 设置由前端持久化（enest.storage），写操作每次把 settings 作为参数传入。
 */
import { exec } from './exec'
import { parentPort } from './parentPort'
import * as mac from './platforms/mac'
import * as win from './platforms/win'
import type { PluginSettings } from './types'

const port = parentPort
if (!port) throw new Error('env-vars service requires an Electron utility parent')

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
  if (process.platform === 'win32') {
    if (!win.WIN_NAME_RE.test(name)) throw new Error('变量名仅允许字母、数字、下划线、括号、点、空格、连字符，且以字母或下划线开头')
  } else {
    if (!mac.MAC_NAME_RE.test(name)) throw new Error('变量名仅允许字母、数字、下划线，且以字母或下划线开头')
  }
  return name
}

function requireScope(input: unknown): string {
  if (typeof input !== 'string') throw new Error('范围参数无效')
  return input
}

function settingsFrom(input: unknown): PluginSettings {
  return process.platform === 'darwin' ? mac.parseSettings(input) : { macTarget: 'zshenv', launchctlSync: false }
}

const methods: Record<string, (...args: never[]) => unknown> = {
  snapshot: () => (process.platform === 'win32' ? win.snapshot() : mac.snapshot()),
  setVar: (...args: never[]) => {
    const raw = requireObject(args[0], 'setVar')
    const name = requireName(raw.name)
    if (typeof raw.value !== 'string') throw new Error('变量值无效')
    const scope = requireScope(raw.scope)
    const settings = settingsFrom(raw.settings)
    if (process.platform === 'win32') {
      if (scope !== 'user' && scope !== 'machine') throw new Error('Windows 仅支持 user / machine 范围')
      return win.setVar(name, raw.value, scope, raw.elevate === true)
    }
    if (scope !== 'persistent') throw new Error('macOS 持久写入仅支持 persistent 范围')
    return mac.setVar(name, raw.value, settings)
  },
  deleteVar: (...args: never[]) => {
    const raw = requireObject(args[0], 'deleteVar')
    const name = requireName(raw.name)
    const scope = requireScope(raw.scope)
    const settings = settingsFrom(raw.settings)
    if (process.platform === 'win32') {
      if (scope !== 'user' && scope !== 'machine') throw new Error('Windows 仅支持 user / machine 范围')
      return win.deleteVar(name, scope, raw.elevate === true)
    }
    if (scope !== 'persistent') throw new Error('macOS 持久删除仅支持 persistent 范围')
    return mac.deleteVar(name, settings)
  },
  getSettings: () => (process.platform === 'darwin' ? mac.defaultSettings() : { macTarget: 'zshenv', launchctlSync: false }),
  setSettings: (...args: never[]) => {
    const raw = requireObject(args[0], 'setSettings')
    return mac.parseSettings(raw)
  },
  listBackups: () => (process.platform === 'darwin' ? mac.listBackups() : []),
  restoreBackup: (...args: never[]) => {
    if (process.platform !== 'darwin') throw new Error('备份恢复仅支持 macOS')
    const file: unknown = args[0]
    if (typeof file !== 'string' || !file.trim()) throw new Error('备份文件参数无效')
    return mac.restoreBackup(file)
  },
  pathParts: () => {
    if (process.platform !== 'darwin') throw new Error('PATH 来源视图仅支持 macOS')
    return mac.pathParts()
  },
  openManagedFolder: (...args: never[]) => {
    const raw = requireObject(args[0], 'openManagedFolder')
    const filePath = typeof raw.path === 'string' ? raw.path : ''
    if (process.platform === 'darwin') {
      if (!filePath) return exec('/usr/bin/open', [requireHome()])
      if (!filePath.startsWith(requireHome() + '/')) throw new Error('路径超出允许范围')
      return exec('/usr/bin/open', ['-R', filePath])
    }
    return exec('explorer.exe', ['shell:Downloads'])
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
