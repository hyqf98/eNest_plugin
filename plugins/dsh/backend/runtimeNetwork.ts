import { Agent, ProxyAgent, fetch as request, type Dispatcher } from 'undici'
import { SocksClient } from 'socks'
import { connect as connectTls } from 'node:tls'
import { isIP } from 'node:net'
import { currentRuntimeScope, hostRequest } from '@backend/runtimeContext'

interface ProxyRoute { kind: 'direct' | 'http' | 'https' | 'socks4' | 'socks5'; host?: string; port?: number }
const agents = new Map<string, Dispatcher>()
let registeredCleanup = false

export function parseProxyRules(value: unknown): ProxyRoute[] {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('invalid host proxy response')
  const routes: ProxyRoute[] = []
  for (const rule of value.split(';').map(part => part.trim()).filter(Boolean).slice(0, 16)) {
    if (rule === 'DIRECT') { routes.push({ kind: 'direct' }); continue }
    const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\[[^\]]+\]|[^\s:/]+):(\d+)$/.exec(rule)
    if (!match) throw new Error(`unsupported host proxy route: ${rule.slice(0, 160)}`)
    const port = Number(match[3])
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid proxy port')
    const kinds = { PROXY: 'http', HTTPS: 'https', SOCKS: 'socks4', SOCKS4: 'socks4', SOCKS5: 'socks5' } as const
    routes.push({ kind: kinds[match[1] as keyof typeof kinds], host: match[2].replace(/^\[|\]$/g, ''), port })
  }
  if (!routes.length) throw new Error('host returned no proxy route')
  return routes
}

function dispatcher(route: ProxyRoute): Dispatcher {
  const key = JSON.stringify(route)
  const existing = agents.get(key)
  if (existing) return existing
  let agent: Dispatcher
  if (route.kind === 'direct') agent = new Agent()
  else if (route.kind === 'http' || route.kind === 'https') {
    const host = route.host!.includes(':') ? `[${route.host}]` : route.host
    agent = new ProxyAgent(`${route.kind}://${host}:${route.port}`)
  } else {
    agent = new Agent({ connect(options, callback) {
      const hostname = options.hostname.replace(/^\[|\]$/g, '')
      void SocksClient.createConnection({
        proxy: { host: route.host!, port: route.port!, type: route.kind === 'socks5' ? 5 : 4 },
        command: 'connect', destination: { host: hostname, port: Number(options.port) || (options.protocol === 'https:' ? 443 : 80) },
        timeout: 10_000
      }).then(({ socket }) => {
        if (options.protocol !== 'https:') { callback(null, socket); return }
        const secure = connectTls({ socket, servername: options.servername || (!isIP(hostname) ? hostname : undefined), ALPNProtocols: ['http/1.1'] })
        let completed = false
        const finish = (error?: Error) => {
          if (completed) return
          completed = true
          clearTimeout(timer)
          secure.removeListener('error', failed)
          if (error) { secure.destroy(); callback(error, null) }
          else callback(null, secure)
        }
        const failed = (error: Error) => finish(error)
        const timer = setTimeout(() => finish(new Error('proxy TLS handshake timed out')), 10_000)
        timer.unref()
        secure.once('error', failed)
        secure.once('secureConnect', () => finish())
      }, error => callback(error instanceof Error ? error : new Error(String(error)), null))
    } })
  }
  agents.set(key, agent)
  if (agents.size > 16) {
    const first = agents.entries().next().value as [string, Dispatcher]
    agents.delete(first[0])
    void first[1].close().catch(() => {})
  }
  if (!registeredCleanup) {
    registeredCleanup = true
    currentRuntimeScope().addDisposer(async () => {
      await Promise.allSettled([...agents.values()].map(value => value.destroy()))
      agents.clear()
    })
  }
  return agent
}

/** Resolve Chromium's current system/PAC/explicit proxy for each request and redirect. */
export async function fetchRuntime(url: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
  let target = new URL(url)
  for (let redirects = 0; redirects <= 10; redirects++) {
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('unsafe runtime download URL')
    init.signal?.throwIfAborted()
    const resolved = await hostRequest('network.resolveProxy', { url: target.href }) as { proxy?: unknown }
    const routes = parseProxyRules(resolved?.proxy)
    let response: Awaited<ReturnType<typeof request>> | undefined
    let lastError: unknown
    for (const route of routes) {
      try {
        response = await request(target.href, { ...init, dispatcher: dispatcher(route), redirect: 'manual' })
        break
      } catch (error) { init.signal?.throwIfAborted(); lastError = error }
    }
    if (!response) throw lastError instanceof Error ? lastError : new Error('runtime download connection failed')
    const location = response.headers.get('location')
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response as unknown as Response
    await response.body?.cancel()
    const next = new URL(location, target)
    if (target.protocol === 'https:' && next.protocol !== 'https:') throw new Error('runtime download cannot redirect from HTTPS to HTTP')
    target = next
  }
  throw new Error('too many runtime download redirects')
}
