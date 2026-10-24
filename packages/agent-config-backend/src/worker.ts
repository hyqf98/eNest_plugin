import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createAgentConfigService } from './service'
import type { AgentWriteInputPayload } from './contracts'

interface MessagePort {
  on(event: 'message', listener: (message: { data: unknown }) => void): void
  postMessage(message: unknown): void
}
interface BackendOptions {
  pluginId: string
  mode: 'config' | 'pets'
  port: MessagePort
  homePath: string
  onShutdown?(): void
  stageRoot?: string
  stageTtlMs?: number
}
interface PendingControl { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Stage {
  id: string; app: string; directory: string; token: string; bytes: number; committing: boolean
  files: Array<{ path: string; bytes: number; received: number; file: string }>
  timer: ReturnType<typeof setTimeout>
}
const MAX_FILE = 8 * 1024 * 1024
const MAX_STAGE = 32 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024
const messageError = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 4096)

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected backend parameters')
  return value as Record<string, unknown>
}
function text(value: unknown, limit = 1024): string {
  if (typeof value !== 'string' || !value || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid backend argument')
  return value
}

/** Per-plugin private transport; no host agent-specific API or filesystem service is used. */
export function createAgentBackend(options: BackendOptions) {
  let service: ReturnType<typeof createAgentConfigService> | undefined
  let initialized = false, closed = false, sequence = 0, reservedBytes = 0, creatingStages = 0
  let initializationError: string | undefined
  const controls = new Map<number, PendingControl>(), stages = new Map<string, Stage>(), pending = new Set<number>()
  const ttl = options.stageTtlMs ?? 60000
  const assertCurrent = () => { if (!initialized || closed || !service) throw new Error(initializationError || 'Backend is not initialized or is closing') }
  function post(message: unknown): void {
    if (Buffer.byteLength(JSON.stringify(message) ?? '') > 8 * 1024 * 1024) throw new Error('Backend result exceeds 8 MiB')
    options.port.postMessage(message)
  }
  function host(method: string, params: Record<string, unknown>): Promise<unknown> {
    assertCurrent()
    if (controls.size >= 32) return Promise.reject(new Error('Backend control limit reached'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { controls.delete(id); reject(new Error('Host confirmation/control timed out')) }, 25000)
      timer.unref()
      controls.set(id, { resolve, reject, timer })
      try { post({ type: 'host.request', id, method, params }) }
      catch (error) { controls.delete(id); clearTimeout(timer); reject(error as Error) }
    })
  }
  function release(token: string): void {
    try { post({ type: 'host.request', id: ++sequence, method: 'activity.release', params: { token } }) } catch { /* Scope disposal also releases host leases. */ }
  }
  function discard(stage: Stage): void {
    if (!stages.has(stage.id)) return
    clearTimeout(stage.timer)
    try { rmSync(stage.directory, { recursive: true, force: true }) }
    catch (error) { if (!closed) stage.timer.refresh(); throw error }
    stages.delete(stage.id)
    reservedBytes -= stage.bytes
    release(stage.token)
  }
  async function confirm(title: string, message: string, detail?: string): Promise<void> {
    const boundedDetail = detail && detail.length > 1000 ? detail.slice(0, 996) + '...' : detail
    const allowed = await host('dialog.confirm', { title, message, ...(boundedDetail ? { detail: boundedDetail } : {}) })
    assertCurrent()
    if (allowed !== true) throw new Error('Operation cancelled')
  }
  function ownedStage(id: unknown): Stage {
    const stage = stages.get(text(id, 80))
    if (!stage || stage.committing) throw new Error('Asset stage is missing or already committing')
    return stage
  }
  async function writeConfig(input: Record<string, unknown>, app: string): Promise<unknown> {
    if (!service!.adapters.some(adapter => adapter.app === app)) throw new Error('Unknown application')
    const changes = { ...object(input.changes) }
    const ref = input.secretRef === undefined ? undefined : text(input.secretRef, 512)
    if (ref) {
      if (app === 'codex' && changes.$file !== 'auth.json'
        || app === 'claude-code' && changes.$file !== undefined && changes.$file !== 'settings.json'
        || app === 'gemini-cli' && changes.$file !== undefined && changes.$file !== 'settings.json'
        || !['claude-code', 'codex', 'gemini-cli'].includes(app)) throw new Error('Credential target is not supported')
      if (app !== 'codex') changes.env = { ...object(changes.env ?? {}) }
    }
    await confirm('写入 AI 应用配置？', `应用：${app}`, '仅修改该应用的白名单配置；写入前保存快照。')
    let secret: string | undefined
    try {
      if (ref) {
        let resolved: unknown
        try { resolved = await host('secret.resolve', { ref }) }
        catch { throw new Error('Unable to resolve the saved provider credential') }
        assertCurrent()
        if (typeof resolved !== 'string' || !resolved || resolved.length > 64 * 1024) throw new Error('Saved provider credential is missing or invalid')
        secret = resolved
        if (app === 'codex') changes.OPENAI_API_KEY = secret
        else (changes.env as Record<string, unknown>)[app === 'claude-code' ? 'ANTHROPIC_AUTH_TOKEN' : 'GOOGLE_API_KEY'] = secret
      }
      return service!.agentWrite(options.pluginId, { app, changes, confirmed: true } as AgentWriteInputPayload)
    } catch (error) {
      // Parser/OS errors may include snippets of the target; never reflect a resolved credential.
      throw new Error(secret ? 'Provider configuration write failed; check its format and file permissions' : messageError(error))
    }
  }
  async function stageCreate(input: Record<string, unknown>): Promise<{ stageId: string; chunkBytes: number }> {
    const app = text(input.app)
    if (app !== 'codex' || !Array.isArray(input.assets) || !input.assets.length || input.assets.length > 20) throw new Error('Invalid Codex asset stage')
    const files = input.assets.map(raw => {
      const item = object(raw), path = text(item.path)
      if (!Number.isSafeInteger(item.bytes) || Number(item.bytes) < 1 || Number(item.bytes) > MAX_FILE) throw new Error('Asset file exceeds 8 MiB')
      return { path, bytes: Number(item.bytes) }
    })
    if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Duplicate asset path')
    service!.validateAssetPaths(app, files.map(file => file.path))
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
    if (stages.size + creatingStages >= 2 || reservedBytes + bytes > MAX_STAGE) throw new Error('Asset staging exceeds 32 MiB budget')
    reservedBytes += bytes
    creatingStages++
    const token = randomUUID()
    let directory: string | undefined
    try {
      await host('activity.acquire', { token, reason: 'agent-assets-upload' })
      assertCurrent()
      directory = mkdtempSync(join(options.stageRoot ?? tmpdir(), 'enest-agent-assets-'))
      const id = randomUUID(), stage: Stage = {
        id, app, token, bytes, directory, committing: false,
        files: files.map((file, index) => {
          const target = join(directory!, String(index))
          writeFileSync(target, Buffer.alloc(0), { flag: 'wx', mode: 0o600 })
          return { ...file, received: 0, file: target }
        }),
        timer: setTimeout(() => { try { discard(stage) } catch { /* Shutdown retries owned cleanup. */ } }, ttl)
      }
      stage.timer.unref()
      stages.set(id, stage)
      return { stageId: id, chunkBytes: CHUNK_BYTES }
    } catch (error) {
      reservedBytes -= bytes
      if (directory) rmSync(directory, { recursive: true, force: true })
      release(token)
      throw error
    } finally { creatingStages-- }
  }
  async function execute(method: string, input: Record<string, unknown>): Promise<unknown> {
    assertCurrent()
    const api = service!, owner = options.pluginId
    if (method === 'apps') {
      return api.agentApps(options.mode === 'pets' ? ['codex'] : undefined)
    }
    if (options.mode === 'config') {
      const app = text(input.app)
      switch (method) {
        case 'read': return api.agentRead(owner, app)
        case 'write': return writeConfig(input, app)
        case 'backups': return api.agentBackups(owner, app)
        case 'restore': {
          const id = text(input.id, 100)
          if (!api.agentBackups(owner, app).some(backup => backup.id === id)) throw new Error('Backup not found')
          await confirm('恢复 AI 应用配置备份？', `应用：${app}`, `备份：${id}\n恢复前会保存当前配置。`)
          return api.agentRestore(owner, { app, id, confirmed: true })
        }
        case 'sessions.list': return api.agentSessionsList(owner, app)
        case 'sessions.read': return api.agentSessionsRead(owner, { app, file: text(input.file), maxBytes: input.maxBytes == null ? undefined : Number(input.maxBytes) })
        default: throw new Error('Unsupported configuration backend method')
      }
    }
    switch (method) {
      case 'assets.list':
        if (input.app !== 'codex') throw new Error('Only Codex pet assets are supported')
        return api.agentListAssets(owner, { app: 'codex', path: typeof input.path === 'string' ? input.path : 'pets' })
      case 'assets.stage': return stageCreate(input)
      case 'assets.chunk': {
        const stage = ownedStage(input.stageId), index = Number(input.index), data = text(input.contentBase64, Math.ceil(CHUNK_BYTES / 3) * 4)
        if (!Number.isSafeInteger(index) || !stage.files[index] || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('Invalid asset chunk')
        const bytes = Buffer.from(data, 'base64'), file = stage.files[index]
        if (!bytes.length || bytes.length > CHUNK_BYTES || input.offset !== file.received || file.received + bytes.length > file.bytes) throw new Error('Asset chunk offset/size mismatch')
        appendFileSync(file.file, bytes)
        file.received += bytes.length
        stage.timer.refresh()
        return { received: file.received }
      }
      case 'assets.discard': { const stage = stages.get(text(input.stageId, 80)); if (stage && !stage.committing) discard(stage); return true }
      case 'assets.commit': {
        const stage = ownedStage(input.stageId)
        if (stage.files.some(file => file.received !== file.bytes)) throw new Error('Asset stage is incomplete')
        stage.committing = true
        clearTimeout(stage.timer)
        try {
          api.validateAssetPaths(stage.app, stage.files.map(file => file.path))
          await confirm('安装 Codex 宠物资产？', `共 ${stage.files.length} 个文件，写入前保存覆盖快照。`, stage.files.map(file => file.path).join('\n'))
          return api.writeStagedAssets(stage.app, stage.files.map(file => ({ path: file.path, data: readFileSync(file.file) })), true)
        } finally { discard(stage) }
      }
      case 'assets.delete': {
        if (input.app !== 'codex' || !Array.isArray(input.paths) || !input.paths.length || input.paths.length > 20) throw new Error('Invalid Codex asset paths')
        const paths = input.paths.map(path => text(path))
        api.validateAssetPaths('codex', paths)
        if (paths.some(path => !path.includes('/'))) throw new Error('Deleting the asset root is not allowed')
        await confirm('删除 Codex 宠物资产？', '删除后不可恢复。', paths.join('\n'))
        return api.agentDeleteAssets(owner, { app: 'codex', paths, confirmed: true })
      }
      default: throw new Error('Unsupported pet backend method')
    }
  }
  function shutdown(): void {
    if (closed) return
    closed = true
    for (const control of controls.values()) { clearTimeout(control.timer); control.reject(new Error('Backend is closing')) }
    controls.clear()
    const errors: string[] = []
    for (const stage of [...stages.values()]) { try { discard(stage) } catch (error) { errors.push(messageError(error)) } }
    post({ type: 'shutdown.complete', ok: !errors.length, ...(errors.length ? { error: errors.join('; ') } : {}) })
    options.onShutdown?.()
  }
  options.port.on('message', ({ data: raw }) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const message = raw as Record<string, unknown>
    if (message.type === 'host.response') {
      const control = controls.get(Number(message.id))
      if (!control) return
      controls.delete(Number(message.id)); clearTimeout(control.timer)
      if (message.ok === true) control.resolve(message.data)
      else control.reject(new Error(messageError(message.error || 'Host control failed')))
      return
    }
    if (message.type === 'shutdown') { shutdown(); return }
    if (message.type === 'init') {
      try {
        if (initialized || closed || initializationError) throw new Error('Backend initialization is not repeatable')
        const context = object(message.context)
        if (message.pluginId !== options.pluginId || !Number.isSafeInteger(message.generation) || Number(message.generation) < 1 || !Number.isSafeInteger(message.wcId)) throw new Error('Invalid backend owner')
        if (context.protocolVersion !== 1 || ![context.appDataPath, context.packagePath, context.appExecPath].every(value => typeof value === 'string' && isAbsolute(value))) throw new Error('Native backend control protocol v1 is required; update eNest')
        service = createAgentConfigService({ homePath: options.homePath, appDataPath: String(context.appDataPath) })
        initialized = true
      } catch (error) { initializationError = messageError(error); shutdown() }
      return
    }
    if (!Number.isSafeInteger(message.id) || Number(message.id) < 1) return
    const id = Number(message.id)
    try {
      assertCurrent()
      if (message.pluginId !== options.pluginId || pending.has(id) || pending.size >= 24) throw new Error('Backend request owner/budget mismatch')
      if (typeof message.method !== 'string' || !Array.isArray(message.args) || message.args.length > 1 || Buffer.byteLength(JSON.stringify(message.args)) > 4 * 1024 * 1024) throw new Error('Invalid backend request')
      const input = message.args.length ? object(message.args[0]) : {}
      pending.add(id)
      void execute(message.method, input).then(data => { if (!closed) post({ id, ok: true, data }) }).catch(error => {
        if (!closed) post({ id, ok: false, error: messageError(error) })
      }).finally(() => pending.delete(id))
    } catch (error) { post({ id, ok: false, error: messageError(error) }) }
  })
  return { shutdown, get state() { return { initialized, closed, stages: stages.size, reservedBytes, pending: pending.size } } }
}

export function startAgentBackend(input: Pick<BackendOptions, 'pluginId' | 'mode'>): void {
  const port = (process as NodeJS.Process & { parentPort?: MessagePort }).parentPort
  if (!port) throw new Error('This backend requires an eNest utility process')
  const backend = createAgentBackend({ ...input, port, homePath: homedir(), onShutdown: () => process.exit(0) })
  process.once('SIGTERM', backend.shutdown)
  process.once('SIGINT', backend.shutdown)
}
