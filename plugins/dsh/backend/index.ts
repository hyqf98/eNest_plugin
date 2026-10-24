import {
  acquireActivity, currentRuntimeScope, disposeRuntime, initializeRuntime,
  postBackendMessage, receiveHostResponse, type BackendMessagePort
} from '@backend/runtimeContext'
import { dshWorkbenchActionGroup, dshWorkbenchCall } from '@backend/workbench'
import { releaseDshRuntime } from '@backend/dshRuntimeService'
import type { DshWorkbenchRequest } from '@backend/contracts/dsh-workbench'

const port = (process as NodeJS.Process & { parentPort?: BackendMessagePort }).parentPort
if (!port) throw new Error('This backend requires the eNest native utility process')
const jobs = new Map<string, Promise<void>>()
let initializationError: string | undefined
let shutdown: Promise<void> | undefined

function errorMessage(error: unknown): string { return String(error instanceof Error ? error.message : error).slice(0, 4096) }

async function stop(): Promise<void> {
  if (shutdown) return shutdown
  let owner
  try { owner = currentRuntimeScope() } catch { process.exitCode = 0; return }
  // Abort first, outside the DSH maintenance mutex, so downloads cannot block shutdown.
  owner.markClosing()
  shutdown = Promise.allSettled([
    releaseDshRuntime(owner.owner.pluginId, owner.owner.generation),
    disposeRuntime(),
    ...jobs.values()
  ]).then(results => {
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    postBackendMessage({ type: 'shutdown.complete', ok: !failure, ...(failure ? { error: errorMessage(failure.reason) } : {}) })
  }).finally(() => { process.exit(0) })
  return shutdown
}
process.once('SIGTERM', () => { void stop() })
process.once('SIGINT', () => { void stop() })

port.on('message', ({ data: raw }) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const message = raw as Record<string, unknown>
  if (message.type === 'init') {
    try { initializeRuntime(port, message) }
    catch (error) { initializationError = errorMessage(error) }
    return
  }
  if (message.type === 'host.response') { receiveHostResponse(message); return }
  if (message.type === 'shutdown') { void stop(); return }
  if (!Number.isSafeInteger(message.id)) return
  try {
    if (initializationError) throw new Error(initializationError)
    const scope = currentRuntimeScope()
    if (message.pluginId !== scope.owner.pluginId) throw new Error('backend request owner mismatch')
    if (message.method !== 'workbench' || !Array.isArray(message.args) || message.args.length !== 2) throw new Error('invalid DSH backend request')
    const [request, jobId] = message.args as [DshWorkbenchRequest, unknown]
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid DSH workbench request')
    dshWorkbenchActionGroup(request.action)
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(jobId) || jobs.has(jobId)) throw new Error('invalid or duplicate DSH job')
    if (jobs.size >= 24) throw new Error('too many pending DSH jobs')
    const proxy = message.proxy as Record<string, unknown> | undefined
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
      if (typeof proxy?.[key] === 'string') process.env[key] = proxy[key]
      else delete process.env[key]
      delete process.env[key.toLowerCase()]
    }
    // Acknowledge the transport immediately; long operations belong to the plugin job.
    postBackendMessage({ id: message.id, ok: true, data: { jobId } })
    const job = (async () => {
      let release: (() => void) | undefined
      try {
        release = await acquireActivity(`dsh:${request.action}`)
        const data = await dshWorkbenchCall(scope.owner.pluginId, request)
        if (scope.isCurrent()) postBackendMessage({ event: 'dsh.job', data: { jobId, ok: true, data } })
      } catch (error) {
        if (scope.isCurrent()) postBackendMessage({ event: 'dsh.job', data: { jobId, ok: false, error: errorMessage(error) } })
      } finally { release?.(); jobs.delete(jobId) }
    })()
    jobs.set(jobId, job)
  } catch (error) {
    // Init can fail before runtimeContext has a port; the response must still reach the caller.
    port.postMessage({ id: message.id, ok: false, error: errorMessage(error) })
  }
})
