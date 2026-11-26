import { findClusterBreak } from '@codemirror/state'

function relativePosition(element, node, offset, x, y) {
  if (!node || !element.contains(node)) return null
  const range = element.ownerDocument.createRange()
  range.selectNodeContents(element)
  range.setEnd(node, offset)
  if (node.nodeType !== 3) {
    const edge = range.cloneRange()
    edge.collapse(false)
    const hit = closestRects(edge, x, y)
    if (!hit || hit.vertical || hit.horizontal > 1) return null
  }
  const end = node.nodeType === 3 ? node.length : node.childNodes.length
  return { offset: range.toString().length, assoc: offset > 0 && offset === end ? -1 : 1 }
}

function nativePosition(element, x, y) {
  const doc = element.ownerDocument
  try {
    const position = doc.caretPositionFromPoint?.(x, y)
    const direct = relativePosition(element, position?.offsetNode, position?.offset, x, y)
    if (direct) return direct
    const range = doc.caretRangeFromPoint?.(x, y)
    return relativePosition(element, range?.startContainer, range?.startOffset, x, y)
  } catch { return null }
}

function closer(first, second) {
  return first && (!second || first.vertical < second.vertical || first.vertical === second.vertical && first.horizontal < second.horizontal)
}

function closestRects(range, x, y) {
  let best = null
  for (const rect of range.getClientRects()) {
    if (!rect.height) continue
    const hit = { vertical: Math.max(rect.top - y, y - rect.bottom, 0), horizontal: Math.max(rect.left - x, x - rect.right, 0) }
    if (closer(hit, best)) best = hit
  }
  return best
}

function measuredPosition(element, x, y) {
  const doc = element.ownerDocument
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const range = doc.createRange()
  let length = 0, best = null, textNode = null, nodeStart = 0
  while (walker.nextNode()) {
    const node = walker.currentNode
    range.selectNodeContents(node)
    const distance = closestRects(range, x, y)
    if (closer(distance, best)) { best = distance; textNode = node; nodeStart = length }
    length += node.length
  }
  if (!textNode) return length ? null : { offset: 0, assoc: 1 }
  const distanceTo = (from, to) => {
    range.setStart(textNode, from)
    range.setEnd(textNode, to)
    return closestRects(range, x, y)
  }
  let from = 0, to = textNode.length
  while (from < to) {
    const middle = findClusterBreak(textNode.data, Math.floor((from + to) / 2), false)
    const split = middle > from ? middle : findClusterBreak(textNode.data, from)
    if (split >= to) break
    if (closer(distanceTo(from, split), distanceTo(split, to))) to = split
    else from = split
  }
  const offset = closer(distanceTo(to, to), distanceTo(from, from)) ? to : from
  return { offset: nodeStart + offset, assoc: offset === textNode.length && offset > 0 ? -1 : 1 }
}

export function textPositionAtPoint(element, x, y) {
  if (!element || !Number.isFinite(x) || !Number.isFinite(y)) return null
  const direct = nativePosition(element, x, y)
  if (direct) return direct
  const doc = element.ownerDocument
  const hit = doc.elementFromPoint(x, y)
  if (hit && hit !== element && element.contains(hit) && hit.textContent) {
    const local = measuredPosition(hit, x, y)
    if (local) {
      const before = doc.createRange()
      before.selectNodeContents(element)
      before.setEndBefore(hit)
      return { offset: before.toString().length + local.offset, assoc: local.assoc }
    }
  }
  return measuredPosition(element, x, y)
}

export function textOffsetAtPoint(element, x, y) {
  return textPositionAtPoint(element, x, y)?.offset ?? null
}
