/**
 * Anything backend entry: filesystem search (Spotlight / Everything HTTP),
 * open / reveal / trash and bounded preview reads over the Electron utility
 * message port. No renderer or host runtime imports.
 */
import { parentPort } from './parentPort'
import * as search from './search'
import * as files from './files'
import type { SearchOptions } from './types'

const port = parentPort
if (!port) throw new Error('anything service requires an Electron utility parent')

type Unknown = Record<string, unknown>

function searchOptions(value: unknown): SearchOptions {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('options 参数无效')
  const raw = value as Unknown
  const options: SearchOptions = {}
  if (raw.directory !== undefined) {
    if (typeof raw.directory !== 'string' || !raw.directory.trim()) throw new Error('directory 参数无效')
    options.directory = raw.directory
  }
  for (const key of ['limit', 'offset'] as const) {
    const item = raw[key]
    if (item === undefined) continue
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) throw new Error(`${key} 参数无效`)
    options[key] = Math.floor(item)
  }
  if (raw.sort !== undefined) {
    if (!['relevance', 'name', 'mtime', 'size'].includes(String(raw.sort))) throw new Error('sort 参数无效')
    options.sort = raw.sort as SearchOptions['sort']
  }
  if (raw.everythingPort !== undefined) {
    if (typeof raw.everythingPort !== 'number' || !Number.isInteger(raw.everythingPort) || raw.everythingPort < 0 || raw.everythingPort > 65535) throw new Error('everythingPort 参数无效')
    options.everythingPort = raw.everythingPort
  }
  if (raw.everythingAuth !== undefined) {
    if (typeof raw.everythingAuth !== 'string') throw new Error('everythingAuth 参数无效')
    options.everythingAuth = raw.everythingAuth
  }
  return options
}

function providerOptions(args: unknown[]): { everythingPort?: number; everythingAuth?: string } {
  const raw = args[0]
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('参数无效')
  const item = raw as Unknown
  const options: { everythingPort?: number; everythingAuth?: string } = {}
  if (item.everythingPort !== undefined) {
    if (typeof item.everythingPort !== 'number' || !Number.isInteger(item.everythingPort) || item.everythingPort < 0 || item.everythingPort > 65535) throw new Error('everythingPort 参数无效')
    options.everythingPort = item.everythingPort
  }
  if (item.everythingAuth !== undefined) {
    if (typeof item.everythingAuth !== 'string') throw new Error('everythingAuth 参数无效')
    options.everythingAuth = item.everythingAuth
  }
  return options
}

const methods: Record<string, (...args: never[]) => unknown> = {
  providers: (...args: never[]) => search.detectProviders(providerOptions(args)),
  search: (...args: never[]) => {
    const query = args[0] as unknown
    if (typeof query !== 'string' || !query.trim()) throw new Error('搜索内容为空')
    return search.searchFiles(query, searchOptions(args[1]))
  },
  abort: () => search.abortSearch(),
  open: (...args: never[]) => files.openPath(args[0]),
  reveal: (...args: never[]) => files.revealPath(args[0]),
  trash: (...args: never[]) => files.trashPath(args[0]),
  stat: (...args: never[]) => files.statPath(args[0]),
  readText: (...args: never[]) => files.readTextFile(args[0], args[1]),
  readImage: (...args: never[]) => files.readImageFile(args[0], args[1])
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
    // Keep IPC messages bounded even if a preview read grows unexpectedly.
    const bytes = Buffer.byteLength(JSON.stringify(result) ?? '')
    if (bytes > 8 * 1024 * 1024) throw new Error('anything result exceeds 8 MiB; narrow the query')
    port.postMessage({ id, ok: true, data: result })
  } catch (error) {
    port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
