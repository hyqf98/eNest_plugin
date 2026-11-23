/** 媒体库索引、旧数据迁移、私有文件对账与缩略图补全。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { host } from './env.js'
import { getThumb, putThumb, removeThumb } from './assets.js'
import { objectUrlFor, releaseObjectUrl, loadImageElement } from './blobs.js'
import { removeDraft } from './draft.js'
import { listFiles } from './files.js'
import { thumbFromCanvas, thumbFromImage, videoThumb, videoMeta } from './media.js'
import { stampName } from './format.js'

const INDEX_KEY = 'sa.library.v2'
const MIGRATION_KEY = 'sa.migration.v1'
const LEGACY_KEY = 'screen_workspace_v2'
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm'])

const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
const kindFor = ext => ext === 'webm' ? 'video' : ext === 'gif' ? 'gif' : 'image'
const extFor = ext => ext === 'jpeg' ? 'jpg' : ext

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const kind = ['image', 'video', 'gif'].includes(raw.kind) ? raw.kind : 'image'
  const ext = ALLOWED_EXT.has(String(raw.ext)) ? extFor(raw.ext) : kind === 'video' ? 'webm' : kind === 'gif' ? 'gif' : 'png'
  if (!raw.fileId && !raw.legacyBlobId && !raw.legacyThumbOnly) return null
  return {
    id: typeof raw.id === 'string' ? raw.id : uid(),
    kind,
    ext,
    fileId: typeof raw.fileId === 'string' ? raw.fileId : '',
    legacyBlobId: typeof raw.legacyBlobId === 'string' ? raw.legacyBlobId : '',
    legacyThumbOnly: raw.legacyThumbOnly === true,
    thumbId: typeof raw.thumbId === 'string' ? raw.thumbId : '',
    name: String(raw.name || stampName(kind === 'video' ? '录屏' : '截图')).slice(0, 120),
    createdAt: Number(raw.createdAt) || Date.now(),
    width: Math.max(0, Number(raw.width) || 0),
    height: Math.max(0, Number(raw.height) || 0),
    bytes: Math.max(0, Number(raw.bytes) || 0),
    durationMs: Math.max(0, Number(raw.durationMs) || 0),
    source: String(raw.source || 'capture'),
    originId: typeof raw.originId === 'string' ? raw.originId : ''
  }
}

function sortItems(list) {
  return [...list].sort((a, b) => b.createdAt - a.createdAt)
}

async function readIndex() {
  const stored = await host.storage.get(INDEX_KEY).catch(() => null)
  if (!stored || typeof stored !== 'object' || !Array.isArray(stored.items)) return null
  return stored.items.map(normalizeItem).filter(Boolean)
}

async function readLegacy() {
  const stored = await host.storage.get(LEGACY_KEY).catch(() => null)
  return stored && typeof stored === 'object' ? stored : null
}

async function migrateHistory(legacy) {
  const marker = await host.storage.get(MIGRATION_KEY).catch(() => null)
  if (marker?.done || !legacy) return []
  const list = []
  for (const entry of Array.isArray(legacy.history) ? legacy.history : []) {
    if (!entry || typeof entry !== 'object') continue
    let thumbId = ''
    if (typeof entry.thumb === 'string' && /^data:image\//.test(entry.thumb)) {
      thumbId = await putThumb(entry.thumb, entry.name || '旧版缩略图').catch(() => '')
    }
    const id = typeof entry.id === 'string' ? entry.id : uid()
    const base = {
      id,
      name: String(entry.name || '旧版截图'),
      createdAt: Number(entry.ts) || Date.now(),
      width: Math.max(0, Number(entry.width) || 0),
      height: Math.max(0, Number(entry.height) || 0),
      bytes: Math.max(0, Number(entry.bytes) || 0),
      thumbId,
      source: 'legacy'
    }
    if (typeof entry.blobId === 'string' && entry.blobId) list.push({ ...base, kind: 'image', ext: 'png', legacyBlobId: entry.blobId })
    else if (thumbId) list.push({ ...base, kind: 'image', ext: 'png', legacyThumbOnly: true })
  }
  if (legacy.drafts && typeof legacy.drafts === 'object' && !Array.isArray(legacy.drafts)) {
    const current = await host.storage.get('sa.drafts.v2').catch(() => null)
    if (!current) await host.storage.set('sa.drafts.v2', legacy.drafts).catch(() => {})
  }
  await host.storage.set(MIGRATION_KEY, { done: true, at: Date.now(), from: LEGACY_KEY, items: list.length }).catch(() => {})
  return list
}

async function reconcileFiles(list, legacy) {
  const files = await listFiles().catch(() => null)
  if (!files) return { list, changed: false }
  const known = new Set(list.map(item => item.fileId).filter(Boolean))
  const annotations = new Map()
  for (const record of Array.isArray(legacy?.recordings) ? legacy.recordings : []) {
    if (record && typeof record.id === 'string') annotations.set(record.id, record)
  }
  const added = []
  for (const file of files) {
    const ext = extFor(String(file.extension || '').toLowerCase())
    if (!ALLOWED_EXT.has(ext) || known.has(file.id)) continue
    const kind = kindFor(ext)
    const note = annotations.get(file.id)
    added.push({
      id: uid(),
      kind,
      ext,
      fileId: file.id,
      legacyBlobId: '',
      legacyThumbOnly: false,
      thumbId: '',
      name: note?.gif ? 'GIF 录制' : kind === 'video' ? '录屏文件' : '截图文件',
      createdAt: Number(note?.ts) || Number(file.createdAt) || Date.now(),
      width: 0,
      height: 0,
      bytes: Number(file.size) || 0,
      durationMs: Math.max(0, Number(note?.durationMs) || 0),
      source: 'recovered',
      originId: ''
    })
  }
  return { list: [...added, ...list], changed: added.length > 0 }
}

/** 缩略图补全任务去重（同一 item 只跑一次）。 */
function createThumbLoader(patch) {
  const jobs = new Map()
  return function ensureThumb(item) {
    if (!item) return Promise.resolve('')
    if (item.thumbId) return getThumb(item.thumbId)
    if (item.legacyThumbOnly) return Promise.resolve('')
    const running = jobs.get(item.id)
    if (running) return running
    const job = (async () => {
      try {
        const entry = await objectUrlFor(item)
        let thumb = ''
        let meta = null
        if (item.kind === 'video') {
          try { meta = await videoMeta(entry.blob) } catch { meta = null }
          thumb = await videoThumb(entry.blob)
        } else {
          const image = await loadImageElement(entry.url)
          thumb = thumbFromImage(image, { topCrop: image.naturalHeight > image.naturalWidth * 2.2 })
          meta = { width: image.naturalWidth, height: image.naturalHeight }
        }
        const thumbId = thumb ? await putThumb(thumb, item.name).catch(() => '') : ''
        const changes = { thumbId }
        if (meta) {
          if (meta.width) changes.width = meta.width
          if (meta.height) changes.height = meta.height
          if (meta.durationMs) changes.durationMs = meta.durationMs
        }
        patch(item.id, changes)
        return thumb
      } catch {
        return ''
      } finally {
        jobs.delete(item.id)
      }
    })()
    jobs.set(item.id, job)
    return job
  }
}

export function useLibrary({ imageLimit = 200, onError, enabled = true } = {}) {
  const [items, setItems] = useState([])
  const [ready, setReady] = useState(false)
  const itemsRef = useRef([])
  const queue = useRef(Promise.resolve())
  const limitRef = useRef(imageLimit)
  limitRef.current = imageLimit

  const persist = useCallback(next => {
    itemsRef.current = next
    setItems(next)
    const snapshot = { version: 2, items: next.slice(0, 400) }
    queue.current = queue.current.catch(() => {}).then(() => host.storage.set(INDEX_KEY, snapshot))
    queue.current.catch(() => {})
    return queue.current
  }, [])

  const patch = useCallback((id, changes) => {
    const current = itemsRef.current
    const index = current.findIndex(item => item.id === id)
    if (index < 0) return null
    const next = current.slice()
    next[index] = { ...next[index], ...changes }
    void persist(next)
    return next[index]
  }, [persist])

  const ensureThumb = useRef(null)
  if (!ensureThumb.current) ensureThumb.current = createThumbLoader((id, changes) => patch(id, changes))

  const discard = useCallback(async item => {
    await removeDraft(item.id).catch(() => {})
    releaseObjectUrl(item.id)
    if (item.fileId) await host.storage.files.remove(item.fileId).catch(() => false)
    if (item.legacyBlobId) await host.storage.blobs.remove(item.legacyBlobId).catch(() => false)
    if (item.thumbId) await removeThumb(item.thumbId).catch(() => false)
  }, [])

  const enforceLimit = useCallback(async next => {
    const images = next.filter(item => item.kind === 'image' && !item.legacyThumbOnly)
    if (images.length <= limitRef.current) return next
    const pruned = images.slice(limitRef.current)
    const prunedIds = new Set(pruned.map(item => item.id))
    for (const item of pruned) await discard(item)
    return next.filter(item => !prunedIds.has(item.id))
  }, [discard])

  const add = useCallback(async item => {
    const normalized = normalizeItem(item)
    if (!normalized) throw new Error('媒体记录无效')
    let next = [normalized, ...itemsRef.current.filter(entry => entry.id !== normalized.id)]
    next = await enforceLimit(next)
    await persist(next)
    return next.find(entry => entry.id === normalized.id) || normalized
  }, [enforceLimit, persist])

  const addSaved = useCallback(async ({ kind, fileId, ext, thumb, name, width, height, bytes, durationMs, source = 'capture', originId = '' }) => {
    const thumbId = thumb ? await putThumb(thumb, name || '缩略图').catch(() => '') : ''
    return add({
      id: uid(),
      kind,
      ext,
      fileId,
      thumbId,
      name: name || stampName(kind === 'video' ? '录屏' : kind === 'gif' ? 'GIF' : '截图'),
      createdAt: Date.now(),
      width,
      height,
      bytes,
      durationMs,
      source,
      originId
    })
  }, [add])

  const remove = useCallback(async id => {
    const item = itemsRef.current.find(entry => entry.id === id)
    if (!item) return false
    const next = itemsRef.current.filter(entry => entry.id !== id)
    await persist(next)
    await discard(item)
    return true
  }, [discard, persist])

  const flush = useCallback(async () => {
    await queue.current.catch(() => {})
    await host.storage.flush().catch(() => {})
  }, [])

  const reload = useCallback(async () => {
    const legacy = await readLegacy()
    const indexed = await readIndex()
    let list = indexed ?? (await migrateHistory(legacy))
    const reconciled = await reconcileFiles(list, legacy)
    list = await enforceLimit(sortItems(reconciled.list))
    await persist(list)
    setReady(true)
    return list
  }, [enforceLimit, persist])

  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    void reload().catch(error => {
      if (!alive) return
      setReady(true)
      onError?.(error)
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  return {
    items,
    ready,
    add,
    addSaved,
    patch,
    remove,
    flush,
    reload,
    ensureThumb: ensureThumb.current,
    totalBytes: items.reduce((sum, item) => sum + (item.bytes || 0), 0)
  }
}
