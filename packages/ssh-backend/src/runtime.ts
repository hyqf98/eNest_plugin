import * as ssh from './sshSessionManager'
import { sshWorkbench } from './sshWorkbench'
import { configureHostBridge, receiveHostReply, disposeHostBridge, hostCall } from './hostBridge'
import { createRuntimeScope, type PluginRuntimeScope } from './runtimeScope'

export interface SshWorkerExtensionContext {
  pluginId: string
  scope: PluginRuntimeScope
  pageOrigin: string | null
  hostCall<T>(method: string, params?: Record<string, unknown>): Promise<T>
}
export interface SshWorkerExtension {
  methods: Record<string, (...args: any[]) => unknown>
  dispose?(): void | Promise<void>
}
export function startSshWorker(createExtension?: (context: SshWorkerExtensionContext) => SshWorkerExtension): void {
  interface ParentPort { postMessage(message: unknown): void; on(event: 'message', listener: (event: { data: any }) => void): void }
  const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
  if (!port) throw new Error('SSH backend requires an Electron utility process')
  let owner = ''
  let scope: PluginRuntimeScope | undefined
  let closing = false
  let extension: SshWorkerExtension | undefined
  const active = new Set<number>()
  const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? String(entry) : entry) ?? '')
  const methods: Record<string, (...args: any[]) => unknown> = {
    'ssh.connect': ssh.sshConnect, 'ssh.write': ssh.sshWrite, 'ssh.resize': ssh.sshResize,
    'ssh.disconnect': ssh.sshDisconnect, 'ssh.listSessions': ssh.sshListSessions, 'ssh.exec': ssh.sshExec,
    'ssh.metrics.start': ssh.sshMetricsStart, 'ssh.metrics.stop': ssh.sshMetricsStop, 'ssh.metrics.latest': ssh.sshMetricsLatest,
    'ssh.completion.suggest': ssh.sshCompletionSuggest, 'ssh.sftp.list': ssh.sshSftpList,
    'ssh.sftp.download': ssh.sshSftpDownload, 'ssh.sftp.upload': ssh.sshSftpUpload,
    'ssh.sftp.mkdir': ssh.sshSftpMkdir, 'ssh.sftp.rename': ssh.sshSftpRename,
    'ssh.sftp.delete': ssh.sshSftpDelete, 'ssh.sftp.chmod': ssh.sshSftpChmod,
    'ssh.workbench': sshWorkbench
  }
  port.on('message', ({ data }) => {
    if (data?.type === 'host.response') { receiveHostReply(data); return }
    if (data?.type === 'init') {
      if (closing || owner || typeof data.pluginId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(data.pluginId)
        || !Number.isSafeInteger(data.generation) || data.generation < 1 || !Number.isSafeInteger(data.wcId) || data.wcId < 1
        || data.context?.protocolVersion !== 1) return
      owner = data.pluginId
      configureHostBridge(owner, message => port.postMessage(message))
      scope = createRuntimeScope({ pluginId: owner, generation: data.generation, wcId: data.wcId })
      extension = createExtension?.({
        pluginId: owner,
        scope,
        pageOrigin: typeof data.context.pageOrigin === 'string' ? data.context.pageOrigin : null,
        hostCall: (method, params) => hostCall(owner, method, params)
      })
      for (const [name, method] of Object.entries(extension?.methods ?? {})) {
        if (Object.hasOwn(methods, name) || !/^[a-z][a-zA-Z0-9._-]{0,99}$/.test(name) || typeof method !== 'function') throw new Error('Invalid backend extension method')
        methods[name] = method
      }
      return
    }
    if (data?.type === 'shutdown') {
      if (closing) return
      closing = true
      scope?.markClosing()
      ssh.releaseSshSessions(owner)
      // Extensions close native resources synchronously; host release replies get a bounded grace.
      const disposeExtension = Promise.resolve().then(() => extension?.dispose?.())
      let timer: ReturnType<typeof setTimeout> | undefined
      const grace = new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); timer.unref?.() })
      void Promise.race([disposeExtension.catch(() => {}), grace]).finally(async () => {
        if (timer) clearTimeout(timer)
        disposeHostBridge()
        await scope?.dispose()
        port.postMessage({ type: 'shutdown.complete' })
        process.exit(0)
      })
      return
    }
    if (closing || !Number.isSafeInteger(data?.id) || data.id < 1) return
    if (active.has(data.id)) return
    const reply = (value: object): void => { if (!closing) port.postMessage({ id: data.id, ...value }) }
    if (active.size >= 32) { reply({ ok: false, error: 'SSH backend request limit reached' }); return }
    active.add(data.id)
    void (async () => {
      if (!scope?.isCurrent() || data.pluginId !== owner) throw new Error('Invalid or closed backend owner')
      const method = Object.hasOwn(methods, data.method) ? methods[data.method] : undefined
      if (!method || !Array.isArray(data.args)) throw new Error('Unsupported SSH backend method')
      if (bytes(data.args) > 4 * 1024 * 1024) throw new Error('SSH backend request exceeds 4 MiB')
      const result = await method(owner, ...data.args)
      if (bytes({ id: data.id, ok: true, data: result }) > 8 * 1024 * 1024) throw new Error('SSH backend response exceeds 8 MiB')
      return result
    })().then(
      result => reply({ ok: true, data: result }),
      error => reply({ ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 4096) })
    ).finally(() => active.delete(data.id))
  })

}
