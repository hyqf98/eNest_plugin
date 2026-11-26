import { WidgetType } from '@codemirror/view'
import katex from 'katex'
import { observeWidgetSize, selectWidgetSource, widgetEdgeCoords, widgetSourceRange } from './widgetSource.js'

const mounted = new WeakMap()

class EditablePreview extends WidgetType {
  coordsAt(dom, position) { return widgetEdgeCoords(dom, position > 0) }

  bind(dom, view, source, offset, imageLength) {
    mounted.set(dom, { source, imageLength, dispose: observeWidgetSize(view, dom) })
    dom.addEventListener('mousedown', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return
      if (event.altKey) { if (imageLength) event.preventDefault(); return }
      event.preventDefault()
      selectWidgetSource(view, dom, source, offset, { extend: event.shiftKey })
    })
    return dom
  }

  destroy(dom) {
    mounted.get(dom)?.dispose()
    mounted.delete(dom)
  }
}

export function getImageSourceRange(view, target) {
  const widget = target?.closest?.('.md-image-widget')
  const entry = widget && mounted.get(widget)
  if (!entry) return null
  const current = widgetSourceRange(view, widget, entry.source)
  return current && { from: current.from, imageTo: current.from + entry.imageLength, to: current.to }
}

export class InlineMath extends EditablePreview {
  constructor(source) { super(); this.source = source }
  eq(other) { return this.source === other.source }
  toDOM(view) {
    const dom = view.dom.ownerDocument.createElement('span')
    dom.className = 'md-formula-preview'
    const formula = this.source.slice(1, -1)
    katex.render(formula, dom, { displayMode: false, throwOnError: false, trust: false, output: 'htmlAndMathml' })
    return this.bind(dom, view, this.source, 1)
  }
}

export class InlineImage extends EditablePreview {
  constructor(source, imageLength, image, resolveImage) {
    super()
    this.source = source
    this.imageLength = imageLength
    this.image = image
    this.resolveImage = resolveImage
  }
  eq(other) {
    return this.source === other.source && this.image.url === other.image.url && this.image.standalone === other.image.standalone && this.resolveImage === other.resolveImage
  }
  toDOM(view) {
    const dom = view.dom.ownerDocument.createElement('span')
    const img = view.dom.ownerDocument.createElement('img')
    dom.className = 'md-image-widget'
    const { url, alt, attrs, standalone } = this.image
    if (standalone && attrs.align) dom.dataset.align = attrs.align
    dom.title = '单击编辑图片语法；按住 Alt 单击设置尺寸'
    img.alt = alt
    img.draggable = false
    img.dataset.src = url
    if (attrs.width?.endsWith('%') && !dom.dataset.align) {
      dom.style.width = attrs.width
      img.style.width = '100%'
    } else if (attrs.width) img.style.width = attrs.width
    if (attrs.height) img.style.height = attrs.height
    const broken = () => {
      if (!mounted.has(dom)) return
      dom.classList.add('is-broken')
      dom.textContent = alt || '图片无法显示'
      view.requestMeasure()
    }
    img.addEventListener('load', () => { if (mounted.has(dom)) view.requestMeasure() }, { once: true })
    img.addEventListener('error', broken, { once: true })
    dom.append(img)
    this.bind(dom, view, this.source, 2, this.imageLength)
    Promise.resolve().then(() => this.resolveImage ? this.resolveImage(url) : /^(?:blob:|data:image\/)/i.test(url) ? url : null)
      .then(resolved => {
        if (!mounted.has(dom)) return
        if (resolved && /^(?:blob:|data:image\/)/i.test(resolved)) img.src = resolved
        else broken()
      }).catch(broken)
    return dom
  }
}

export class TaskCheckbox extends WidgetType {
  constructor(source, readOnly) { super(); this.source = source; this.readOnly = readOnly }
  eq(other) { return this.source === other.source && this.readOnly === other.readOnly }
  toDOM(view) {
    const input = view.dom.ownerDocument.createElement('input')
    input.type = 'checkbox'
    input.className = 'md-task-checkbox'
    input.checked = this.source[1].toLowerCase() === 'x'
    input.disabled = this.readOnly
    input.setAttribute('aria-label', '任务完成状态')
    input.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault() })
    input.addEventListener('change', () => {
      const range = widgetSourceRange(view, input, this.source)
      if (!range || view.state.readOnly) return
      view.dispatch({ changes: { from: range.from + 1, to: range.from + 2, insert: input.checked ? 'x' : ' ' }, userEvent: 'input.task' })
    })
    return input
  }
}

export class ListBullet extends WidgetType {
  eq() { return true }
  toDOM(view) {
    const span = view.dom.ownerDocument.createElement('span')
    span.className = 'md-list-dot'
    span.textContent = '•'
    span.setAttribute('aria-hidden', 'true')
    return span
  }
  ignoreEvent() { return false }
}
