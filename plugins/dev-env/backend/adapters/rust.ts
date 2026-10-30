/**
 * rust 家族：cargo/rustup 探测 + 多 toolchain 实例 + cargo install --list + registry 清理。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { run, runVersion, which } from '../exec'
import { configFile, dirSize, invalidateSizeCache, joinHome } from '../paths'
import type { CleanAction, ConfigFile, CustomEnv, Dep, EnvAdapter, EnvDetail, EnvInstance } from '../types'

const CARGO_HOME = process.env.CARGO_HOME && path.isAbsolute(process.env.CARGO_HOME) ? process.env.CARGO_HOME : joinHome('.cargo')
const RUSTUP_HOME = process.env.RUSTUP_HOME && path.isAbsolute(process.env.RUSTUP_HOME) ? process.env.RUSTUP_HOME : joinHome('.rustup')

export const rustAdapter: EnvAdapter = {
  family: 'rust',
  label: 'Rust',

  async detect(custom: CustomEnv[] = []): Promise<EnvInstance[]> {
    const instances: EnvInstance[] = []
    const cargo = which('cargo')
    if (cargo) {
      const version = await runVersion('cargo')
      instances.push({ id: 'rust:cargo', family: 'rust', label: 'Rust (cargo)', version: version ?? undefined, binPath: cargo })
    }
    const rustup = which('rustup')
    if (rustup) {
      const version = await runVersion('rustup')
      instances.push({ id: 'rust:rustup', family: 'rust', label: 'rustup', version: version ?? undefined, binPath: rustup })
      try {
        const result = await run('rustup', ['toolchain', 'list'], { timeoutMs: 20_000 })
        if (result.ok) {
          for (const line of result.stdout.split(/\r?\n/)) {
            const name = line.trim().split(/\s+/)[0]
            if (!name || name === '(default)' || name === '(override)') continue
            instances.push({ id: `rust:toolchain:${name}`, family: 'rust', label: `toolchain · ${name}`, version: name, rootPath: path.join(RUSTUP_HOME, 'toolchains', name), note: /default/.test(line) ? '默认 toolchain' : undefined })
          }
        }
      } catch { /* rustup list failed */ }
    }
    if (!cargo && !rustup && fs.existsSync(CARGO_HOME)) {
      instances.push({ id: 'rust:home-only', family: 'rust', label: 'Cargo 目录（cargo 未在 PATH）', rootPath: CARGO_HOME, note: '仅探测到 ~/.cargo' })
    }
    for (const item of custom) {
      if (item.family === 'rust') instances.push({ id: `rust:custom:${item.id}`, family: 'rust', label: item.label, rootPath: item.rootPath, note: '手动添加' })
    }
    return instances
  },

  async detail(id: string): Promise<EnvDetail> {
    const instances = await rustAdapter.detect()
    const instance = instances.find(item => item.id === id)
    if (!instance) throw new Error(`未找到 Rust 实例: ${id}`)
    const usage = []
    for (const [label, dir] of [['cargo home', CARGO_HOME], ['registry 缓存', path.join(CARGO_HOME, 'registry')]] as const) {
      if (fs.existsSync(dir)) usage.push({ label, path: dir, bytes: await dirSize(dir) })
    }
    if (fs.existsSync(RUSTUP_HOME)) usage.push({ label: 'rustup home', path: RUSTUP_HOME, bytes: await dirSize(RUSTUP_HOME) })
    const keyVars = [
      { name: 'CARGO_HOME', value: process.env.CARGO_HOME ?? `(默认 ${CARGO_HOME})` },
      { name: 'RUSTUP_HOME', value: process.env.RUSTUP_HOME ?? `(默认 ${RUSTUP_HOME})` }
    ]
    return { instance, diskUsage: usage, keyVars }
  },

  async listDeps(): Promise<Dep[]> {
    const result = await run('cargo', ['install', '--list'], { timeoutMs: 60_000 })
    if (!result.ok) throw new Error(`cargo install --list 失败: ${result.stderr.trim().slice(0, 300)}`)
    const deps: Dep[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^([a-zA-Z0-9_-]+)\sv([\d][^\s:]*):$/.exec(line.trim())
      if (match) deps.push({ name: match[1], version: match[2] })
    }
    return deps
  },

  async removeDep(name: string) {
    const result = await run('cargo', ['uninstall', name], { timeoutMs: 300_000 })
    if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 300) || 'cargo uninstall 失败' }
    return { ok: true, note: `已卸载 ${name}` }
  },

  async cleanActions(): Promise<CleanAction[]> {
    const actions: CleanAction[] = []
    const registry = path.join(CARGO_HOME, 'registry')
    if (fs.existsSync(registry)) {
      actions.push({
        id: 'rust-registry',
        label: '清理 cargo registry 缓存',
        description: `删除 ${registry}（下载的 crate 源码与二进制缓存，下次构建重新下载）`,
        risk: 'safe',
        command: async () => {
          const bytes = await dirSize(registry)
          await fs.promises.rm(registry, { recursive: true, force: true })
          invalidateSizeCache(registry)
          return { ok: true, note: 'registry 缓存已删除', freedBytes: bytes }
        },
        dryRun: async () => [`将删除目录 ${registry}`, `当前占用：${(await dirSize(registry)).toLocaleString()} 字节`]
      })
    }
    actions.push({
      id: 'rustup-old-toolchains',
      label: '卸载旧 rustup toolchain',
      description: '卸载除默认 toolchain 外的所有旧工具链（rustup toolchain uninstall）',
      risk: 'cautious',
      command: async () => {
        if (!which('rustup')) return { ok: false, note: 'rustup 不可用' }
        const list = await run('rustup', ['toolchain', 'list'], { timeoutMs: 20_000 })
        if (!list.ok) return { ok: false, note: 'rustup toolchain list 失败' }
        const toolchains = list.stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/)[0]).filter(name => name && !name.startsWith('('))
        const keep = toolchains.find(name => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\(default`).test(list.stdout)) ?? toolchains.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
        let bytes = 0
        for (const name of toolchains) {
          if (name === keep) continue
          const dir = path.join(RUSTUP_HOME, 'toolchains', name)
          bytes += await dirSize(dir)
          const result = await run('rustup', ['toolchain', 'uninstall', name], { timeoutMs: 300_000 })
          if (!result.ok) return { ok: false, note: `卸载 ${name} 失败: ${result.stderr.trim().slice(0, 200)}` }
        }
        invalidateSizeCache(RUSTUP_HOME)
        return { ok: true, note: toolchains.length > 1 ? `已卸载 ${toolchains.length - 1} 个旧 toolchain` : '没有旧 toolchain 需要卸载', freedBytes: bytes }
      },
      dryRun: async () => {
        const lines: string[] = []
        try {
          const list = await run('rustup', ['toolchain', 'list'], { timeoutMs: 20_000 })
          for (const line of list.stdout.split(/\r?\n/)) {
            if (line.trim()) lines.push(line.trim())
          }
        } catch { lines.push('rustup 不可用') }
        return lines.length ? lines : ['没有已安装的 toolchain']
      }
    })
    return actions
  },

  async configs(): Promise<ConfigFile[]> {
    return [configFile(path.join(CARGO_HOME, 'config.toml')), configFile(path.join(CARGO_HOME, 'config'))]
  }
}
