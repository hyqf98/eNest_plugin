const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

export function rasterSize(display) {
  const size = display.bounds || display
  return {
    width: Math.max(1, Math.round(size.width * display.scaleFactor)),
    height: Math.max(1, Math.round(size.height * display.scaleFactor))
  }
}

export function projectRect(rect, fromSize, toSize, round = false) {
  const edge = (value, from, to) => {
    const scaled = clamp(value, 0, from) * to / from
    return round ? Math.round(scaled) : scaled
  }
  const left = edge(rect.x, fromSize.width, toSize.width)
  const top = edge(rect.y, fromSize.height, toSize.height)
  const right = edge(rect.x + rect.width, fromSize.width, toSize.width)
  const bottom = edge(rect.y + rect.height, fromSize.height, toSize.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function nativeRectInViewport(rect, content, viewport) {
  const scaleX = viewport.width / content.width
  const scaleY = viewport.height / content.height
  return {
    x: (rect.x - content.x) * scaleX, y: (rect.y - content.y) * scaleY,
    width: rect.width * scaleX, height: rect.height * scaleY
  }
}

export function displayRectInViewport(bounds, display, viewportBounds, viewportSize) {
  const screen = display.bounds || display
  const local = projectRect(bounds, rasterSize(display), screen)
  return nativeRectInViewport({ ...local, x: screen.x + local.x, y: screen.y + local.y }, viewportBounds || screen, viewportSize)
}

export function viewportRectOnDisplay(rect, display, viewportBounds, viewportSize) {
  const screen = display.bounds || display
  const content = viewportBounds || screen
  const scaleX = content.width / viewportSize.width
  const scaleY = content.height / viewportSize.height
  return projectRect({
    x: content.x - screen.x + rect.x * scaleX, y: content.y - screen.y + rect.y * scaleY,
    width: rect.width * scaleX, height: rect.height * scaleY
  }, screen, rasterSize(display), true)
}

export function visibleWorkArea(display, viewportBounds, viewportSize) {
  const screen = display.bounds || display
  const workArea = nativeRectInViewport(display.workArea || screen, viewportBounds || screen, viewportSize)
  return projectRect(workArea, viewportSize, viewportSize)
}

export function toolbarPosition(rect, toolbar, area, gap = 8) {
  const left = area.x + gap, top = area.y + gap
  const right = area.x + area.width - gap, bottom = area.y + area.height - gap
  const below = rect.y + rect.height + gap, above = rect.y - gap - toolbar.height
  const preferred = below + toolbar.height <= bottom ? below : above >= top ? above : rect.y + rect.height - toolbar.height - gap
  return {
    x: clamp(rect.x + rect.width - toolbar.width, left, right - toolbar.width),
    y: clamp(preferred, top, bottom - toolbar.height)
  }
}

export function sameDisplay(expected, actual) {
  const initial = expected.bounds || expected, current = actual.bounds || actual
  return expected.id === actual.id && expected.scaleFactor === actual.scaleFactor &&
    initial.x === current.x && initial.y === current.y && initial.width === current.width && initial.height === current.height
}
