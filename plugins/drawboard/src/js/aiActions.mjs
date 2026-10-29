/**
 * aiActions.mjs —— AI/MCP 可编程动作层
 * 从 App 的 ref 状态读写文档与草稿，不依赖组件闭包；页面隐藏（MCP 冷启动）同样可用。
 * 与交互路径共用 objectsRef / undo 栈 / 防抖持久化语义：默认操作当前活动草稿，
 * 指定 draftId 时直接改写该草稿的已存对象数组（活动草稿的 objectsRef 不受影响）。
 */

import { objectBBox, uid } from './objects.mjs'
import { makeDraft, putImageBlob, getImageBlob } from './store.mjs'
import { composeExport } from './render.mjs'
import { THEMES } from './theme.mjs'

export class AiError extends Error {}

const WORLD_LIMIT = 1e6
const POINTS_PER_INK = 10000
/** 入参总体积受限（宿主请求 ≤1MiB）：点数与图片 base64 都要留余量 */
const POINTS_TOTAL = 20000
const IMAGE_B64_MAX = 512_000
export const ELEMENTS_MAX = 300
export const TEXT_MAX = 5000
/** base64 字符预算：宿主整条结果 ≤1MiB（含 JSON 开销），留出安全余量 */
const B64_BUDGET = 900_000
const CAPTURE_DIMS = [1600, 1200, 900, 650, 480]

function fail(message) { throw new AiError(message) }

function num(v, def, min, max, label) {
  if (v === undefined || v === null) return def
  const n = Number(v)
  if (!Number.isFinite(n)) fail(`${label} 必须是有限数字`)
  if (n < min || n > max) fail(`${label} 超出范围 [${min}, ${max}]`)
  return n
}

function color(v, def, label) {
  if (v === undefined || v === null) return def
  const s = String(v)
  if (!/^#[0-9a-fA-F]{3,8}$/.test(s)) fail(`${label} 需为 #hex 颜色`)
  return s
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new AiError('图片无法解析'))
    el.src = dataUrl
  })
}

/** 浅拷贝并剥离临时淡入字段（capture 直读，不应带渐显） */
function stripBorn(list) {
  return list.map((o) => {
    if (!o._born) return o
    const copy = { ...o }
    delete copy._born
    return copy
  })
}

/** 结构化输出用的纯净对象（剥离 _w/_measured/_born 等渲染缓存） */
function cleanObjects(list) {
  return list.map((o) => {
    const copy = { ...o }
    delete copy._w
    delete copy._measured
    delete copy._born
    return copy
  })
}

export function createAiActions(deps) {
  const {
    objectsRef, draftsRef, activeIdRef, selectionRef, imagesRef, settingsRef, vpRef,
    undoRef, redoRef, kitRef, persistRef,
    setDrafts, setSelection, setActiveId, setVp, setImages, setUndoTick,
    notifyObjects, persistNow,
  } = deps

  const currentTheme = () => THEMES[settingsRef.current?.theme] || THEMES.paper

  /* ---------- 读取辅助 ---------- */

  function findDraft(id) {
    return draftsRef.current.find((d) => d.id === id)
  }

  function requireDraft(draftId) {
    const d = findDraft(draftId)
    if (!d) fail(`草稿不存在：${String(draftId)}`)
    return d
  }

  /** 解析动作目标：活动草稿（objectsRef 为准）或指定的其它草稿（draft.objects 为准） */
  function resolveTarget(draftId) {
    if (draftId === undefined || draftId === null || draftId === activeIdRef.current) {
      return { active: true, id: activeIdRef.current, objects: objectsRef.current }
    }
    const draft = requireDraft(draftId)
    return { active: false, id: draft.id, objects: draft.objects || [] }
  }

  /* ---------- 写入辅助 ---------- */

  function snapshot() {
    undoRef.current.push({ objects: JSON.parse(JSON.stringify(objectsRef.current)), selection: [...(selectionRef.current || [])] })
    if (undoRef.current.length > 50) undoRef.current.shift()
    redoRef.current = []
    setUndoTick((n) => n + 1)
  }

  /** 活动文档提交（与 App.commitObjects + syncDraftDoc 同语义；draftsRef 同步更新保证动作结果即时可信） */
  function commitActive(mutator, { snapshot: snap = true } = {}) {
    if (snap) snapshot()
    const objects = objectsRef.current
    const result = mutator(objects)
    objectsRef.current = Array.isArray(result) ? result : objects
    notifyObjects()
    const next = draftsRef.current.map((d) => (d.id === activeIdRef.current ? { ...d, objects: objectsRef.current, updatedAt: Date.now() } : d))
    draftsRef.current = next
    persistNow(next, activeIdRef.current)
    setDrafts(next)
  }

  /** 对目标草稿应用对象数组变换（活动走 commitActive，其它就地同步改写其 objects 并落盘） */
  function applyToList(draftId, mutator, { snapshot: snap = true } = {}) {
    const target = resolveTarget(draftId)
    if (target.active) {
      commitActive((objects) => mutator(objects), { snapshot: snap })
      target.objects = objectsRef.current
      return target
    }
    const updated = mutator(target.objects)
    const finalList = Array.isArray(updated) ? updated : target.objects
    const next = draftsRef.current.map((d) => (d.id === target.id ? { ...d, objects: finalList, updatedAt: Date.now() } : d))
    draftsRef.current = next
    persistNow(next, activeIdRef.current)
    setDrafts(next)
    target.objects = finalList
    return target
  }

  /* ---------- 元素规范化 ---------- */

  let pointsBudget = POINTS_TOTAL

  function normalizePoint(raw, label) {
    let x, y, p
    if (Array.isArray(raw)) {
      x = raw[0]; y = raw[1]; p = raw[2]
    } else if (raw && typeof raw === 'object') {
      x = raw.x; y = raw.y; p = raw.p
    } else fail(`${label} 点需为 [x,y,(p)] 或 {x,y,p?}`)
    const nx = num(x, undefined, -WORLD_LIMIT, WORLD_LIMIT, `${label} x`)
    const ny = num(y, undefined, -WORLD_LIMIT, WORLD_LIMIT, `${label} y`)
    const pt = { x: nx, y: ny }
    if (p !== undefined && p !== null) pt.p = num(p, 0.5, 0, 1, `${label} 压力`)
    return pt
  }

  function normalizeElement(el, index) {
    const label = `elements[${index}]`
    if (!el || typeof el !== 'object' || Array.isArray(el)) fail(`${label} 需为对象`)
    const theme = currentTheme()
    const settings = settingsRef.current
    switch (el.kind) {
      case 'ink': {
        if (!Array.isArray(el.points) || !el.points.length) fail(`${label} ink 需要非空 points`)
        if (el.points.length > POINTS_PER_INK) fail(`${label} 单条墨迹点数超过 ${POINTS_PER_INK}`)
        pointsBudget -= el.points.length
        if (pointsBudget < 0) fail(`墨迹总点数超过 ${POINTS_TOTAL}`)
        const highlighter = el.highlighter === true
        return {
          id: uid(), kind: 'ink',
          points: el.points.map((pt, i) => normalizePoint(pt, `${label}#${i}`)),
          color: color(el.color, highlighter ? theme.highlighter : theme.ink, `${label} color`),
          size: num(el.size, highlighter ? settings.highlightWidth : settings.strokeWidth, 0.5, 80, `${label} size`),
          highlighter,
          _born: performance.now(),
        }
      }
      case 'shape': {
        const type = el.type
        if (!['rect', 'ellipse', 'line', 'arrow'].includes(type)) fail(`${label} shape.type 需为 rect/ellipse/line/arrow`)
        const x = num(el.x, undefined, -WORLD_LIMIT, WORLD_LIMIT, `${label} x`)
        const y = num(el.y, undefined, -WORLD_LIMIT, WORLD_LIMIT, `${label} y`)
        const base = {
          id: uid(), kind: 'shape', type,
          color: color(el.color, theme.ink, `${label} color`),
          stroke: num(el.stroke, Math.max(settings.strokeWidth, 1.5), 0.5, 24, `${label} stroke`),
          seed: Math.floor(num(el.seed, (Math.random() * 2000) | 0, 0, 4294967295, `${label} seed`)),
          fill: el.fill === undefined || el.fill === 'none' ? 'none' : color(el.fill, undefined, `${label} fill`),
          _born: performance.now(),
        }
        if (type === 'line' || type === 'arrow') {
          base.x = x; base.y = y
          base.x2 = num(el.x2, undefined, -WORLD_LIMIT, WORLD_LIMIT, `${label} x2`)
          base.y2 = num(el.y2, undefined, -WORLD_LIMIT, WORLD_LIMIT, `${label} y2`)
        } else {
          base.x = x; base.y = y
          base.w = num(el.w, undefined, -WORLD_LIMIT, WORLD_LIMIT, `${label} w`)
          base.h = num(el.h, undefined, -WORLD_LIMIT, WORLD_LIMIT, `${label} h`)
        }
        return base
      }
      case 'text': {
        const text = String(el.text ?? '')
        if (!text.trim()) fail(`${label} text 不能为空`)
        if (text.length > TEXT_MAX) fail(`${label} 文本长度超过 ${TEXT_MAX}`)
        return {
          id: uid(), kind: 'text',
          x: num(el.x, undefined, -WORLD_LIMIT, WORLD_LIMIT, `${label} x`),
          y: num(el.y, undefined, -WORLD_LIMIT, WORLD_LIMIT, `${label} y`),
          text,
          size: num(el.size, 24, 6, 240, `${label} size`),
          color: color(el.color, theme.ink, `${label} color`),
          _born: performance.now(),
        }
      }
      case 'erase': {
        if (!Array.isArray(el.points) || !el.points.length) fail(`${label} erase 需要非空 points`)
        if (el.points.length > POINTS_PER_INK) fail(`${label} 单条擦除点数超过 ${POINTS_PER_INK}`)
        pointsBudget -= el.points.length
        if (pointsBudget < 0) fail(`墨迹总点数超过 ${POINTS_TOTAL}`)
        return {
          id: uid(), kind: 'erase',
          points: el.points.map((pt, i) => normalizePoint(pt, `${label}#${i}`)),
          color: '#000',
          size: num(el.size, settings.eraserSize, 6, 160, `${label} size`),
          _born: performance.now(),
        }
      }
      default:
        fail(`${label} kind 需为 ink/shape/text/erase/image（image 请用 dataUrl）`)
    }
  }

  /** 贴图元素：base64 dataUrl → storage.assets → 对象 + 位图预热 */
  async function normalizeImageElement(el, index, defaultCenter) {
    const label = `elements[${index}]`
    const dataUrl = String(el.dataUrl ?? '')
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)
    if (!match) fail(`${label} image.dataUrl 需为 PNG/JPEG/WebP/GIF 的 base64 data URL`)
    if (dataUrl.length > IMAGE_B64_MAX) fail(`${label} 图片 base64 过大（约 ${Math.round(dataUrl.length / 1024)}KB），请压缩后再传入`)
    let img
    try {
      img = await loadImage(dataUrl)
    } catch {
      fail(`${label} 图片无法解析`)
    }
    const kit = kitRef.current
    let blobId = null
    try {
      blobId = await putImageBlob(kit, dataUrl, el.name ? String(el.name).slice(0, 64) : 'ai-image')
    } catch (error) {
      fail(`${label} 图片存储失败：${error.message || error}`)
    }
    // 宽度可指定（默认不放大、上限 640 同交互贴图），高度按原始比例
    const width = Math.round(num(el.width, Math.min(640, img.naturalWidth), 8, 4096, `${label} width`))
    const height = Math.max(1, Math.round(width * (img.naturalHeight / Math.max(1, img.naturalWidth))))
    const cx = num(el.x, defaultCenter.x, -WORLD_LIMIT, WORLD_LIMIT, `${label} x`)
    const cy = num(el.y, defaultCenter.y, -WORLD_LIMIT, WORLD_LIMIT, `${label} y`)
    const obj = {
      id: uid(), kind: 'image',
      x: cx - width / 2, y: cy - height / 2, w: width, h: height,
      blobId, dataUrl: blobId ? undefined : dataUrl,
      _born: performance.now(),
    }
    const key = blobId || `inline:${obj.id}`
    const next = new Map(imagesRef.current)
    next.set(key, img)
    imagesRef.current = next
    setImages(next)
    return obj
  }

  /* ---------- 公共动作 ---------- */

  async function addElements({ elements, draftId }) {
    pointsBudget = POINTS_TOTAL
    if (!Array.isArray(elements) || !elements.length) fail('elements 需为非空数组')
    if (elements.length > ELEMENTS_MAX) fail(`单次最多添加 ${ELEMENTS_MAX} 个元素`)
    const target = resolveTarget(draftId)
    const contentCenter = (() => {
      const bbox = target.objects.length ? unionBBox(target.objects) : null
      return bbox ? { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 } : { x: 0, y: 0 }
    })()
    const objs = []
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      if (el && typeof el === 'object' && el.kind === 'image') objs.push(await normalizeImageElement(el, i, contentCenter))
      else objs.push(normalizeElement(el, i))
    }
    applyToList(draftId, (objects) => { objects.push(...objs) })
    return { ids: objs.map((o) => o.id), draftId: target.id }
  }

  function unionBBox(list) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const o of list) {
      const b = objectBBox(o)
      if (b.x < minX) minX = b.x
      if (b.y < minY) minY = b.y
      if (b.x + b.w > maxX) maxX = b.x + b.w
      if (b.y + b.h > maxY) maxY = b.y + b.h
    }
    if (minX === Infinity) return null
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }

  function updateElements({ updates, draftId }) {
    if (!Array.isArray(updates) || !updates.length) fail('updates 需为非空数组')
    if (updates.length > ELEMENTS_MAX) fail(`单次最多更新 ${ELEMENTS_MAX} 项`)
    const spec = updates.map((u, i) => {
      if (!u || typeof u !== 'object' || typeof u.id !== 'string') fail(`updates[${i}] 需要字符串 id`)
      return u
    })
    const ids = new Set(spec.map((u) => u.id))
    const found = new Set()
    const reordered = []
    applyToList(draftId, (objects) => {
      let next = objects
      for (const u of spec) {
        const obj = next.find((o) => o.id === u.id)
        if (!obj) continue
        found.add(u.id)
        if (u.dx != null || u.dy != null) {
          const dx = num(u.dx, 0, -WORLD_LIMIT, WORLD_LIMIT, `updates[${u.id}].dx`)
          const dy = num(u.dy, 0, -WORLD_LIMIT, WORLD_LIMIT, `updates[${u.id}].dy`)
          if (obj.kind === 'ink' || obj.kind === 'erase') { for (const p of obj.points) { p.x += dx; p.y += dy } }
          else {
            obj.x += dx; obj.y += dy
            if (obj.x2 != null) obj.x2 += dx
            if (obj.y2 != null) obj.y2 += dy
          }
        }
        if (u.color !== undefined) obj.color = color(u.color, undefined, `updates[${u.id}].color`)
        if (obj.kind === 'ink' || obj.kind === 'erase') {
          if (u.size !== undefined) obj.size = num(u.size, undefined, 0.5, 160, `updates[${u.id}].size`)
          if (u.highlighter !== undefined) obj.highlighter = u.highlighter === true
        } else if (obj.kind === 'shape') {
          if (u.stroke !== undefined) obj.stroke = num(u.stroke, undefined, 0.5, 24, `updates[${u.id}].stroke`)
          if (u.fill !== undefined) obj.fill = u.fill === 'none' ? 'none' : color(u.fill, undefined, `updates[${u.id}].fill`)
          if (u.seed !== undefined) obj.seed = Math.floor(num(u.seed, undefined, 0, 4294967295, `updates[${u.id}].seed`))
          if (u.type !== undefined && ['rect', 'ellipse', 'line', 'arrow'].includes(u.type)) obj.type = u.type
        } else if (obj.kind === 'text') {
          if (u.text !== undefined) {
            const t = String(u.text)
            if (!t.trim()) fail(`updates[${u.id}].text 不能为空`)
            if (t.length > TEXT_MAX) fail(`updates[${u.id}].text 超长`)
            obj.text = t
          }
          if (u.size !== undefined) obj.size = num(u.size, undefined, 6, 240, `updates[${u.id}].size`)
        } else if (obj.kind === 'image') {
          if (u.width !== undefined) obj.w = num(u.width, undefined, 8, 4096, `updates[${u.id}].width`)
          if (u.height !== undefined) obj.h = num(u.height, undefined, 8, 4096, `updates[${u.id}].height`)
        }
        if (u.x !== undefined || u.y !== undefined) {
          if (obj.kind === 'ink' || obj.kind === 'erase') fail(`updates[${u.id}] 笔迹不支持绝对坐标，请用 dx/dy 平移`)
          // line/arrow 是双端点几何：绝对坐标按整体位移换算，避免只动一端
          const hasEnds = obj.x2 != null
          if (hasEnds) {
            if (u.x !== undefined) { const tx = num(u.x, obj.x, -WORLD_LIMIT, WORLD_LIMIT, `updates[${u.id}].x`); const d = tx - obj.x; obj.x += d; obj.x2 += d }
            if (u.y !== undefined) { const ty = num(u.y, obj.y, -WORLD_LIMIT, WORLD_LIMIT, `updates[${u.id}].y`); const d = ty - obj.y; obj.y += d; obj.y2 += d }
          } else {
            if (u.x !== undefined) obj.x = num(u.x, obj.x, -WORLD_LIMIT, WORLD_LIMIT, `updates[${u.id}].x`)
            if (u.y !== undefined) obj.y = num(u.y, obj.y, -WORLD_LIMIT, WORLD_LIMIT, `updates[${u.id}].y`)
          }
        }
        if (u.bringToFront === true || u.sendToBack === true) {
          next = next.filter((o) => o.id !== obj.id)
          reordered.push({ obj, front: u.bringToFront === true })
        }
      }
      let out = next
      for (const r of reordered) {
        out = [...out]
        const existing = out.findIndex((o) => o.id === r.obj.id)
        if (existing >= 0) out.splice(existing, 1)
        out = r.front ? [...out, r.obj] : [r.obj, ...out]
      }
      return out
    })
    return { updated: [...found], notFound: [...ids].filter((id) => !found.has(id)) }
  }

  function deleteElements({ ids, draftId }) {
    if (!Array.isArray(ids) || !ids.length) fail('ids 需为非空数组')
    if (ids.length > 2000) fail('单次最多删除 2000 项')
    const before = new Set(resolveTarget(draftId).objects.map((o) => o.id))
    const set = new Set(ids.map(String))
    const target = applyToList(draftId, (objects) => objects.filter((o) => !set.has(o.id)))
    const removedCount = [...before].filter((id) => !target.objects.some((o) => o.id === id)).length
    if (target.active && selectionRef.current?.some((id) => set.has(id))) {
      const nextSel = selectionRef.current.filter((id) => !set.has(id))
      selectionRef.current = nextSel
      setSelection(nextSel)
    }
    return { removed: removedCount, notFound: ids.length - removedCount }
  }

  function clearDraft({ draftId }) {
    const before = resolveTarget(draftId)
    const count = before.objects.length
    if (!count) return { cleared: 0, draftId: before.id }
    const target = applyToList(draftId, (objects) => { objects.length = 0 })
    if (target.active) {
      selectionRef.current = []
      setSelection([])
    }
    return { cleared: count, draftId: target.id }
  }

  function listDrafts() {
    return {
      activeId: activeIdRef.current,
      drafts: draftsRef.current.map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        objectCount: (d.id === activeIdRef.current ? objectsRef.current : d.objects || []).length,
      })),
    }
  }

  function getDraft({ draftId, limit }) {
    const target = resolveTarget(draftId)
    const objects = cleanObjects(target.objects)
    const maxItems = Math.min(1200, Math.max(1, num(limit, 400, 1, 1200, 'limit')))
    const bbox = unionBBox(target.objects)
    // 宿主对整条结果限 1MiB：先按 limit 截断，再按序列化体积回退
    const draftName = findDraft(target.id)?.name || target.id
    let slice = objects.slice(0, maxItems)
    let serialized = JSON.stringify(slice)
    while (serialized.length > 600_000 && slice.length > 1) {
      slice = slice.slice(0, Math.floor(slice.length / 2))
      serialized = JSON.stringify(slice)
    }
    if (serialized.length > 600_000 && slice.length === 1) {
      slice = []
      serialized = '[]'
    }
    const summary = `草稿「${draftName}」(${target.id})：${objects.length} 个对象${bbox ? `，内容范围 x:${Math.round(bbox.x)} y:${Math.round(bbox.y)} w:${Math.round(bbox.w)} h:${Math.round(bbox.h)}` : ''}${slice.length < objects.length ? `，本次返回前 ${slice.length} 个` : ''}`
    const listText = serialized
    return {
      content: [{ type: 'text', text: listText.length <= 8000 ? `${summary}\n${listText}` : summary }],
      structured: { id: target.id, objectCount: objects.length, returned: slice.length, truncated: objects.length > slice.length, bbox, objects: slice },
    }
  }

  function createDraft({ name, copyFrom, switchActive }) {
    let source = null
    if (copyFrom !== undefined && copyFrom !== null) source = requireDraft(copyFrom)
    const draft = makeDraft(name ? String(name).slice(0, 60) : `草稿 ${draftsRef.current.length + 1}`)
    draft.objects = source ? cleanObjects(source.id === activeIdRef.current ? objectsRef.current : source.objects || []) : []
    const committed = draftsRef.current.map((d) => (d.id === activeIdRef.current ? { ...d, objects: objectsRef.current, viewport: vpRef.current } : d))
    const next = [...committed, draft]
    draftsRef.current = next
    persistNow(next, switchActive ? draft.id : activeIdRef.current)
    setDrafts(next)
    if (switchActive) activateDraft(draft.id, draft)
    return { id: draft.id, name: draft.name, switched: switchActive === true }
  }

  function renameDraft({ draftId, name }) {
    const target = requireDraft(draftId ?? activeIdRef.current)
    const nextName = String(name || '').slice(0, 60)
    if (!nextName.trim()) fail('name 不能为空')
    const next = draftsRef.current.map((d) => (d.id === target.id ? { ...d, name: nextName } : d))
    draftsRef.current = next
    persistNow(next, activeIdRef.current)
    setDrafts(next)
    return { id: target.id, name: nextName }
  }

  /** 切换活动草稿（与 App.switchDraft 同语义） */
  function activateDraft(id, knownDraft) {
    const target = knownDraft || findDraft(id)
    if (!target) fail(`草稿不存在：${String(id)}`)
    if (id === activeIdRef.current) return { activeId: id, unchanged: true }
    const withCurrent = draftsRef.current.map((d) => (d.id === activeIdRef.current ? { ...d, objects: JSON.parse(JSON.stringify(objectsRef.current)), viewport: vpRef.current } : d))
    draftsRef.current = withCurrent
    persistRef.current?.saveData({ version: 1, activeId: id, drafts: withCurrent })
    setDrafts(withCurrent)
    objectsRef.current = JSON.parse(JSON.stringify(target.objects || []))
    undoRef.current = []
    redoRef.current = []
    setUndoTick((n) => n + 1)
    setSelection([])
    selectionRef.current = []
    setActiveId(id)
    activeIdRef.current = id
    setVp(target.viewport || vpRef.current)
    notifyObjects()
    return { activeId: id }
  }

  function switchDraft({ draftId }) {
    if (typeof draftId !== 'string' || !draftId) fail('需要 draftId')
    return activateDraft(draftId)
  }

  /* ---------- 撤销 / 重做（只作用于活动草稿） ---------- */

  function undo() {
    const snap = undoRef.current.pop()
    if (!snap) return { undone: false, note: '无可撤销操作（仅活动草稿维护撤销栈）' }
    redoRef.current.push({ objects: JSON.parse(JSON.stringify(objectsRef.current)), selection: [...(selectionRef.current || [])] })
    objectsRef.current = JSON.parse(JSON.stringify(snap.objects))
    setSelection(snap.selection || [])
    selectionRef.current = snap.selection || []
    notifyObjects()
    const next = draftsRef.current.map((d) => (d.id === activeIdRef.current ? { ...d, objects: objectsRef.current, updatedAt: Date.now() } : d))
    draftsRef.current = next
    persistNow(next, activeIdRef.current)
    setDrafts(next)
    setUndoTick((n) => n + 1)
    return { undone: true }
  }

  function redo() {
    const snap = redoRef.current.pop()
    if (!snap) return { redone: false, note: '无可重做操作' }
    undoRef.current.push({ objects: JSON.parse(JSON.stringify(objectsRef.current)), selection: [...(selectionRef.current || [])] })
    objectsRef.current = JSON.parse(JSON.stringify(snap.objects))
    setSelection(snap.selection || [])
    selectionRef.current = snap.selection || []
    notifyObjects()
    const next = draftsRef.current.map((d) => (d.id === activeIdRef.current ? { ...d, objects: objectsRef.current, updatedAt: Date.now() } : d))
    draftsRef.current = next
    persistNow(next, activeIdRef.current)
    setDrafts(next)
    setUndoTick((n) => n + 1)
    return { redone: true }
  }

  /* ---------- 截图合成 ---------- */

  async function hydrateImages(objects) {
    const map = new Map(imagesRef.current)
    const missing = []
    for (const o of objects) {
      if (o.kind !== 'image') continue
      const key = o.blobId || `inline:${o.id}`
      if (map.has(key)) continue
      missing.push({ o, key })
    }
    if (missing.length) {
      const kit = kitRef.current
      await Promise.all(missing.map(async ({ o, key }) => {
        const dataUrl = o.blobId ? await getImageBlob(kit, o.blobId) : o.dataUrl
        if (!dataUrl) return
        try {
          map.set(key, await loadImage(dataUrl))
        } catch { /* 坏图跳过：与可见渲染一致（缺图不画） */ }
      }))
      setImages((prev) => {
        const merged = new Map(prev)
        for (const [k, v] of map) if (!merged.has(k)) merged.set(k, v)
        return merged
      })
      imagesRef.current = map
    }
    return map
  }

  async function capture({ draftId, ids, format, padding, maxDim }) {
    const target = resolveTarget(draftId)
    let list = target.objects
    if (!list.length) fail('草稿为空，没有可截图的内容')
    if (Array.isArray(ids) && ids.length) {
      const set = new Set(ids.map(String))
      const keep = list.filter((o) => o.kind !== 'erase' && set.has(o.id))
      if (!keep.length) fail('ids 未匹配到任何可绘制对象')
      const bbox = unionBBox(keep)
      const withErase = list.filter((o) => {
        if (o.kind !== 'erase') return set.has(o.id)
        const b = objectBBox(o)
        return bbox && b.x < bbox.x + bbox.w && b.x + b.w > bbox.x && b.y < bbox.y + bbox.h && b.y + b.h > bbox.y
      })
      list = withErase
    }
    // 字体就绪（隐藏页冷启动首帧文字度量依赖手写字体）
    try {
      if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1200))])
    } catch { /* 字体 API 缺失不影响截图 */ }
    const images = await hydrateImages(stripBorn(list))
    const theme = currentTheme()
    const opts = {
      images,
      roughness: settingsRef.current.roughness,
      transparent: false,
      paper: theme.paper,
      padding: num(padding, 24, 0, 400, 'padding'),
    }
    const requested = format === 'jpeg' ? 'jpeg' : 'png'
    const ceiling = num(maxDim, 1600, 160, 2400, 'maxDim')
    const dims = [ceiling, ...CAPTURE_DIMS.filter((d) => d < ceiling)].sort((a, b) => b - a)
    const encode = (canvas, fmt) => canvas.toDataURL(fmt === 'jpeg' ? 'image/jpeg' : 'image/png', 0.85)
    let last
    for (const maxDim of dims) {
      const composed = composeExport(stripBorn(list), { ...opts, maxDim })
      if (!composed) fail('内容无法合成（包围盒为空）')
      const { canvas } = composed
      for (const fmt of requested === 'jpeg' ? ['jpeg', 'png'] : ['png', 'jpeg']) {
        const dataUrl = encode(canvas, fmt)
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
        last = { fmt, base64, width: canvas.width, height: canvas.height }
        if (base64.length <= B64_BUDGET) {
          return {
            content: [
              { type: 'text', text: `草稿「${(findDraft(target.id)?.name) || target.id}」截图（${canvas.width}×${canvas.height}，${fmt}，约 ${Math.round((base64.length * 3) / 4 / 1024)}KB）` },
              { type: 'image', data: base64, mimeType: fmt === 'jpeg' ? 'image/jpeg' : 'image/png' },
            ],
            structured: { draftId: target.id, format: fmt, width: canvas.width, height: canvas.height, bytes: Math.round((base64.length * 3) / 4), objectCount: list.length },
          }
        }
      }
    }
    fail(`图像超过 MCP 单次 1MiB 结果上限（最小尝试 ${last?.width}×${last?.height} ${last?.fmt} 仍约 ${Math.round((last?.base64.length || 0) / 1024)}KB base64）；请缩小 ids 范围、减小 maxDim 或改用 format:"jpeg"`)
  }

  return {
    addElements, updateElements, deleteElements, clearDraft,
    listDrafts, getDraft, createDraft, renameDraft, switchDraft,
    undo, redo, capture,
  }
}
