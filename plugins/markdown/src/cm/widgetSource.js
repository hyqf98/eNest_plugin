const validated = new WeakMap()

export function widgetSourceRange(view, dom, source) {
  if (typeof source !== 'string' || !dom?.isConnected || !view.contentDOM.contains(dom)) return null
  try {
    const from = view.posAtDOM(dom, 0)
    const doc = view.state.doc
    let entries = validated.get(doc)
    const cached = entries?.get(dom)
    if (cached?.source === source && cached.range.from === from) return cached.range
    const to = from + source.length
    if (!Number.isSafeInteger(from) || from < 0 || to > doc.length || view.state.sliceDoc(from, to) !== source) return null
    const range = { from, to }
    if (!entries) validated.set(doc, entries = new WeakMap())
    entries.set(dom, { source, range })
    return range
  } catch { return null }
}

export function selectWidgetSource(view, dom, source, offset, { extend = false } = {}) {
  const range = widgetSourceRange(view, dom, source)
  if (!range || !Number.isSafeInteger(offset) || offset < 0 || offset > source.length) return false
  const head = range.from + offset
  view.dispatch({ selection: { anchor: extend ? view.state.selection.main.anchor : head, head }, scrollIntoView: true, userEvent: 'select.pointer' })
  view.focus()
  return true
}

export function observeWidgetSize(view, dom) {
  let active = true
  const measure = () => { if (active && view.contentDOM.contains(dom)) view.requestMeasure() }
  const Observer = dom.ownerDocument.defaultView?.ResizeObserver
  const observer = Observer && new Observer(measure)
  observer?.observe(dom)
  dom.addEventListener('load', measure, true)
  dom.addEventListener('error', measure, true)
  return () => {
    active = false
    observer?.disconnect()
    dom.removeEventListener('load', measure, true)
    dom.removeEventListener('error', measure, true)
  }
}

export function widgetEdgeCoords(dom, atEnd, block = false) {
  const rect = dom.getBoundingClientRect()
  if (!rect.height || !dom.parentElement) return null
  const style = dom.ownerDocument.defaultView.getComputedStyle(dom.parentElement)
  const fontHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize)
  const height = Math.min(rect.height, fontHeight > 0 ? fontHeight : 16)
  const top = block && !atEnd ? rect.top : rect.bottom - height
  const trailing = !block && atEnd
  const left = (style.direction === 'rtl') !== trailing ? rect.right : rect.left
  return { top, bottom: top + height, left, right: left }
}
