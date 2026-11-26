import assert from 'node:assert/strict'
import test from 'node:test'
import {
  displayRectInViewport, projectRect, rasterSize, toolbarPosition, viewportRectOnDisplay, visibleWorkArea
} from '../public/assets/vendor/screen-assistant/geometry.js'

const display = {
  id: 0, scaleFactor: 2,
  bounds: { x: -2560, y: -1440, width: 2560, height: 1440 },
  workArea: { x: -2560, y: -1416, width: 2560, height: 1368 }
}
const content = { x: -2560, y: -1416, width: 2560, height: 1416 }
const full = { x: 0, y: 0, ...rasterSize(display) }

test('a clipped native viewport offsets the desktop image rather than shrinking it', () => {
  assert.deepEqual(displayRectInViewport(full, display, content, content), { x: 0, y: -24, width: 2560, height: 1440 })
  const viewport = { width: 1280, height: 708 }
  const selection = { x: 100, y: 0, width: 40, height: 50 }
  const pixels = viewportRectOnDisplay(selection, display, content, viewport)
  assert.deepEqual(pixels, { x: 400, y: 48, width: 160, height: 200 })
  assert.deepEqual(displayRectInViewport(pixels, display, content, viewport), selection)
})

test('a full display and an edge selection stay anchored independently of the toolbar', () => {
  const area = visibleWorkArea(display, content, content)
  const image = displayRectInViewport(full, display, content, content)
  const toolbar = { width: 420, height: 42 }
  assert.deepEqual(area, { x: 0, y: 0, width: 2560, height: 1368 })
  assert.deepEqual(toolbarPosition(image, toolbar, area), { x: 2132, y: 1318 })
  const edge = displayRectInViewport({ x: 0, y: 48, width: 10, height: 10 }, display, content, content)
  assert.deepEqual(edge, { x: 0, y: 0, width: 5, height: 5 })
  assert.deepEqual(toolbarPosition(edge, toolbar, area), { x: 8, y: 13 })
})

test('fractional display scaling rounds endpoints rather than the selection width', () => {
  const fractional = { ...display.bounds, id: 1, scaleFactor: 1.25 }
  assert.deepEqual(viewportRectOnDisplay({ x: 1, y: 2, width: 1, height: 2 }, fractional, undefined, fractional),
    { x: 1, y: 3, width: 2, height: 2 })
})

test('a downscaled preview or video crops the same physical corner without overflowing', () => {
  assert.deepEqual(projectRect({ x: 5116, y: 2875, width: 8, height: 10 }, rasterSize(display),
    { width: 4096, height: 2304 }, true), { x: 4093, y: 2300, width: 3, height: 4 })
})
