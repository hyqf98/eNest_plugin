/** Read-only remote facts. No PTY access and no user text in an exec command. */
const CONTROL = /[\x00-\x1f\x7f-\x9f]/
const SAFE_NAME = /^[\p{L}\p{N}\p{M}_./:@%+,=~-]$/u
const MAX_ENTRIES = 4096
const abortError = () => Object.assign(new Error('提示读取已取消'), { name: 'AbortError' })

// This constant is the entire exec payload. Do not interpolate prefixes, cwd or paths.
// Only absolute PATH directories are inspected; no rc files or candidate programs run.
const COMMAND_SCAN = `enest_saved_ifs=$IFS
IFS=:
set -f
set -- $PATH
IFS=$enest_saved_ifs
set +f
enest_dirs=0
enest_count=0
for enest_dir do
  enest_dirs=$((enest_dirs + 1))
  [ "$enest_dirs" -le 32 ] || break
  case "$enest_dir" in /*) ;; *) continue ;; esac
  for enest_file in "$enest_dir"/*; do
    [ -f "$enest_file" ] && [ -x "$enest_file" ] || continue
    printf '%s\\0' "\${enest_file##*/}"
    enest_count=$((enest_count + 1))
    [ "$enest_count" -lt 2048 ] || exit 0
  done
done`
export const COMMAND_SCAN_COMMAND = `/bin/sh -c '${COMMAND_SCAN.replace(/'/g, "'\\''")}'`

/** Decode a simple current word, including an unfinished quote, without evaluating it. */
export function pathContext(line, cwd) {
  if (typeof line !== 'string' || line.length > 12000 || CONTROL.test(line)) return null
  let value = '', quote = '', escaped = false, started = false, start = 0, words = []
  const finish = () => { if (started) words.push(value); value = ''; started = false }
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (escaped) {
      if (quote === '"' && !/[\\$`"]/.test(ch)) value += '\\'
      value += ch; escaped = false; continue
    }
    if (ch === '\\' && quote !== "'") { if (!started) start = i; started = true; escaped = true; continue }
    if (quote) {
      if (ch === quote) quote = ''
      else { if (quote === '"' && /[$`!]/.test(ch)) return null; value += ch }
      continue
    }
    if (ch === "'" || ch === '"') { if (!started) start = i; started = true; quote = ch; continue }
    if (/[$`()<>!*?\[\]{}]/.test(ch)) return null
    if (ch === '#' && !started) return null
    if (/[|;&]/.test(ch)) { finish(); words = []; continue }
    if (/\s/.test(ch)) { finish(); continue }
    if (!started) start = i
    started = true; value += ch
  }
  if (escaped) return null
  if (!started) start = line.length
  const rawWord = line.slice(start), homeRelative = rawWord.startsWith('~/')
  if (value.startsWith('-') || rawWord.startsWith('~') && !value.startsWith('~/')) return null
  const slash = value.lastIndexOf('/'), directoryPrefix = slash < 0 ? '' : value.slice(0, slash + 1)
  let directory
  if (homeRelative) directory = '.' + directoryPrefix.slice(1)
  else if (directoryPrefix.startsWith('/')) directory = directoryPrefix
  else if (typeof cwd === 'string' && cwd.startsWith('/') && !CONTROL.test(cwd)) directory = `${cwd.replace(/\/$/, '')}/${directoryPrefix || '.'}`
  else return null
  // A bare first word belongs to command completion, not the filesystem.
  if (!words.length && !directoryPrefix) return null
  return { line, value, quote, start, words, directory, directoryPrefix, prefix: value.slice(slash + 1), directoriesOnly: words.length === 1 && words[0] === 'cd' }
}

/** Preserve the original spelling and append shell-literal suffixes only. */
export function pathCandidate(context, entry) {
  const name = entry?.name
  if (!context || typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || CONTROL.test(name) || !name.startsWith(context.prefix)) return null
  const isDirectory = entry.type === 'dir'
  if (context.directoriesOnly && !isDirectory || !context.prefix.startsWith('.') && name.startsWith('.')) return null
  const token = context.directoryPrefix + name + (isDirectory ? '/' : '')
  if (!token.startsWith(context.value)) return null
  const rest = token.slice(context.value.length)
  let suffix
  if (context.quote === "'") suffix = rest.replace(/'/g, "'\\''") + "'"
  else if (context.quote === '"') {
    if (rest.includes('!')) return null
    suffix = rest.replace(/[\\$`"]/g, '\\$&') + '"'
  } else suffix = [...rest].map((ch, index) => SAFE_NAME.test(ch) && !(/[~=]/.test(ch) && !context.value && index === 0) ? ch : `\\${ch}`).join('')
  if (!suffix || CONTROL.test(suffix)) return null
  return { kind: isDirectory ? 'directory' : 'path', label: name + (isDirectory ? '/' : ''), detail: `远端 SFTP · ${context.directory}`, arguments: '', fullCommand: context.line + suffix, insertText: suffix, rank: 4, source: 'remote-path', directory: isDirectory }
}

export function commandNames(output) {
  return [...new Set(String(output || '').split('\0').filter(name => name && name.length <= 256 && !CONTROL.test(name) && !/[\/\\]/.test(name)))].slice(0, 2048).sort()
}

/** Two physical reads maximum; abort removes waiters, never writes Ctrl+C to a terminal. */
export class RemoteReadCache {
  constructor({ now = Date.now, waitMs = 6000 } = {}) { this.now = now; this.waitMs = waitMs; this.cache = new Map(); this.flights = new Map(); this.queue = []; this.active = 0; this.generation = 0; this.disposed = false }
  read(key, ttl, loader, signal) {
    if (this.disposed || signal?.aborted) return Promise.reject(abortError())
    const cached = this.cache.get(key)
    if (cached && cached.until > this.now()) return cached.error ? Promise.reject(cached.error) : Promise.resolve(cached.value)
    let task = this.flights.get(key)
    if (!task) {
      if (this.queue.length >= 16) return Promise.reject(new Error('远端读取繁忙，请稍后重试'))
      task = { key, ttl, loader, consumers: new Set(), generation: this.generation }; this.flights.set(key, task); this.queue.push(task)
    }
    const promise = new Promise((resolve, reject) => {
      let timer
      const done = (error, value) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); task.consumers.delete(done)
        if (!task.started && !task.consumers.size) { this.queue = this.queue.filter(item => item !== task); if (this.flights.get(key) === task) this.flights.delete(key) }
        error ? reject(error) : resolve(value)
      }
      const abort = () => done(abortError())
      task.consumers.add(done); signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => done(new Error('远端读取超时，可继续使用本地提示')), this.waitMs)
    })
    this.pump()
    return promise
  }
  pump() {
    while (!this.disposed && this.active < 2 && this.queue.length) {
      const task = this.queue.shift()
      if (!task.consumers.size || task.generation !== this.generation) { if (this.flights.get(task.key) === task) this.flights.delete(task.key); continue }
      task.started = true
      this.active++
      Promise.resolve().then(task.loader).then(value => this.finish(task, null, value), error => this.finish(task, error)).finally(() => { this.active--; this.pump() })
    }
  }
  finish(task, error, value) {
    if (!this.disposed && task.generation === this.generation) {
      if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value)
      this.cache.delete(task.key); this.cache.set(task.key, { value, error, until: this.now() + (error ? 1500 : task.ttl) })
    }
    if (this.flights.get(task.key) === task) this.flights.delete(task.key)
    for (const done of [...task.consumers]) done(error, value)
  }
  invalidate() {
    this.generation++; this.cache.clear()
    for (const task of this.flights.values()) for (const done of [...task.consumers]) done(abortError())
    this.flights.clear(); this.queue = []
  }
  dispose() { this.disposed = true; this.invalidate() }
}

export function createRemoteCompletion({ list, exec, commandContext, cache = new RemoteReadCache() }) {
  function plan(snapshot, preferences = {}) {
    if (preferences.enabled === false || !snapshot || snapshot.cursor !== snapshot.text.length) return null
    const parsed = commandContext?.(snapshot.text)
    if (preferences.remoteCommands && parsed && !parsed.words.length && /^[\p{L}\p{N}_+.-]+$/u.test(parsed.current)) return { kind: 'commands', parsed }
    const path = preferences.remotePaths && pathContext(snapshot.text, snapshot.cwd)
    return path ? { kind: 'paths', path } : null
  }
  async function load(sessionId, snapshot, preferences, { signal } = {}) {
    const request = plan(snapshot, preferences)
    if (!request || !sessionId) return { items: [], status: '' }
    try {
      if (request.kind === 'commands') {
        const names = await cache.read(`${sessionId}:commands`, 60000, async () => {
          const result = await exec({ sessionId, command: COMMAND_SCAN_COMMAND, timeoutMs: 4500 })
          if (result.exitCode !== 0) throw new Error('远端 PATH 暂不可用')
          return commandNames(result.stdout)
        }, signal)
        const { parsed } = request
        return { items: names.filter(name => name.startsWith(parsed.current) && name !== parsed.current).slice(0, 40).flatMap(name => {
          // Executable names with shell metacharacters are omitted; paths can still complete safely.
          if (!/^[\p{L}\p{N}\p{M}_+.=-]+$/u.test(name)) return []
          const fullCommand = snapshot.text.slice(0, parsed.start) + name
          return [{ kind: 'remote-command', label: name, fullCommand, insertText: fullCommand.slice(snapshot.text.length), detail: '远端 PATH · 独立会话', arguments: '', source: 'remote-command', rank: 8 }]
        }), status: names.length >= 2048 ? '远端 PATH 已达 2048 项上限' : '' }
      }
      const entries = await cache.read(`${sessionId}:path:${request.path.directory}`, 3000, async () => {
        const result = await list({ sessionId, path: request.path.directory })
        if (!Array.isArray(result)) throw new Error('远端目录返回格式不可用')
        return { values: result.slice(0, MAX_ENTRIES), truncated: result.length > MAX_ENTRIES }
      }, signal)
      return { items: entries.values.map(entry => pathCandidate(request.path, entry)).filter(Boolean).sort((a, b) => Number(b.directory) - Number(a.directory) || a.label.localeCompare(b.label)).slice(0, 40), status: entries.truncated ? `远端目录仅显示前 ${MAX_ENTRIES} 项中的匹配` : '' }
    } catch (error) {
      if (error.name === 'AbortError') throw error
      return { items: [], status: `${request.kind === 'paths' ? '远端路径' : '远端 PATH'}不可用 · 本地提示仍可使用` }
    }
  }
  return { plan, load, invalidate: () => cache.invalidate(), dispose: () => cache.dispose() }
}

export function mergeSuggestions(local, remote, limit) {
  const unique = new Map()
  for (const item of [...local, ...remote].sort((a, b) => a.rank - b.rank)) if (!unique.has(item.fullCommand)) unique.set(item.fullCommand, item)
  return [...unique.values()].slice(0, limit)
}
