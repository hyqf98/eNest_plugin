/**
 * CanvasStage —— 画布区：单 canvas 渲染 + screen 空间 DOM 覆盖层
 * 指针事件状态机（绘制/平移/框选/拖动/缩放手柄）在本组件内闭环，
 * 通过 props 与 App 交换文档对象与视口。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { hitChain, hitShape, marqueeSelect, objectBBox, selectionBBox, translateObject, scaleObject, hitImage } from '../js/objects.mjs'
import { applyWheel, screenToWorld, worldToScreen } from '../js/viewport.mjs'
import { renderFrame, anyFading } from '../js/render.mjs'
import { toolCursor, grabCursor } from '../js/cursors.mjs'

const HANDLES = [
  { id: 'nw', fx: 0, fy: 0 }, { id: 'n', fx: 0.5, fy: 0 }, { id: 'ne', fx: 1, fy: 0 },
  { id: 'e', fx: 1, fy: 0.5 }, { id: 'se', fx: 1, fy: 1 }, { id: 's', fx: 0.5, fy: 1 },
  { id: 'sw', fx: 0, fy: 1 }, { id: 'w', fx: 0, fy: 0.5 },
]

export function CanvasStage(props) {
  const {
    objectsRef, images, vp, setVp, tool, settings, theme,
    selection, setSelection,
    onCommitObjects, // (nextObjects | mutator(objects), {snapshot:boolean}) 文档变更入口
    objectsTick = 0, // 对象版本号：橡皮/移动拖动中每步变化，驱动实时重绘
    onAddObject, onDeleteObjects, onCloneSelection,
    onTextEdit, spaceDown, draftJustLoaded,
  } = props

  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const rafRef = useRef(0)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [marquee, setMarquee] = useState(null)      // screen 坐标选框
  const draftInkRef = useRef(null)                  // 正在画的墨迹/擦除笔迹（ref 存点，避免 stale closure 丢点）
  const [draftInkTick, setDraftInkTick] = useState(0) // 仅驱动重绘
  const dragRef = useRef(null)                      // 指针会话状态
  const cycleRef = useRef(null)                     // 层叠循环选中：同点连击位置（screen）
  const eraseGhostRef = useRef(null)                // 橡皮圆圈指示（屏幕空间 {x,y,r}；null 隐藏）
  const [hoverText, setHoverText] = useState(null)
  const hoverImageRef = useRef({ id: null, t0: 0, from: 1, to: 1 })  // 贴图悬停放大动画状态

  /* 贴图悬停动画：easeOutBack 回弹（从小到大弹一下），移开时缩回 */
  const startHoverAnim = (id) => {
    const cur = hoverImageRef.current
    const now = performance.now()
    hoverImageRef.current = { id, t0: now, from: cur.id === id ? curScale(cur) : 1, to: id ? 1.12 : 1 }
    let raf = 0
    const tick = () => {
      const h = hoverImageRef.current
      const t = Math.min(1, (performance.now() - h.t0) / 220)
      if (t >= 1 || h.id !== id) { if (h.id === id) scheduleRender(); return }
      scheduleRender()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }
  const curScale = (h) => {
    const t = Math.min(1, (performance.now() - h.t0) / 220)
    const c1 = 1.70158, c3 = c1 + 1
    const e = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2) // easeOutBack
    return h.from + (h.to - h.from) * e
  }

  /* ---- 尺寸观测：RO 为主，resize + 低频轮询兜底（部分 webview 对 0 尺寸起始元素不触发 RO） ---- */
  const measure = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setSize((prev) => (Math.round(r.width) === prev.w && Math.round(r.height) === prev.h ? prev : { w: Math.round(r.width), h: Math.round(r.height) }))
  }, [])
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    const poll = setInterval(measure, 500)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); clearInterval(poll) }
  }, [measure])

  /* ---- 渲染循环（视口/文档/主题变化时重绘） ---- */
  const draftShapeRef = useRef(null)                 // 正在拖拽的图形（ref 同步，state 驱动重绘）
  const [shapeTick, setShapeTick] = useState(0)
  const scheduleRender = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const canvas = canvasRef.current
      if (!canvas) return
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(size.w * dpr) || canvas.height !== Math.round(size.h * dpr)) {
        canvas.width = Math.round(size.w * dpr)
        canvas.height = Math.round(size.h * dpr)
      }
      const ctx = canvas.getContext('2d')
      let objects = objectsRef.current
      if (draftInkRef.current) objects = [...objects, draftInkRef.current]
      if (draftShapeRef.current) objects = [...objects, draftShapeRef.current]
      const h = hoverImageRef.current
      const hoverImage = h.id ? { id: h.id, scale: curScale(h) } : null
      renderFrame(ctx, canvas, { vp, dpr, objects, images, theme, settings, hoverImage })
      // 橡皮活动时的圆圈指示（屏幕空间）
      const eraseRef = eraseGhostRef.current
      if (eraseRef) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.beginPath()
        ctx.arc(eraseRef.x, eraseRef.y, eraseRef.r, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(90, 98, 110, 0.85)'
        ctx.lineWidth = 1.25
        ctx.stroke()
        ctx.fillStyle = 'rgba(255, 255, 255, 0.22)'
        ctx.fill()
      }
    })
  }, [size, vp, images, theme, settings, objectsRef, draftInkTick, objectsTick, shapeTick])

  useEffect(() => { scheduleRender() }, [scheduleRender])

  /* ---- 淡入动画驱动：有 _born 未到期对象时连续补帧 ---- */
  useEffect(() => {
    if (!anyFading(objectsRef.current)) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (!anyFading(objectsRef.current)) { cancelAnimationFrame(raf); raf = 0; scheduleRender(); return }
      scheduleRender()
    }
    raf = requestAnimationFrame(tick)
    return () => { if (raf) cancelAnimationFrame(raf) }
  })

  /* ---- 光标 ---- */
  const cursor = spaceDown ? grabCursor().cursor : toolCursor(tool, settings, theme)

  /* ---- 指针事件 ---- */
  const pointerPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const hitHandle = (pos) => {
    if (selection.length !== 1) return null
    const obj = objectsRef.current.find((o) => o.id === selection[0])
    if (!obj) return null
    const b = objectBBox(obj)
    for (const h of HANDLES) {
      const hx = (b.x + b.w * h.fx) * vp.zoom + vp.x
      const hy = (b.y + b.h * h.fy) * vp.zoom + vp.y
      if (Math.abs(pos.x - hx) <= 7 && Math.abs(pos.y - hy) <= 7) return { handle: h.id, obj }
    }
    return null
  }

  const onPointerDown = (e) => {
    if (e.button === 2) return // 右键由 contextmenu 处理
    const pos = pointerPos(e)
    const world = screenToWorld(vp, pos.x, pos.y)
    // setPointerCapture 在部分 webview/合成事件下会抛 NotFoundError，失败不致命（pointerup 由 window 兜底）
    try { canvasRef.current.setPointerCapture(e.pointerId) } catch { /* noop */ }

    // 空格或中键：平移
    if (spaceDown || e.button === 1) {
      dragRef.current = { mode: 'pan', last: pos }
      return
    }

    // 选择工具
    if (tool === 'select') {
      const hh = hitHandle(pos)
      if (hh) {
        onCommitObjects((objects) => {
          const obj = objects.find((o) => o.id === hh.obj.id)
          if (!obj) return
          const b = objectBBox(obj)
          dragRef.current = {
            mode: 'resize', handle: hh.handle, id: obj.id, startBBox: b, startWorld: world, moved: false,
            before: JSON.parse(JSON.stringify(objects)),
          }
        })
        // resize 会话在下一行建立；上面闭包仅取 bbox
        const obj = objectsRef.current.find((o) => o.id === hh.obj.id)
        if (obj) {
          dragRef.current = { mode: 'resize', handle: hh.handle, id: obj.id, startBBox: objectBBox(obj), startWorld: world, moved: false }
          return
        }
      }
      // 同点层叠循环：连点同一位置在叠放对象间切换（第一个命中选中后，再点跳到其下的候选）
      const { strict, interior } = hitChain(objectsRef.current, world.x, world.y, 6 / vp.zoom)
      const candidates = strict.length ? strict : interior
      if (candidates.length) {
        const prev = selection.length === 1 ? selection[0] : null
        const prevIdx = prev ? candidates.findIndex((o) => o.id === prev) : -1
        const sameSpot = Math.hypot(pos.x - (cycleRef.current?.x ?? -1e4), pos.y - (cycleRef.current?.y ?? -1e4)) < 6
        const hit = (prevIdx >= 0 && candidates.length > 1 && sameSpot)
          ? candidates[(prevIdx + 1) % candidates.length]
          : candidates[0]
        cycleRef.current = { x: pos.x, y: pos.y }
        const multi = e.shiftKey
        let nextSel
        if (multi) nextSel = selection.includes(hit.id) ? selection.filter((id) => id !== hit.id) : [...selection, hit.id]
        else nextSel = [hit.id]
        setSelection(nextSel)
        if (hit.kind === 'text' && e.detail === 2) { onTextEdit(hit); return }
        dragRef.current = { mode: 'move', ids: nextSel, last: pos, moved: false, from: world }
        return
      }
      cycleRef.current = null
      if (!e.shiftKey) setSelection([])
      dragRef.current = { mode: 'marquee', start: pos, additive: e.shiftKey, base: e.shiftKey ? [...selection] : [] }
      return
    }

    // 橡皮：像素级擦除笔迹（墨迹按 destination-out 挖除）+ 图形/文字/贴图包围盒整删
    if (tool === 'eraser') {
      const eraseSizeWorld = settings.eraserSize / vp.zoom
      draftInkRef.current = { id: 'draft-erase', kind: 'erase', points: [{ x: world.x, y: world.y }], size: eraseSizeWorld }
      setDraftInkTick((n) => n + 1)
      dragRef.current = { mode: 'erase' }
      eraseGhostRef.current = { x: pos.x, y: pos.y, r: settings.eraserSize / 2 }
      runErase(world)
      return
    }
    // 文字：记下位置，pointerup 后再弹编辑框（press 期间 focus 会被指针交互夺回，导致 overlay 立即 blur 消失）
    if (tool === 'text') {
      dragRef.current = { mode: 'placeText', world }
      return
    }

    // 墨迹
    if (tool === 'pen' || tool === 'highlighter') {
      const size2 = tool === 'highlighter' ? settings.highlightWidth : settings.strokeWidth
      const color = tool === 'highlighter' ? theme.highlighter : (settings.color || theme.ink)
      const first = { x: world.x, y: world.y, p: e.pressure > 0 ? e.pressure : 0.5 }
      draftInkRef.current = { id: 'draft', kind: 'ink', points: [first], color, size: size2, highlighter: tool === 'highlighter' }
      setDraftInkTick((n) => n + 1)
      dragRef.current = { mode: 'ink' }
      return
    }

    // 图形
    if (['rect', 'ellipse', 'line', 'arrow'].includes(tool)) {
      draftShapeRef.current = { id: 'draft-shape', kind: 'shape', type: tool, x: world.x, y: world.y, x2: world.x, y2: world.y, color: settings.color || theme.ink, stroke: Math.max(settings.strokeWidth, 1.5), seed: (Math.random() * 2000) | 0, fill: 'none' }
      setShapeTick((n) => n + 1)
      dragRef.current = { mode: 'shape' }
      return
    }
  }

  const runErase = (world) => {
    // 像素擦除由 erase 笔迹在渲染层完成；这里处理图形/文字/贴图整删（可撤销）。
    // 图形按笔画/边框命中（橡皮圆半径即命中容差），空心框内部划过不误删整框
    const r = settings.eraserSize / 2 / vp.zoom
    onCommitObjects((objects) => {
      for (let i = objects.length - 1; i >= 0; i--) {
        const obj = objects[i]
        if (obj.kind === 'ink' || obj.kind === 'erase') continue
        if (obj.kind === 'shape') { if (hitShape(obj, world.x, world.y, r)) objects.splice(i, 1); continue }
        const b = objectBBox(obj)
        if (world.x >= b.x - r && world.x <= b.x + b.w + r && world.y >= b.y - r && world.y <= b.y + b.h + r) {
          objects.splice(i, 1)
        }
      }
    }, { snapshot: false })
  }

  const onPointerMove = (e) => {
    const pos = pointerPos(e)
    const world = screenToWorld(vp, pos.x, pos.y)
    const drag = dragRef.current

    // 橡皮圆圈跟随光标（无论是否按下）
    if (tool === 'eraser' || drag?.mode === 'erase') {
      const was = eraseGhostRef.current
      eraseGhostRef.current = { x: pos.x, y: pos.y, r: settings.eraserSize / 2 }
      if (!drag || drag.mode !== 'erase' || was?.x !== pos.x || was?.y !== pos.y) scheduleRender()
    }

    if (!drag) {
      // 图片悬停预览放大（选择工具空闲时）：命中贴图即以回弹动画放大 1.12x
      if (tool === 'select') {
        const hit = objectsRef.current.find((o) => o.kind === 'image' && hitImage(o, world.x, world.y))
        const prevHover = hoverImageRef.current.id
        const nextHover = hit?.id || null
        if (nextHover !== prevHover) startHoverAnim(nextHover)
      }
      return
    }

    if (drag.mode === 'pan') {
      // 平移增量走 ref 累积 + rAF 单次提交：多 move 同帧到达时不受 React 批处理/闭包影响
      drag.panAcc = (drag.panAcc || { x: 0, y: 0 })
      drag.panAcc.x += pos.x - drag.last.x
      drag.panAcc.y += pos.y - drag.last.y
      drag.last = pos
      if (!drag.panFrame) {
        drag.panFrame = requestAnimationFrame(() => {
          drag.panFrame = 0
          const acc = drag.panAcc || { x: 0, y: 0 }
          drag.panAcc = { x: 0, y: 0 }
          if (acc.x || acc.y) setVp((prev) => ({ ...prev, x: prev.x + acc.x, y: prev.y + acc.y }))
        })
      }
      return
    }

    if (drag.mode === 'ink' && draftInkRef.current) {
      const pts = draftInkRef.current.points
      const last = pts[pts.length - 1]
      const dist = Math.hypot(world.x - last.x, world.y - last.y)
      if (dist > 1.2 / vp.zoom) {
        const pressure = e.pressure > 0 ? e.pressure : Math.max(0.15, Math.min(1, 0.5 - dist * 0.02 * vp.zoom))
        pts.push({ x: world.x, y: world.y, p: pressure })
        setDraftInkTick((n) => n + 1)
      }
      return
    }

    if (drag.mode === 'erase' && draftInkRef.current?.kind === 'erase') {
      const pts = draftInkRef.current.points
      const last = pts[pts.length - 1]
      if (Math.hypot(world.x - last.x, world.y - last.y) > 1 / vp.zoom) {
        pts.push({ x: world.x, y: world.y })
        setDraftInkTick((n) => n + 1)
      }
      runErase(world)
      return
    }

    if (drag.mode === 'shape' && draftShapeRef.current) {
      const ds = draftShapeRef.current
      let next = { ...ds, x2: world.x, y2: world.y }
      if (e.shiftKey) {
        // shift 约束：矩形正方、椭圆正圆、线 45°
        if (ds.type === 'line' || ds.type === 'arrow') {
          const dx = world.x - ds.x, dy = world.y - ds.y
          const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
          const len = Math.hypot(dx, dy)
          next = { ...next, x2: ds.x + Math.cos(ang) * len, y2: ds.y + Math.sin(ang) * len }
        } else {
          const s = Math.max(Math.abs(world.x - ds.x), Math.abs(world.y - ds.y))
          next = { ...next, x2: ds.x + Math.sign(world.x - ds.x || 1) * s, y2: ds.y + Math.sign(world.y - ds.y || 1) * s }
        }
      }
      draftShapeRef.current = next
      setShapeTick((n) => n + 1)
      return
    }

    if (drag.mode === 'erase') {
      runErase(world)
      return
    }

    if (drag.mode === 'marquee') {
      setMarquee({ x: Math.min(drag.start.x, pos.x), y: Math.min(drag.start.y, pos.y), w: Math.abs(pos.x - drag.start.x), h: Math.abs(pos.y - drag.start.y) })
      return
    }

    if (drag.mode === 'move') {
      const dx = world.x - drag.from.x, dy = world.y - drag.from.y
      if (!drag.moved && Math.hypot(dx, dy) * vp.zoom < 3) return
      drag.moved = true
      drag.from = world
      onCommitObjects((objects) => {
        for (const obj of objects) if (drag.ids.includes(obj.id)) translateObject(obj, dx, dy)
      }, { snapshot: !drag.didSnapshot })
      drag.didSnapshot = true
      return
    }

    if (drag.mode === 'resize') {
      const obj = objectsRef.current.find((o) => o.id === drag.id)
      if (!obj) return
      const b0 = drag.startBBox
      let minX = b0.x, minY = b0.y, maxX = b0.x + b0.w, maxY = b0.y + b0.h
      const h = drag.handle
      if (h.includes('w')) minX = world.x
      if (h.includes('e')) maxX = world.x
      if (h.includes('n')) minY = world.y
      if (h.includes('s')) maxY = world.y
      // 锚点 = 拖动手柄的对角（拖 se 则锚 nw），缩放绕静止角进行
      const anchor = {
        x: h.includes('e') ? b0.x : b0.x + b0.w,
        y: h.includes('s') ? b0.y : b0.y + b0.h,
      }
      let nw = Math.max(8, maxX - minX), nh = Math.max(8, maxY - minY)
      // 文字：保持宽高比，取拖拽向量的对角线长度比例（角柄）或主轴比例（边柄）
      let sx = nw / Math.max(b0.w, 1), sy = nh / Math.max(b0.h, 1)
      if (obj.kind === 'text') {
        const diag = Math.hypot(maxX - anchor.x, maxY - anchor.y) / Math.max(Math.hypot(b0.w, b0.h), 1)
        if (h.length === 2) { sx = diag; sy = diag }
        else if (h === 'e' || h === 'w') { sy = sx }
        else { sx = sy }
        // 依据锚点重算目标尺寸由 scaleObject 的 map 完成，这里只需比例
        nw = Math.max(8, b0.w * (h === 'e' || h === 'w' ? sx : sx))
        nh = Math.max(8, b0.h * (h === 'n' || h === 's' ? sy : sy))
      }
      onCommitObjects((objects) => {
        const target = objects.find((o) => o.id === drag.id)
        if (!target) return
        // 恢复到起点再施加本次缩放（幂等）
        const restored = drag.original ? JSON.parse(JSON.stringify(drag.original)) : null
        if (restored) {
          const idx = objects.indexOf(target)
          objects[idx] = restored
          scaleObject(restored, sx, sy, anchor)
        }
      }, { snapshot: !drag.didSnapshot })
      drag.didSnapshot = true
      drag.original = drag.original || JSON.parse(JSON.stringify(obj))
      return
    }
  }

  const finishSession = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.mode === 'erase') eraseGhostRef.current = null
    if (drag?.panFrame) cancelAnimationFrame(drag.panFrame)

    if ((drag?.mode === 'ink' || drag?.mode === 'erase') && draftInkRef.current) {
      const finalInk = { ...draftInkRef.current, id: undefined }
      draftInkRef.current = null
      onAddObject(finalInk)
      setDraftInkTick((n) => n + 1)
    }
    if (drag?.mode === 'shape' && draftShapeRef.current) {
      const ds = draftShapeRef.current
      const w = Math.abs(ds.x2 - ds.x), h = Math.abs(ds.y2 - ds.y)
      if (w > 4 || h > 4) {
        // 草稿临时 id 必须剥离：否则所有图形共享 'draft-shape'，选中其一等于全选
        if (ds.type === 'line' || ds.type === 'arrow') onAddObject({ ...ds, id: undefined }, { select: true })
        else {
          const box = { ...ds, id: undefined, x: Math.min(ds.x, ds.x2), y: Math.min(ds.y, ds.y2), w, h }
          delete box.x2
          delete box.y2
          onAddObject(box, { select: true })
        }
      }
      draftShapeRef.current = null
      setShapeTick((n) => n + 1)
    }
    if (drag?.mode === 'marquee' && marquee) {
      const a = screenToWorld(vp, marquee.x, marquee.y)
      const b = screenToWorld(vp, marquee.x + marquee.w, marquee.y + marquee.h)
      const rect = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
      const ids = marqueeSelect(objectsRef.current, rect)
      setSelection([...new Set([...(drag.additive ? drag.base : []), ...ids])])
      setMarquee(null)
    }
    if (drag?.mode === 'move' && drag.moved) setSelection([...selection])
    if (drag?.mode === 'placeText') onTextEdit(null, drag.world)
  }

  const onPointerUp = () => finishSession()

  /* ---- 滚轮 ---- */
  const onWheel = useCallback((e) => {
    e.preventDefault()
    const rect = canvasRef.current.getBoundingClientRect()
    // 显式拷贝字段：WheelEvent 的 deltaY/ctrlKey 等是原型 getter，spread 可能取不到
    const fake = {
      deltaY: e.deltaY,
      deltaX: e.deltaX,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    }
    setVp((prev) => applyWheel(prev, fake))
  }, [setVp])

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  /* ---- 选框 screen 几何 ---- */
  const selBox = (() => {
    const objs = objectsRef.current.filter((o) => selection.includes(o.id))
    if (!objs.length) return null
    const b = selectionBBox(objs)
    if (!b) return null
    const p1 = worldToScreen(vp, b.x, b.y)
    return { x: p1.x, y: p1.y, w: b.w * vp.zoom, h: b.h * vp.zoom, single: objs.length === 1 ? objs[0] : null }
  })()

  /* ---- 草稿形状也参与渲染 ---- */

  return (
    <div className="db-stage" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => { if (!dragRef.current && eraseGhostRef.current) { eraseGhostRef.current = null; scheduleRender() } }}
        onContextMenu={(e) => props.onContextMenu(e)}
      />
      {marquee && <div className="db-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
      {selBox && !draftInkRef.current && !draftShapeRef.current && (
        <div className="db-selbox" style={{ left: selBox.x, top: selBox.y, width: selBox.w, height: selBox.h }}>
          {selBox.single && HANDLES.map((h) => (
            <span key={h.id} className={`db-handle db-handle-${h.id}`} style={{ left: `${h.fx * 100}%`, top: `${h.fy * 100}%` }} />
          ))}
        </div>
      )}
      {tool !== 'select' && !spaceDown && (
        <div className="db-toolhint">
          {tool === 'pen' && '钢笔 · 右键快速切换工具 · 滚轮缩放 · 空格平移'}
          {tool === 'highlighter' && '荧光笔 · 右键快速切换工具'}
          {(tool === 'eraser') && '橡皮 · 划过擦除，图形/文字整删'}
          {['rect', 'ellipse', 'line', 'arrow'].includes(tool) && '拖拽绘制 · Shift 约束比例/角度'}
          {tool === 'text' && '点击画布输入文字 · 双击已有文字可编辑'}
        </div>
      )}
    </div>
  )
}
