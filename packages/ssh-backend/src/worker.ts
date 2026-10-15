import * as ssh from './sshSessionManager'
import { sshWorkbench } from './sshWorkbench'
import { configureHostBridge, receiveHostReply, disposeHostBridge } from './hostBridge'
import { createRuntimeScope, type PluginRuntimeScope } from './runtimeScope'

interface ParentPort { postMessage(message: unknown): void; on(event: 'message', listener: (event: { data: any }) => void): void }
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (!port) throw new Error('SSH backend requires an Electron utility process')
let owner = ''
let scope: PluginRuntimeScope | undefined
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
  if (data?.hostResult !== undefined) { receiveHostReply(data); return }
  if (data?.type === 'init') {
    if (owner || typeof data.pluginId !== 'string' || !Number.isSafeInteger(data.generation)) return
    owner = data.pluginId
    configureHostBridge(owner, message => port.postMessage(message))
    scope = createRuntimeScope({ pluginId: owner, generation: data.generation, wcId: data.wcId })
    return
  }
  if (data?.type === 'dispose') {
    scope?.markClosing(); ssh.releaseSshSessions(owner); disposeHostBridge(); process.exit(0)
  }
  if (!Number.isSafeInteger(data?.id)) return
  void (async () => {
    if (!scope?.isCurrent() || data.pluginId !== owner) throw new Error('Invalid or closed backend owner')
    const method = Object.hasOwn(methods, data.method) ? methods[data.method] : undefined
    if (!method || !Array.isArray(data.args)) throw new Error('Unsupported SSH backend method')
    return method(owner, ...data.args)
  })().then(
    result => port.postMessage({ id: data.id, ok: true, data: result }),
    error => port.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  )
})
