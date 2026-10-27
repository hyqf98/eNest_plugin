/**
 * viewport.mjs —— 画布视口数学：世界坐标 ↔ 屏幕坐标、滚轮缩放、平移
 * 约定：world = (screen - pan) / zoom；screen = world * zoom + pan
 */

export const ZOOM_MIN = 0.2
export const ZOOM_MAX = 4
export const ZOOM_STEP = 1.1

export function makeViewport(width = 0, height = 0) {
  return { x: width / 2, y: height / 2, zoom: 1 }
}

export function screenToWorld(vp, sx, sy) {
  return { x: (sx - vp.x) / vp.zoom, y: (sy - vp.y) / vp.zoom }
}

export function worldToScreen(vp, wx, wy) {
  return { x: wx * vp.zoom + vp.x, y: wy * vp.zoom + vp.y }
}

export function panBy(vp, dx, dy) {
  return { ...vp, x: vp.x + dx, y: vp.y + dy }
}

/** 以屏幕点 (cx,cy) 为锚缩放（光标下的内容不动） */
export function zoomAt(vp, cx, cy, factor) {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, vp.zoom * factor))
  const k = zoom / vp.zoom
  return { zoom, x: cx - (cx - vp.x) * k, y: cy - (cy - vp.y) * k }
}

/** 滚轮：ctrl/⌘ 或裸滚轮 = 缩放；shift+滚轮 = 横向平移（由调用方判断后传 type） */
export function applyWheel(vp, event, { zoomStep = ZOOM_STEP } = {}) {
  if (event.ctrlKey || event.metaKey) {
    return zoomAt(vp, event.offsetX, event.offsetY, event.deltaY < 0 ? zoomStep : 1 / zoomStep)
  }
  // 裸滚轮在画板上直接作缩放（iPad 白板习惯），shift 保留横向平移
  if (event.shiftKey) {
    return panBy(vp, -event.deltaY, 0)
  }
  return zoomAt(vp, event.offsetX, event.offsetY, event.deltaY < 0 ? zoomStep : 1 / zoomStep)
}

/** 内容居中并适配视口（载入草稿/聚焦全部内容用） */
export function fitToContent(vp, bbox, width, height, { maxZoom = 1.25, padding = 60 } = {}) {
  if (!bbox || bbox.w <= 0 || bbox.h <= 0 || width <= 0 || height <= 0) return vp
  const zoom = Math.min(maxZoom, Math.min((width - padding * 2) / bbox.w, (height - padding * 2) / bbox.h))
  const cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2
  return { zoom, x: width / 2 - cx * zoom, y: height / 2 - cy * zoom }
}
