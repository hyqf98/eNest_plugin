const DOCUMENT = 'clipboard.history.v2'
const LEGACY_SOURCE = 'clipboard-history-v1'
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
const encoder = new TextEncoder()

function imageBytes(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/.exec(String(dataUrl))
  if (!match || match[1].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Invalid or oversized clipboard image')
  const raw = atob(match[1])
  if (raw.length > MAX_IMAGE_BYTES) throw new Error('Clipboard image exceeds 8 MiB')
  return Uint8Array.from(raw, char => char.charCodeAt(0))
}

async function digest(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
}

function publicEntry(entry) {
  const { blobId: _blobId, blobFile: _blobFile, hash: _hash, ...result } = entry
  return structuredClone(result)
}

function preferences(value = {}) {
  return {
    monitoring: value.monitoring !== false,
    historyLimit: Math.max(50, Math.min(10000, Number(value.historyLimit) || 200)),
    retentionDays: Math.max(0, Math.min(3650, Number(value.retentionDays) || 0)),
    recordSource: value.recordSource !== false,
    excludedApps: String(value.excludedApps || '').split(/[\n,，]/).map(value => value.trim().toLowerCase()).filter(Boolean)
  }
}

function validateEntry(value) {
  if (!value || typeof value !== 'object' || !['text', 'image', 'files'].includes(value.type) ||
      typeof value.id !== 'string' || !value.id || value.id.length > 200 || !Number.isFinite(value.ts) ||
      typeof value.preview !== 'string') throw new Error('Invalid clipboard history record; original data retained')
  if (value.type === 'text' && typeof value.text !== 'string') throw new Error('Invalid clipboard text record')
  if (value.type === 'files' && (!Array.isArray(value.files) || !value.files.every(file =>
    file && typeof file.path === 'string' && file.path.length > 0 && !file.path.includes('\0') && typeof file.name === 'string'))) {
    throw new Error('Invalid clipboard file record')
  }
  if (value.blobId !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(value.blobId)) throw new Error('Invalid clipboard attachment identifier')
  return { ...structuredClone(value), pinned: value.pinned === true }
}

/** Business state is plugin-owned. The host only provides durable private documents and native snapshots. */
export function createClipboardHistory(host, { now = Date.now, uuid = () => crypto.randomUUID() } = {}) {
  let entries = [], migration = null, loaded = false, disposed = false, loading = null, tail = Promise.resolve()
  let newestRevision = -1
  const assertCurrent = () => { if (disposed) throw new Error('Clipboard background is closed') }
  const serial = task => {
    const result = tail.catch(() => {}).then(async () => { assertCurrent(); return task() })
    tail = result
    return result
  }

  async function documentWrite(next, nextMigration = migration) {
    assertCurrent()
    const document = { version: 2, entries: next, migration: nextMigration }
    if (encoder.encode(JSON.stringify(document)).byteLength > MAX_DOCUMENT_BYTES) throw new Error('Clipboard history exceeds private document limit; existing data retained')
    await host.private.writeDocument(DOCUMENT, document)
    assertCurrent()
    entries = next
    migration = nextMigration
  }

  async function load() {
    assertCurrent()
    if (loaded) return
    if (!loading) loading = (async () => {
      const stored = await host.private.readDocument(DOCUMENT)
      assertCurrent()
      if (stored !== null && stored !== undefined) {
        if (stored.version !== 2 || !Array.isArray(stored.entries)) throw new Error('Invalid private clipboard history; existing data retained')
        entries = stored.entries.map(validateEntry)
        migration = stored.migration ?? null
        if (migration?.token && !migration.complete) {
          await host.legacy.commit(LEGACY_SOURCE, migration.token)
          await documentWrite(entries, { ...migration, complete: true })
        }
      } else {
        const legacy = await host.legacy.read(LEGACY_SOURCE)
        assertCurrent()
        if (legacy) {
          let parsed
          try { parsed = JSON.parse(legacy.document) } catch { throw new Error('Legacy clipboard history is not valid JSON; original data retained') }
          if (!Array.isArray(parsed)) throw new Error('Legacy clipboard history is not an array; original data retained')
          const imported = parsed.map(validateEntry)
          const ids = new Set()
          for (const entry of imported) {
            if (ids.has(entry.id)) throw new Error('Legacy clipboard history contains duplicate IDs; original data retained')
            ids.add(entry.id)
            assertCurrent()
            if (entry.type === 'image' && entry.blobFile) {
              if (!/^[A-Za-z0-9._-]{1,200}$/.test(entry.blobFile) || entry.blobFile === '.' || entry.blobFile === '..') throw new Error('Unsafe legacy clipboard attachment name')
              const image = await host.legacy.getBlob(LEGACY_SOURCE, legacy.token, entry.blobFile)
              assertCurrent()
              if (!image) throw new Error('Legacy clipboard image is missing; original data retained')
              const bytes = imageBytes(image.dataUrl)
              const id = `legacy-${await digest(entry.blobFile)}`
              await host.private.putBlob({ id, dataUrl: image.dataUrl })
              assertCurrent()
              entry.blobId = id
              entry.hash = await digest(bytes)
              delete entry.blobFile
            } else if (entry.type === 'text') entry.hash = await digest(entry.text)
            else if (entry.type === 'files') entry.hash = await digest(JSON.stringify(entry.files.map(file => file.path)))
          }
          await documentWrite(imported, { token: legacy.token, complete: false })
          await host.legacy.commit(LEGACY_SOURCE, legacy.token)
          await documentWrite(imported, { token: legacy.token, complete: true })
        } else await documentWrite([])
      }
      loaded = true
    })().catch(error => { loading = null; throw error })
    await loading
  }

  async function changed() {
    assertCurrent()
    await host.emit('history.changed', { count: entries.length })
  }

  async function commit(next) {
    const previous = entries
    await documentWrite(next)
    const kept = new Set(next.map(entry => entry.blobId).filter(Boolean))
    for (const entry of previous) {
      if (entry.blobId && !kept.has(entry.blobId)) {
        assertCurrent()
        // An index commit must precede garbage collection; failed cleanup cannot delete live data.
        await host.private.removeBlob(entry.blobId).catch(() => {})
      }
    }
    await changed()
  }

  function trim(next, settings) {
    const pinned = next.filter(entry => entry.pinned)
    const rest = next.filter(entry => !entry.pinned && (!settings.retentionDays || entry.ts >= now() - settings.retentionDays * 86400000))
    return [...pinned, ...rest.slice(0, Math.max(0, settings.historyLimit - pinned.length))]
  }

  async function capture(snapshot) {
    await load()
    if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision <= newestRevision) return false
    const settings = preferences(await host.settings.get())
    assertCurrent()
    if (!settings.monitoring) { newestRevision = snapshot.revision; return false }
    const source = snapshot.sourceApp
    if (source && settings.excludedApps.some(name => [source.id, source.name].some(value => typeof value === 'string' && value.toLowerCase() === name))) { newestRevision = snapshot.revision; return false }
    const sourceApp = settings.recordSource ? source : undefined
    const timestamp = Number.isFinite(snapshot.capturedAt) ? snapshot.capturedAt : now()
    let hash, nextEntry, newBlob
    if (snapshot.type === 'text') {
      if (typeof snapshot.text !== 'string' || !snapshot.text) return false
      if (encoder.encode(snapshot.text).byteLength > MAX_DOCUMENT_BYTES / 2) throw new Error('Clipboard text exceeds capture limit')
      hash = await digest(snapshot.text)
      nextEntry = { type: 'text', text: snapshot.text, preview: snapshot.text.length > 120 ? `${snapshot.text.slice(0, 120)}…` : snapshot.text, bytes: encoder.encode(snapshot.text).byteLength }
    } else if (snapshot.type === 'files') {
      if (!Array.isArray(snapshot.files) || !snapshot.files.length || snapshot.files.length > 10000) return false
      if (!snapshot.files.every(file => typeof file?.path === 'string' && file.path && !file.path.includes('\0') && typeof file.name === 'string')) throw new Error('Invalid native clipboard files')
      hash = await digest(JSON.stringify(snapshot.files.map(file => file.path)))
      nextEntry = { type: 'files', files: structuredClone(snapshot.files), preview: snapshot.files.map(file => file.name).join('、') }
    } else if (snapshot.type === 'image') {
      const bytes = imageBytes(snapshot.dataUrl)
      hash = await digest(bytes)
      nextEntry = { type: 'image', preview: `${snapshot.width}×${snapshot.height}`, hasImage: true, width: snapshot.width, height: snapshot.height, bytes: bytes.byteLength }
    } else return false
    assertCurrent()
    const existing = entries.find(entry => entry.type === snapshot.type && entry.hash === hash)
    if (snapshot.type === 'image' && !existing) {
      newBlob = await host.private.putBlob({ dataUrl: snapshot.dataUrl })
      nextEntry.blobId = newBlob.id
    }
    const entry = { ...(existing || { id: uuid(), pinned: false }), ...nextEntry, hash, ts: timestamp, sourceApp }
    try {
      assertCurrent()
      await commit(trim([entry, ...entries.filter(value => value.id !== entry.id)], settings))
      newestRevision = snapshot.revision
    } catch (error) {
      if (newBlob && !entries.some(value => value.blobId === newBlob.id)) await host.private.removeBlob(newBlob.id).catch(() => {})
      throw error
    }
    return true
  }

  async function query(options = {}) {
    await load()
    const q = String(options.query || '').trim().toLocaleLowerCase()
    const filtered = entries.filter(entry => (!options.type || entry.type === options.type) && (!options.pinned || entry.pinned) &&
      (!q || `${entry.text || ''} ${entry.preview} ${entry.sourceApp?.name || ''} ${entry.files?.map(file => file.path).join(' ') || ''}`.toLocaleLowerCase().includes(q)))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.ts - a.ts)
    const offset = Math.max(0, Math.floor(Number(options.cursor) || 0))
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 60))
    return { items: filtered.slice(offset, offset + limit).map(publicEntry), total: filtered.length, nextCursor: offset + limit < filtered.length ? offset + limit : null }
  }

  async function get(id) {
    await load()
    const entry = entries.find(entry => entry.id === id)
    if (!entry) return null
    const result = publicEntry(entry)
    if (entry.type === 'image' && entry.blobId) {
      const blob = await host.private.getBlob(entry.blobId)
      assertCurrent()
      if (blob) result.dataUrl = blob.dataUrl
    }
    return result
  }

  async function call(method, args = []) {
    await load()
    if (method === 'history.query') return query(args[0])
    if (method === 'history.get') return get(String(args[0] || ''))
    if (method === 'history.list') return entries.filter(entry => entry.type !== 'files').slice(0, Math.max(1, Math.min(10000, Number(args[0]?.limit) || 100))).map(publicEntry)
    if (method === 'history.remove') {
      const id = String(args[0] || '')
      if (!entries.some(entry => entry.id === id)) return false
      await commit(entries.filter(entry => entry.id !== id))
      return true
    }
    if (method === 'history.clear') { await commit(entries.filter(entry => entry.pinned)); return true }
    if (method === 'history.togglePin') {
      const old = entries.find(entry => entry.id === args[0])
      if (!old) throw new Error('History entry not found')
      const updated = { ...old, pinned: !old.pinned }
      await commit(entries.map(entry => entry.id === old.id ? updated : entry))
      return publicEntry(updated)
    }
    if (method === 'history.preferencesChanged') {
      await commit(trim(entries, preferences(await host.settings.get())))
      return true
    }
    throw new Error('Unknown clipboard background operation')
  }

  async function search(queryText, limit = 6) {
    await load()
    const q = String(queryText || '').trim().toLowerCase()
    if (!q) return []
    const scores = []
    for (const entry of entries) {
      let score = 0
      if (entry.type === 'text') {
        const text = (entry.text || entry.preview).toLowerCase(), preview = entry.preview.toLowerCase()
        score = preview.startsWith(q) ? 60 : preview.includes(q) ? 40 : text.startsWith(q) ? 50 : text.includes(q) ? 30 : 0
      } else if (`${entry.width ?? ''}x${entry.height ?? ''} ${entry.preview} ${entry.files?.map(file => file.path).join(' ') || ''}`.toLowerCase().includes(q)) score = 12
      if (score) scores.push({ entry, score: score + (entry.pinned ? 6 : 0) + Math.max(0, 4 - Math.floor((now() - entry.ts) / 86400000)) })
    }
    return scores.sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts).slice(0, Math.max(1, Math.min(20, Number(limit) || 6))).map(({ entry }) => ({
      id: entry.id, title: entry.type === 'image' ? `图片 ${entry.preview}` : entry.preview,
      subtitle: `剪贴板 · ${entry.pinned ? '置顶 · ' : ''}${new Date(entry.ts).toLocaleString()}`,
      code: 'main', payload: { historyId: entry.id }
    }))
  }

  return {
    onEvent: (event, data) => serial(() => event === 'clipboard.changed' ? capture(data) : undefined),
    call: (method, args) => serial(() => call(method, args)),
    search: (query, limit) => serial(() => search(query, limit)),
    dispose() { disposed = true },
    idle: () => tail
  }
}
