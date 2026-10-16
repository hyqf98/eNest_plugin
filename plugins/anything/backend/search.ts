/**
 * Search engines for Anything: Spotlight via mdfind (darwin) and the
 * Everything HTTP server (win32 / any host that runs it). Mirrors the query
 * token semantics of ZTools mac-file-search: quoted exact terms, `-term`
 * exclusions, `*` wildcards.
 */
import { spawn, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'

import type { FileInfo, ProvidersReport, SearchOptions, SearchResult, SearchSort } from './types'

const COLLECT_CAP = 3000
const MDFIND_TIMEOUT_MS = 12000
const HTTP_TIMEOUT_MS = 3500

export interface QueryTokens {
  includes: { raw: string; quoted: boolean }[]
  excludes: string[]
}

export function parseQuery(input: string): QueryTokens {
  const tokens: QueryTokens = { includes: [], excludes: [] }
  const regex = /"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(input)) !== null) {
    const quoted = match[1] !== undefined || match[2] !== undefined || match[3] !== undefined || match[4] !== undefined
    let raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? ''
    if (!raw) continue
    let escapedMinus = false
    if (!quoted && raw.startsWith('\\-')) {
      raw = raw.slice(1)
      escapedMinus = true
    }
    let excluded = false
    if (!quoted && !escapedMinus && raw.startsWith('-') && raw.length > 1) {
      excluded = true
      raw = raw.slice(1)
    }
    if (!raw) continue
    if (excluded) tokens.excludes.push(raw)
    else tokens.includes.push({ raw, quoted })
  }
  return tokens
}

function escapeMdfind(value: string, keepWildcard: boolean): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\*/g, keepWildcard ? '*' : '\\*')
}

function buildMdfindNameClause(term: { raw: string; quoted: boolean }): string {
  if (term.quoted) {
    const exact = escapeMdfind(term.raw, false)
    return `(kMDItemFSName == "${exact}"cd || kMDItemDisplayName == "${exact}"cd)`
  }
  const useWildcard = term.raw.includes('*')
  const escaped = escapeMdfind(term.raw, useWildcard)
  const pattern = useWildcard ? escaped : `*${escaped}*`
  return `(kMDItemFSName == "${pattern}"cd || kMDItemDisplayName == "${pattern}"cd)`
}

export function buildMdfindQuery(tokens: QueryTokens): string {
  if (!tokens.includes.length) return ''
  const clauses = tokens.includes.map(term => buildMdfindNameClause(term))
  for (const raw of tokens.excludes) {
    const clause = buildMdfindNameClause({ raw, quoted: false })
    clauses.push(`!${clause}`)
  }
  return clauses.join(' && ')
}

function statInfo(filePath: string): FileInfo | null {
  try {
    const stats = fs.statSync(filePath)
    return {
      path: filePath,
      name: path.basename(filePath),
      dir: path.dirname(filePath),
      ext: path.extname(filePath).slice(1).toLowerCase(),
      isDirectory: stats.isDirectory(),
      size: stats.size,
      mtimeMs: Math.round(stats.mtimeMs)
    }
  } catch {
    return null
  }
}

let mdfindAvailable: boolean | null = null

export function spotlightAvailable(): boolean {
  if (process.platform !== 'darwin') return false
  if (mdfindAvailable === null) {
    try {
      mdfindAvailable = execFileSync('which', ['mdfind'], { timeout: 3000 }).toString().trim().length > 0
    } catch {
      mdfindAvailable = false
    }
  }
  return mdfindAvailable
}

let activeMdfind: { child: import('node:child_process').ChildProcess; cancelled: boolean } | null = null

function abortMdfind(): void {
  if (!activeMdfind) return
  activeMdfind.cancelled = true
  if (activeMdfind.child.exitCode === null && !activeMdfind.child.killed) activeMdfind.child.kill('SIGTERM')
  activeMdfind = null
}

function sortFiles(files: FileInfo[], sort: SearchSort): FileInfo[] {
  const list = [...files]
  if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  else if (sort === 'mtime') list.sort((a, b) => b.mtimeMs - a.mtimeMs)
  else if (sort === 'size') list.sort((a, b) => b.size - a.size)
  return list
}

function runMdfind(query: string, directory: string | undefined, collectCap: number): Promise<FileInfo[]> {
  abortMdfind()
  return new Promise((resolve, reject) => {
    const args: string[] = []
    if (directory) args.push('-onlyin', directory)
    args.push(query)
    const child = spawn('mdfind', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const task = { child, cancelled: false }
    activeMdfind = task
    const timer = setTimeout(() => {
      task.cancelled = true
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
    }, MDFIND_TIMEOUT_MS)
    const seen = new Set<string>()
    const results: FileInfo[] = []
    let remainder = ''
    let stderr = ''
    const finalize = () => resolve(results)
    child.stdout.on('data', (chunk: Buffer) => {
      const text = remainder + chunk.toString('utf8')
      const lines = text.split(/\r?\n/)
      remainder = lines.pop() || ''
      for (const line of lines) {
        const filePath = line.trim()
        if (!filePath || seen.has(filePath)) continue
        seen.add(filePath)
        const info = statInfo(filePath)
        if (info) results.push(info)
        if (results.length >= collectCap) {
          task.cancelled = true
          if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
          return
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', error => {
      clearTimeout(timer)
      if (activeMdfind === task) activeMdfind = null
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (activeMdfind === task) activeMdfind = null
      if (task.cancelled) return finalize()
      if (code !== 0 && results.length === 0 && stderr.trim()) {
        reject(new Error(stderr.trim()))
        return
      }
      if (remainder) {
        const filePath = remainder.trim()
        if (filePath && !seen.has(filePath) && results.length < collectCap) {
          const info = statInfo(filePath)
          if (info) results.push(info)
        }
      }
      finalize()
    })
  })
}

// —— Everything HTTP server (Everything 1.4+, 选项 -> HTTP 服务器) —— //

interface EverythingOptions { port: number; auth?: string }

interface EverythingRawItem {
  type?: string
  name?: string
  path?: string
  size?: number
  last_write_time?: number
  date_modified?: number
}

function everythingRequest(target: string, auth: string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(target, {
      timeout: timeoutMs,
      headers: auth ? { authorization: `Basic ${Buffer.from(auth).toString('base64')}` } : {}
    }, response => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`Everything HTTP ${response.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 8 * 1024 * 1024) {
          request.destroy()
          reject(new Error('Everything 响应超过 8 MiB'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      response.on('error', reject)
    })
    request.on('timeout', () => { request.destroy(); reject(new Error('Everything HTTP 请求超时')) })
    request.on('error', reject)
  })
}

export function buildEverythingQuery(tokens: QueryTokens, directory: string | undefined): string {
  const parts: string[] = []
  for (const term of tokens.includes) {
    if (term.quoted) parts.push(`"${term.raw}"`)
    else parts.push(term.raw)
  }
  for (const raw of tokens.excludes) parts.push(`!${raw}`)
  if (directory) parts.push(`path:"${directory.replace(/"/g, '')}"`)
  return parts.join(' ')
}

function everythingSortParam(sort: SearchSort): { sort?: number; ascending: number } {
  if (sort === 'name') return { sort: 1, ascending: 1 }
  if (sort === 'size') return { sort: 3, ascending: 0 }
  if (sort === 'mtime') return { sort: 6, ascending: 0 }
  return { ascending: 1 }
}

function joinEverythingPath(item: EverythingRawItem): string {
  const name = String(item.name ?? '')
  const dir = String(item.path ?? '')
  if (!dir) return name
  if (dir.toLowerCase().endsWith(name.toLowerCase()) && name.length > 0) return dir
  return dir.endsWith(path.sep) || dir.endsWith('/') || dir.endsWith('\\') ? dir + name : `${dir}${path.sep}${name}`
}

function mapEverythingItem(item: EverythingRawItem): FileInfo {
  const full = joinEverythingPath(item)
  const mtimeRaw = item.last_write_time ?? item.date_modified ?? 0
  return {
    path: full,
    name: String(item.name ?? path.basename(full)),
    dir: path.dirname(full),
    ext: path.extname(String(item.name ?? full)).slice(1).toLowerCase(),
    isDirectory: item.type === 'folder' || item.type === 'volume',
    size: Number(item.size ?? 0) || 0,
    mtimeMs: Math.round((Number(mtimeRaw) || 0) * 1000)
  }
}

export async function everythingSearch(tokens: QueryTokens, options: EverythingOptions, search: SearchOptions): Promise<{ files: FileInfo[]; total: number }> {
  const limit = Math.max(1, Math.min(search.limit ?? 100, 500))
  const offset = Math.max(0, Math.floor(search.offset ?? 0))
  const query = buildEverythingQuery(tokens, search.directory)
  if (!query) return { files: [], total: 0 }
  const { sort, ascending } = everythingSortParam(search.sort ?? 'relevance')
  const params = new URLSearchParams({
    search: query,
    count: String(limit),
    offset: String(offset),
    json: '1',
    path_column: '1',
    size_column: '1',
    date_column: '1',
    ascending: String(ascending)
  })
  if (sort !== undefined) params.set('sort', String(sort))
  const target = `http://127.0.0.1:${options.port}/search.json?${params.toString()}`
  const body = await everythingRequest(target, options.auth, HTTP_TIMEOUT_MS)
  let parsed: { totalResults?: number; results?: EverythingRawItem[] }
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('Everything 响应不是有效 JSON，请确认端口指向 Everything HTTP 服务')
  }
  const files = (parsed.results ?? []).map(mapEverythingItem)
  return { files, total: Number(parsed.totalResults ?? files.length) || files.length }
}

let everythingProbe: { at: number; ok: boolean; detail: string } | null = null

export async function everythingAvailable(port: number, auth: string | undefined, force = false): Promise<{ ok: boolean; detail: string }> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, detail: '未配置 Everything HTTP 端口' }
  const now = Date.now()
  if (!force && everythingProbe && now - everythingProbe.at < 30000) {
    return { ok: everythingProbe.ok, detail: everythingProbe.detail }
  }
  let outcome: { ok: boolean; detail: string }
  try {
    await everythingRequest(`http://127.0.0.1:${port}/search.json?search=a&count=1&json=1`, auth, 2500)
    outcome = { ok: true, detail: `127.0.0.1:${port} 可用` }
  } catch (error) {
    outcome = { ok: false, detail: `127.0.0.1:${port} 不可达：${error instanceof Error ? error.message : String(error)}` }
  }
  everythingProbe = { at: now, ...outcome }
  return outcome
}

export function invalidateEverythingProbe(): void {
  everythingProbe = null
}

export async function detectProviders(options: { everythingPort?: number; everythingAuth?: string } = {}): Promise<ProvidersReport> {
  const providers: ProvidersReport['providers'] = []
  const spotlight = spotlightAvailable()
  providers.push({
    id: 'spotlight',
    label: 'Spotlight (mdfind)',
    available: spotlight,
    detail: spotlight ? 'macOS 系统索引，即时搜索' : process.platform === 'darwin' ? '未找到 mdfind 命令' : '仅 macOS 可用'
  })
  const everything = await everythingAvailable(options.everythingPort ?? 0, options.everythingAuth)
  providers.push({ id: 'everything', label: 'Everything HTTP', available: everything.ok, detail: everything.detail })
  let active: string | null = null
  if (spotlight) active = 'spotlight'
  else if (everything.ok) active = 'everything'
  return { platform: process.platform, providers, active }
}

export async function searchFiles(query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const started = Date.now()
  const trimmed = String(query ?? '').trim()
  if (!trimmed) throw new Error('搜索内容为空')
  const tokens = parseQuery(trimmed)
  if (!tokens.includes.length) throw new Error('需要至少一个关键词（排除词不能单独使用）')
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500))
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const sort: SearchSort = options.sort ?? 'relevance'

  // darwin 优先 Spotlight（Everything 本就不运行于 mac）；其余平台依赖 Everything HTTP。
  if (!spotlightAvailable()) {
    const everything = await everythingAvailable(options.everythingPort ?? 0, options.everythingAuth)
    if (everything.ok) {
      const { files, total } = await everythingSearch(tokens, { port: options.everythingPort ?? 0, auth: options.everythingAuth }, { ...options, limit, offset, sort })
      return { results: files, provider: 'everything', total, collected: files.length, truncated: offset + files.length < total, elapsedMs: Date.now() - started }
    }
    throw new Error(everything.detail === '未配置 Everything HTTP 端口'
      ? '当前平台无可用搜索引擎：Windows 请运行 Everything 并开启 HTTP 服务后在设置中填端口；Linux 暂不支持'
      : `Everything 不可用：${everything.detail}`)
  }

  const mdfindQuery = buildMdfindQuery(tokens)
  if (!mdfindQuery) throw new Error('查询无法解析')
  const collectCap = sort === 'relevance' ? offset + limit : COLLECT_CAP
  const files = await runMdfind(mdfindQuery, options.directory, Math.max(collectCap, offset + limit))
  const sorted = sortFiles(files, sort)
  const page = sorted.slice(offset, offset + limit)
  return {
    results: page,
    provider: 'spotlight',
    total: sorted.length,
    collected: sorted.length,
    truncated: offset + page.length < sorted.length,
    elapsedMs: Date.now() - started
  }
}

export function abortSearch(): boolean {
  const had = activeMdfind !== null
  abortMdfind()
  return had
}
