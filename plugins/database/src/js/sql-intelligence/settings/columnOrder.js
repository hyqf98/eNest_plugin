/** Pointer capture keeps a drag owned by this list; keyboard uses the same move. */
export function bindColumnOrder(root, { getColumns, move }) {
  let drag = null
  const rows = () => [...root.querySelectorAll('[data-column-order-row]')]
  function clear() {
    if (!drag) return
    const pointer = drag.pointer
    rows().forEach(row => { row.style.removeProperty('transform'); row.classList.remove('dragging', 'drop-before', 'drop-after') })
    drag = null
    if (root.hasPointerCapture(pointer)) root.releasePointerCapture(pointer)
  }
  function down(event) {
    const handle = event.target.closest('[data-drag-column]')
    if (!handle || event.button !== 0) return
    event.preventDefault(); handle.focus()
    const row = handle.closest('li'), index = Number(handle.dataset.dragColumn)
    drag = { pointer: event.pointerId, index, target: index, y: event.clientY, columns: getColumns().join('\u0000') }
    row.classList.add('dragging'); root.setPointerCapture(event.pointerId)
  }
  function pointerMove(event) {
    if (!drag || event.pointerId !== drag.pointer) return
    const list = rows(), current = list[drag.index]
    if (!current) return clear()
    const container = current.parentElement, bounds = container.getBoundingClientRect()
    if (event.clientY < bounds.top + 24) container.scrollTop -= 12
    else if (event.clientY > bounds.bottom - 24) container.scrollTop += 12
    current.style.transform = `translateY(${event.clientY - drag.y}px)`
    const others = list.filter((_, index) => index !== drag.index)
    const before = others.find(row => { const rect = row.getBoundingClientRect(); return event.clientY < rect.top + rect.height / 2 })
    drag.target = before ? others.indexOf(before) : list.length - 1
    list.forEach(row => row.classList.remove('drop-before', 'drop-after'))
    if (drag.target !== drag.index) (before || others.at(-1))?.classList.add(before ? 'drop-before' : 'drop-after')
  }
  function up(event) {
    if (!drag || event.pointerId !== drag.pointer) return
    const { index, target, columns } = drag
    clear()
    if (columns === getColumns().join('\u0000') && index !== target) move(index, target)
  }
  function key(event) {
    const handle = event.target.closest('[data-drag-column]')
    if (event.key === 'Escape' && drag) { event.preventDefault(); clear(); return }
    if (!handle || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = Number(handle.dataset.dragColumn), last = getColumns().length - 1
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, index + (event.key === 'ArrowUp' ? -1 : 1)))
    if (target !== index) move(index, target)
  }
  const events = { pointerdown: down, pointermove: pointerMove, pointerup: up, pointercancel: clear, lostpointercapture: clear, keydown: key }
  Object.entries(events).forEach(([name, listener]) => root.addEventListener(name, listener))
  return () => { clear(); Object.entries(events).forEach(([name, listener]) => root.removeEventListener(name, listener)) }
}
